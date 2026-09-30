import SwiftUI
import UIKit

/// The brain of the app: listens for the start of your speech, takes a picture of the page pane,
/// and puts it into the chat pane. Nothing else. One picture, then it waits (30 s by default).
@MainActor
final class EyesModel: ObservableObject {
    enum Service: String, CaseIterable, Identifiable {
        case claude, chatgpt
        var id: String { rawValue }
        var title: String { self == .claude ? "Claude" : "ChatGPT" }
        var homeURL: String { self == .claude ? "https://claude.ai/new" : "https://chatgpt.com/" }
    }

    @Published var enabled = false
    @Published var listening = false
    @Published var status = "Tap ON, then speak: a picture of the page on the left goes into the chat."
    @Published var lastResult = "No picture sent yet"
    @Published var addressText = "en.wikipedia.org"
    @Published var intervalSec: Int {
        didSet {
            UserDefaults.standard.set(intervalSec, forKey: "intervalSec")
            vad.minIntervalMs = Double(intervalSec) * 1000
        }
    }
    @Published var service: Service {
        didSet {
            UserDefaults.standard.set(service.rawValue, forKey: "service")
            chat.open(service.homeURL)
        }
    }

    let page = WebController(mediaCapture: false)
    let chat = WebController(mediaCapture: true)

    private let mic = MicListener()
    private var vad = VoiceDetector()
    private var busy = false
    private(set) var attempts = 0      // pictures tried (for the self-test)
    private(set) var sent = 0          // pictures that reached the chat

    init() {
        let d = UserDefaults.standard
        let saved = d.integer(forKey: "intervalSec")
        intervalSec = saved > 0 ? saved : 30
        service = Service(rawValue: d.string(forKey: "service") ?? "") ?? .claude
        vad.minIntervalMs = Double(intervalSec) * 1000
        mic.onLevel = { [weak self] db, ts in
            Task { @MainActor in self?.handleLevel(db: db, now: ts) }
        }
        mic.onState = { [weak self] text in
            Task { @MainActor in self?.status = text }
        }
    }

    /// Called once when the screen appears.
    func boot() {
        if ProcessInfo.processInfo.arguments.contains("-selftest") {
            Task { await runSelfTest() }
            return
        }
        page.open(addressText)
        chat.open(service.homeURL)
        if UserDefaults.standard.bool(forKey: "wasEnabled") { setEnabled(true) }
    }

    func openPage() { page.open(addressText) }

    // MARK: on / off

    func setEnabled(_ on: Bool) {
        if on {
            status = "Starting the microphone…"
            mic.start { [weak self] ok, message in
                guard let self = self else { return }
                if ok {
                    self.enabled = true
                    self.listening = true
                    self.vad.reset()
                    self.vad.minIntervalMs = Double(self.intervalSec) * 1000
                    UIApplication.shared.isIdleTimerDisabled = true   // keep the screen on while listening
                    UserDefaults.standard.set(true, forKey: "wasEnabled")
                    self.status = "Listening. Speak, and a picture of the left page goes into the chat."
                } else {
                    self.enabled = false
                    self.listening = false
                    self.status = message
                }
            }
        } else {
            mic.stop()
            enabled = false
            listening = false
            UIApplication.shared.isIdleTimerDisabled = false
            UserDefaults.standard.set(false, forKey: "wasEnabled")
            status = "Stopped. Tap ON to listen again."
        }
    }

    // MARK: speech -> picture

    /// One loudness value (20 ms). `now` in milliseconds.
    func handleLevel(db: Double, now: Double) {
        guard enabled else { return }
        guard let event = vad.process(db: db, now: now) else { return }
        if event == .start {
            Task { await captureAndSend(reason: "speech") }
        }
    }

    func captureAndSend(reason: String) async {
        if busy { return }
        busy = true
        attempts += 1
        defer { busy = false }

        guard let jpeg = await page.snapshotJPEG() else {
            vad.forgetLastTrigger()
            setResult("not sent: could not take the picture")
            return
        }
        let result = await chat.attachImage(base64: jpeg.base64EncodedString())
        if result.ok {
            sent += 1
            setResult("picture attached to \(service.title) ✓ (\(jpeg.count / 1024) KB)")
        } else {
            vad.forgetLastTrigger()   // nothing was sent, so the next speech may try again at once
            setResult("not sent: " + EyesModel.explain(result.detail))
        }
    }

    nonisolated private static func explain(_ detail: String) -> String {
        switch detail {
        case "no-message-box": return "couldn't find the chat's message box (is the chat page open and signed in?)"
        case "": return "unknown problem"
        default: return detail
        }
    }

    private func setResult(_ text: String) {
        let f = DateFormatter()
        f.timeStyle = .medium
        lastResult = "\(f.string(from: Date()))  \(text)"
    }

