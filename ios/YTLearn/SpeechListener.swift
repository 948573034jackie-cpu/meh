import Foundation
import Speech
import AVFoundation

/// Listens to the microphone (while the app waits for "let's go", and while My tutor wants an answer: a stop's
/// window, a call, voice mode) and reports what it hears: the words so far, then the closed sentence as final.
/// On the iPhone itself when it can (no 1-minute limit, private); a session that ends is started again by the page.
final class SpeechListener {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private(set) var running = false
    /// the page still wants the microphone (a stop that comes while iOS asks for permission must hold)
    private var wanted = false

    /// the words heard so far, and whether that is the closed (final) sentence
    var onText: ((String, Bool) -> Void)?
    /// Called when listening stopped by itself. `error` is "not-allowed" when a permission was refused.
    var onEnd: ((String?) -> Void)?

    func start() {
        wanted = true
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
        if running || !wanted { return }
        guard let recognizer = recognizer, recognizer.isAvailable else { onEnd?("service-not-allowed"); return }
        do {
            AudioSession.set(mode: "record")

            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
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
                    let final = result?.isFinal ?? false
                    if let result = result {
                        self.onText?(result.bestTranscription.formattedString, final)
                    }
                    if error != nil || final {
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

    /// Like Chrome's stop(): no more sound; what was heard comes as final, then the end.
    func finish() {
        guard running else { return }
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        // (no final answer within 2 s: end anyway)
        let t = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self, self.running, self.task === t else { return }
            self.cleanup()
            self.onEnd?(nil)
        }
    }

    func stop() {
        wanted = false
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
        AudioSession.set(mode: "play")
    }
}
