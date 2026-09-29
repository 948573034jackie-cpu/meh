// ClaudeSnap — a tiny always-on-top panel for macOS 12+.
//
// When you press "Open", the app listens to the microphone. Each time you start
// speaking it: (1) screenshots the screen, (2) copies the picture, (3) switches to
// the Claude desktop app and pastes it, (4) switches back to the app you were using.

import Cocoa
import AVFoundation
import ApplicationServices

// MARK: - Settings

enum Config {
    /// Bundle id of the Claude desktop app (falls back to the app name "Claude").
    static let claudeBundleID = "com.anthropic.claudefordesktop"
    /// Press Return after pasting. Off by default: in voice mode the picture just
    /// waits in the chat box while you talk.
    static let pressReturn = UserDefaults.standard.bool(forKey: "pressReturn")
    /// Minimum seconds between two screenshots.
    static let cooldown: TimeInterval = 4
    /// Your voice must stay loud this long before we count it as speech.
    static let onsetDuration: TimeInterval = 0.25
    /// Silence needed before the next sentence can trigger again.
    static let rearmSilence: TimeInterval = 1.0
    /// Sensitivity. Bigger number = needs a louder voice.
    /// Change with:  defaults write local.claudesnap sensitivity -float 4
    static var multiplier: Float {
        let v = UserDefaults.standard.float(forKey: "sensitivity")
        return v > 0 ? v : 3.0
    }
    /// Absolute minimum loudness (RMS, 0...1) so a quiet room does not trigger.
    static let minThreshold: Float = 0.02
}

// MARK: - Voice trigger (microphone → "you started speaking")

final class VoiceTrigger {
    var onSpeech: (() -> Void)?
    var onLevel: ((Float) -> Void)?

    private let engine = AVAudioEngine()
    private var noiseFloor: Float = 0.005
    private var loudSince: Date?
    private var quietSince: Date? = Date()
    private var armed = true
    private var lastFire = Date.distantPast

    func start() throws {
        noiseFloor = 0.005
        loudSince = nil
        quietSince = Date()
        armed = true
        lastFire = Date.distantPast

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            self?.process(buffer)
        }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    // Runs on the audio thread.
    private func process(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData?[0] else { return }
        let frames = Int(buffer.frameLength)
        if frames == 0 { return }

        var sum: Float = 0
        for i in 0..<frames { sum += channel[i] * channel[i] }
        let rms = (sum / Float(frames)).squareRoot()

        let now = Date()
        let threshold = max(Config.minThreshold, noiseFloor * Config.multiplier)
        let level = min(1, rms / (threshold * 2))
        DispatchQueue.main.async { [weak self] in self?.onLevel?(level) }

        if rms < threshold {
            // Quiet: learn the room noise, and re-arm after enough silence.
            noiseFloor = noiseFloor * 0.98 + rms * 0.02
            loudSince = nil
            if quietSince == nil { quietSince = now }
            if !armed, let q = quietSince, now.timeIntervalSince(q) >= Config.rearmSilence {
                armed = true
            }
        } else {
            quietSince = nil
            if loudSince == nil { loudSince = now }
            if armed,
               let l = loudSince, now.timeIntervalSince(l) >= Config.onsetDuration,
               now.timeIntervalSince(lastFire) >= Config.cooldown {
                armed = false
                lastFire = now
                DispatchQueue.main.async { [weak self] in self?.onSpeech?() }
            }
        }
    }
}

// MARK: - Screenshot + send to Claude

enum SnapError: Error {
    case noScreenPermission
    case captureFailed
    case claudeNotRunning
    case noAccessibility
}

final class Snapper {
    /// Screenshot of the main display, without our own panel.
    func screenshot(belowWindow windowNumber: Int) throws -> NSImage {
        guard CGPreflightScreenCaptureAccess() else { throw SnapError.noScreenPermission }
        let bounds = CGDisplayBounds(CGMainDisplayID())
        guard let cg = CGWindowListCreateImage(
            bounds, .optionOnScreenBelowWindow, CGWindowID(windowNumber), [.bestResolution]
        ) else { throw SnapError.captureFailed }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }

    func copyToClipboard(_ image: NSImage) throws {
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:])
        else { throw SnapError.captureFailed }
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.declareTypes([.png, .tiff], owner: nil)
        pb.setData(png, forType: .png)
        pb.setData(tiff, forType: .tiff)
    }

    func findClaude() -> NSRunningApplication? {
        if let app = NSRunningApplication.runningApplications(withBundleIdentifier: Config.claudeBundleID).first {
            return app
        }
        return NSWorkspace.shared.runningApplications.first {
            $0.localizedName == "Claude" && $0.activationPolicy == .regular
        }
    }

    func pressKey(_ key: CGKeyCode, command: Bool) {
        let src = CGEventSource(stateID: .hidSystemState)
        let down = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: true)
        let up = CGEvent(keyboardEventSource: src, virtualKey: key, keyDown: false)
        if command {
            down?.flags = .maskCommand
            up?.flags = .maskCommand
        }
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }

    /// Full flow. `done` is called on the main thread when we are back on the original app.
    func run(panelWindowNumber: Int, done: @escaping (Result<Void, SnapError>) -> Void) {
        let previous = NSWorkspace.shared.frontmostApplication
        let me = ProcessInfo.processInfo.processIdentifier

        do {
            guard AXIsProcessTrusted() else { throw SnapError.noAccessibility }
            let image = try screenshot(belowWindow: panelWindowNumber)
            try copyToClipboard(image)
            guard let claude = findClaude() else { throw SnapError.claudeNotRunning }

            claude.activate(options: [.activateIgnoringOtherApps])

            // Give Claude time to come to the front, then paste.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [self] in
                pressKey(9, command: true)                 // Cmd+V
                if Config.pressReturn {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [self] in
                        pressKey(36, command: false)       // Return
                    }
                }
                let wait = Config.pressReturn ? 1.2 : 0.7
                DispatchQueue.main.asyncAfter(deadline: .now() + wait) {
                    // Go back to what you were reading or studying.
                    if let prev = previous, prev.processIdentifier != me,
                       prev.processIdentifier != claude.processIdentifier {
                        prev.activate(options: [.activateIgnoringOtherApps])
                    }
                    done(.success(()))
                }
            }
        } catch let e as SnapError {
            done(.failure(e))
        } catch {
            done(.failure(.captureFailed))
        }
    }
}