    // MARK: self test (used by the automatic build; no microphone or internet needed)

    func runSelfTest() async {
        var checks: [[String: Any]] = []
        func check(_ name: String, _ ok: Bool, _ detail: String = "") {
            checks.append(["name": name, "ok": ok, "detail": detail])
            print("SELFTEST \(ok ? "PASS" : "FAIL")  \(name)  \(detail)")
        }
        func report(_ done: Bool) {
            let failed = checks.filter { ($0["ok"] as? Bool) != true }.count
            let json: [String: Any] = ["done": done, "passed": checks.count - failed, "failed": failed, "checks": checks]
            if let data = try? JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted]),
               let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                try? data.write(to: dir.appendingPathComponent("selftest.json"))
            }
        }

        page.loadLocal("selftest-page")
        chat.loadLocal("selftest-chat")
        await page.waitUntilLoaded()
        await chat.waitUntilLoaded()
        enabled = true
        vad.reset()
        vad.minIntervalMs = 30_000
        var t = 1000.0
        func feed(_ db: Double, _ ms: Double) {
            for _ in 0..<Int(ms / 20) { handleLevel(db: db, now: t); t += 20 }
        }
        func settle(after before: Int) async {
            for _ in 0..<150 {
                try? await Task.sleep(nanoseconds: 100_000_000)
                if attempts > before && !busy { break }
            }
            try? await Task.sleep(nanoseconds: 800_000_000)   // the chat page decodes the picture after it arrives
        }
        func attached() async -> [[String: Any]] {
            guard let s = await chat.evaluate("return JSON.stringify(window.__attached || []);") as? String,
                  let data = s.data(using: .utf8),
                  let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
            return arr
        }

        // 1. The first words after a quiet room: one picture of the page lands in the chat.
        var before = attempts
        feed(-70, 1500)
        feed(-20, 400)
        await settle(after: before)
        var list = await attached()
        check("speech -> exactly one picture in the chat", list.count == 1, "count=\(list.count)")
        if let f = list.first {
            check("it is a JPEG picture", (f["type"] as? String) == "image/jpeg" && ((f["size"] as? Int) ?? 0) > 3000, "type=\(f["type"] ?? "?") size=\(f["size"] ?? "?")")
            check("it has a real size", ((f["w"] as? Int) ?? 0) >= 300 && ((f["h"] as? Int) ?? 0) >= 300, "\(f["w"] ?? "?")x\(f["h"] ?? "?")")
            let r = (f["r"] as? Int) ?? 0, g = (f["g"] as? Int) ?? 255, b = (f["b"] as? Int) ?? 0
            check("it shows the page on the left (magenta test page)", r > 170 && g < 100 && b > 170, "rgb=\(r),\(g),\(b)")
        }
        check("the result line says it was sent", lastResult.contains("✓"), lastResult)

        // 2. More speech inside the wait time: no second picture.
        before = attempts
        feed(-70, 3000)
        feed(-20, 400)
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        list = await attached()
        check("speech during the wait time -> no extra picture", list.count == 1 && attempts == before, "count=\(list.count)")

        // 3. Switched off: nothing happens, even after the wait is over.
        enabled = false
        t += 31_000
        feed(-70, 1000)
        feed(-20, 400)
        try? await Task.sleep(nanoseconds: 1_500_000_000)
        list = await attached()
        check("switched OFF -> no picture", list.count == 1 && attempts == before, "count=\(list.count)")
        enabled = true

        // 4. After the wait: the next speech sends again.
        before = attempts
        t += 31_000
        feed(-70, 1500)
        feed(-20, 400)
        await settle(after: before)
        list = await attached()
        check("after the wait time -> the next speech sends again", list.count == 2, "count=\(list.count)")

        // 5. The chat page has no message box: reported honestly, and the next speech may retry at once.
        chat.loadLocal("selftest-chat-nobox")
        await chat.waitUntilLoaded()
        before = attempts
        t += 31_000
        feed(-70, 1500)
        feed(-20, 400)
        await settle(after: before)
        check("chat without a message box -> says it could not send", lastResult.contains("not sent") && lastResult.contains("message box"), lastResult)
        chat.loadLocal("selftest-chat")
        await chat.waitUntilLoaded()
        before = attempts
        t += 3000                         // only 3 s later, inside the wait time, but nothing was sent so it is allowed
        feed(-70, 1500)
        feed(-20, 400)
        await settle(after: before)
        list = await attached()
        check("after a failed send the next speech retries at once", list.count == 1, "count=\(list.count)")

        // 6. The "Test now" button.
        before = attempts
        await captureAndSend(reason: "test")
        try? await Task.sleep(nanoseconds: 800_000_000)
        list = await attached()
        check("test button sends a picture", list.count == 2 && attempts == before + 1, "count=\(list.count)")

        report(true)
        print("SELFTEST DONE")
    }
}
