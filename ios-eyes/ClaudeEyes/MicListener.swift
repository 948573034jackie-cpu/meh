import AVFoundation

/// Listens to the MICROPHONE only and reports a loudness value for every 20 ms.
/// It changes no volume: no voice processing, no automatic gain, and other audio keeps playing.
final class MicListener {
    /// (dBFS, time in ms). Always called on the main thread.
    var onLevel: ((Double, Double) -> Void)?
    /// Short human-readable state changes ("listening", "interrupted", ...). Main thread.
    var onState: ((String) -> Void)?

    private let engine = AVAudioEngine()
    private var meter: LevelMeter?
    private var wantRunning = false

    init() {
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.restartIfNeeded("audio device changed")
        }
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .began { self?.onState?("paused by a call or another app") }
            else { self?.restartIfNeeded("back from interruption") }
        }
    }

    /// Asks for permission if needed, then starts. completion(ok, message).
    func start(completion: @escaping (Bool, String) -> Void) {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            DispatchQueue.main.async {
                guard granted else {
                    completion(false, "Microphone is blocked. Allow it in Settings > Claude Eyes.")
                    return
                }
                do {
                    self.wantRunning = true
                    try self.startEngine()
                    completion(true, "")
                } catch {
                    self.wantRunning = false
                    completion(false, "Could not start the microphone: \(error.localizedDescription)")
                }
            }
        }
    }

    func stop() {
        wantRunning = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func restartIfNeeded(_ why: String) {
        guard wantRunning else { return }
        do {
            try startEngine()
            onState?("listening (\(why))")
        } catch {
            onState?("microphone stopped: \(error.localizedDescription)")
        }
    }

    private func startEngine() throws {
        let session = AVAudioSession.sharedInstance()
        // .mixWithOthers: videos / music keep playing at their own volume. Default mode: no voice processing or gain control.
        try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker, .allowBluetooth])
        try session.setActive(true)

        let input = engine.inputNode
        input.removeTap(onBus: 0)
        engine.stop()
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "ClaudeEyes", code: 1, userInfo: [NSLocalizedDescriptionKey: "no microphone available"])
        }
        let meter = LevelMeter(sampleRate: format.sampleRate)
        self.meter = meter
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self = self, let channel = buffer.floatChannelData?[0] else { return }
            let samples = Array(UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
            let levels = meter.process(samples)
            if levels.isEmpty { return }
            let nowMs = ProcessInfo.processInfo.systemUptime * 1000
            DispatchQueue.main.async {
                for (i, db) in levels.enumerated() {
                    // space the values 20 ms apart, the newest one at "now"
                    self.onLevel?(db, nowMs - Double(levels.count - 1 - i) * 20)
                }
            }
        }
        engine.prepare()
        try engine.start()
    }
}