// MARK: - The small window

final class Panel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private let panel = Panel(
        contentRect: NSRect(x: 0, y: 0, width: 190, height: 98),
        styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered, defer: false
    )
    private let status = NSTextField(labelWithString: "Off")
    private let meter = NSProgressIndicator()
    private let openButton = NSButton(title: "Open", target: nil, action: nil)
    private let quitButton = NSButton(title: "Quit", target: nil, action: nil)

    private let trigger = VoiceTrigger()
    private let snapper = Snapper()
    private var listening = false
    private var busy = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildPanel()
        trigger.onLevel = { [weak self] level in
            guard let self = self, self.listening else { return }
            self.meter.doubleValue = Double(level)
        }
        trigger.onSpeech = { [weak self] in self?.handleSpeech() }
    }

    // UI

    private func buildPanel() {
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let bg = NSVisualEffectView(frame: panel.contentRect(forFrameRect: panel.frame))
        bg.material = .hudWindow
        bg.blendingMode = .behindWindow
        bg.state = .active
        bg.wantsLayer = true
        bg.layer?.cornerRadius = 12
        bg.layer?.masksToBounds = true
        panel.contentView = bg

        status.frame = NSRect(x: 12, y: 72, width: 166, height: 18)
        status.font = .systemFont(ofSize: 12, weight: .medium)
        bg.addSubview(status)

        meter.frame = NSRect(x: 12, y: 58, width: 166, height: 8)
        meter.style = .bar
        meter.isIndeterminate = false
        meter.minValue = 0
        meter.maxValue = 1
        meter.doubleValue = 0
        bg.addSubview(meter)

        openButton.frame = NSRect(x: 12, y: 14, width: 80, height: 30)
        openButton.bezelStyle = .rounded
        openButton.target = self
        openButton.action = #selector(toggle)
        bg.addSubview(openButton)

        quitButton.frame = NSRect(x: 98, y: 14, width: 80, height: 30)
        quitButton.bezelStyle = .rounded
        quitButton.target = self
        quitButton.action = #selector(quit)
        bg.addSubview(quitButton)

        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: f.maxX - panel.frame.width - 12,
                                         y: f.maxY - panel.frame.height - 12))
        }
        panel.orderFrontRegardless()
    }

    private func setStatus(_ text: String, color: NSColor = .labelColor) {
        status.stringValue = text
        status.textColor = color
    }

    // Actions

    @objc private func quit() {
        trigger.stop()
        NSApp.terminate(nil)
    }

    @objc private func toggle() {
        listening ? stopListening() : startListening()
    }

    private func startListening() {
        // Ask for every permission up front, so nothing pops up in the middle of a sentence.
        if !CGPreflightScreenCaptureAccess() {
            CGRequestScreenCaptureAccess()
            setStatus("Allow Screen Recording", color: .systemOrange)
            return
        }
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        if !AXIsProcessTrustedWithOptions(opts) {
            setStatus("Allow Accessibility", color: .systemOrange)
            return
        }
        AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard granted else {
                    self.setStatus("Allow Microphone", color: .systemOrange)
                    return
                }
                do {
                    try self.trigger.start()
                    self.listening = true
                    self.openButton.title = "Stop"
                    self.setStatus("● Listening", color: .systemGreen)
                } catch {
                    self.setStatus("Mic error", color: .systemRed)
                }
            }
        }
    }

    private func stopListening() {
        trigger.stop()
        listening = false
        openButton.title = "Open"
        meter.doubleValue = 0
        setStatus("Off")
    }

    private func handleSpeech() {
        guard listening, !busy else { return }
        busy = true
        setStatus("📸 Sending…", color: .systemBlue)
        snapper.run(panelWindowNumber: panel.windowNumber) { [weak self] result in
            guard let self = self else { return }
            self.busy = false
            switch result {
            case .success:
                self.setStatus("✓ Sent", color: .systemGreen)
            case .failure(.noScreenPermission):
                self.setStatus("Need Screen Recording", color: .systemOrange)
            case .failure(.noAccessibility):
                self.setStatus("Need Accessibility", color: .systemOrange)
            case .failure(.claudeNotRunning):
                self.setStatus("Open Claude app first", color: .systemOrange)
            case .failure(.captureFailed):
                self.setStatus("Screenshot failed", color: .systemRed)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                if self.listening && !self.busy { self.setStatus("● Listening", color: .systemGreen) }
            }
        }
    }
}

// MARK: - Start

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
