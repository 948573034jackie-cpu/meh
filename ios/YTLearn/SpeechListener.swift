import Foundation
import Speech
import AVFoundation

/// Listens to the microphone (only while the app is waiting for "let's go") and reports what it hears.
final class SpeechListener {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private(set) var running = false

    var onText: ((String) -> Void)?
    /// Called when listening stopped by itself. `error` is "not-allowed" when a permission was refused.
    var onEnd: ((String?) -> Void)?

    func start() {
        if running { return }
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard status == .authorized else { self.onEnd?("not-allowed"); return }
                AVAudioSession.sharedInstance().requestRecordPermission { granted in
                    DispatchQueue.main.async {
                        guard granted else { self.onEnd?("not-allowed"); return }
                        self.begin()
                    }
                }
            }
        }
    }

    private func begin() {
        if running { return }
        guard let recognizer = recognizer, recognizer.isAvailable else { onEnd?("service-not-allowed"); return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .defaultToSpeaker])
            try session.setActive(true, options: [])

            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            request = req

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                req.append(buffer)
            }
            engine.prepare()
            try engine.start()
            running = true

            task = recognizer.recognitionTask(with: req) { [weak self] result, error in
                DispatchQueue.main.async {
                    guard let self = self, self.running else { return }
                    if let result = result {
                        self.onText?(result.bestTranscription.formattedString)
                    }
                    if error != nil || (result?.isFinal ?? false) {
                        self.cleanup()
                        self.onEnd?(nil)
                    }
                }
            }
        } catch {
            cleanup()
            onEnd?("audio-capture")
        }
    }

    func stop() {
        cleanup()
    }

    private func cleanup() {
        running = false
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
    }
}
