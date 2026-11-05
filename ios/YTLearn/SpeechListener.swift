import Foundation
import Speech
import AVFoundation

/// Listens to the microphone (while the app waits for "let's go", and while My tutor wants an answer: a stop's
/// window, a call, voice mode) and reports what it hears, cut into pieces at the pauses: the words of a piece so far,
/// then the closed piece as final, each piece with its own number (so "I know" does not come glued to what was heard
/// before it). On the iPhone itself when it can (private); a session that ends is started again by the page.
final class SpeechListener {
    /// no new words for this long: what was heard since the last cut is one closed piece (a command, a sentence)
    private static let pauseSeconds: TimeInterval = 0.9
    /// a recognition task older than this ends at its next pause, and the page starts a fresh one (keeps the
    /// recognizer on the iPhone light; Apple's servers stop a task after one minute anyway)
    private static let longTaskSeconds: TimeInterval = 45
    /// the sound goes back to "play" this long after the microphone was closed, unless it was opened again meanwhile
    /// (a stop and a start close together change nothing: every change can stop the video in the web view)
    private static let releaseSeconds: TimeInterval = 1.5
    /// the same after a task that ended by itself (the page starts the next one within 300 ms; if it never does,
    /// the play-and-record sound is not kept for ever)
    private static let idleReleaseSeconds: TimeInterval = 5

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private(set) var running = false
    /// the page still wants the microphone (a stop that comes while iOS asks for permission must hold)
    private var wanted = false
    /// the microphone's sensitivity: every sample is multiplied by this (1 = as it is)
    private var gain: Float = 6
    /// the end of the sound was asked for (finish): the last words come, then the end
    private var ending = false
    private var began = Date()
    private var releaseToken = 0

    // ---- one task's text, cut into pieces ----
    /// the words (segments) of the task's text, as last reported
    private var words: [String] = []
    /// how many of them were already given to the page as final
    private var cut = 0
    /// those words, in small letters (to see when the recognizer begins its text again)
    private var sent: [String] = []
    /// the words after the cut: the piece being heard now
    private var tail = ""
    /// the number of the piece being heard now (0, 1, 2 … in one task)
    private var index = 0
    private var pauseWork: DispatchWorkItem?
    /// when the recognizer last reported words (a first report after a silence may be a text begun again)
    private var lastResult = Date()

    init() {
        // iOS took the sound away or changed it (a phone call, Siri, headphones in or out): the task that was
        // listening hears nothing any more, and nothing would end it. It is ended here; the page starts a new one.
        let names: [Notification.Name] = [AVAudioSession.interruptionNotification, AVAudioSession.mediaServicesWereResetNotification, .AVAudioEngineConfigurationChange]
        for name in names {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let self = self, self.running else { return }
                // (the engine's own change right after it was started is not one)
                if note.name == .AVAudioEngineConfigurationChange {
                    guard let changed = note.object as? AVAudioEngine, changed === self.engine, Date().timeIntervalSince(self.began) > 1 else { return }
                }
                self.closePiece()
                self.cleanup()
                self.onEnd?(nil)
            }
        }
    }

    /// the words of one piece so far, whether that is the closed (final) piece, and the piece's number
    var onText: ((String, Bool, Int) -> Void)?
    /// Called when listening stopped by itself. `error` is "not-allowed" when a permission was refused.
    var onEnd: ((String?) -> Void)?

    /// `level`: the microphone's sensitivity, 1 = low (as it is), 2 = mid (× 2), 3 = high (× 4); used from the next task on
    func start(level: Int = 3) {
        wanted = true
        gain = level <= 1 ? 1 : (level == 2 ? 3 : 6)
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
        releaseToken += 1   // the microphone is open again: the sound stays as it is
        do {
            // (only when it is not so already: every change of the category can stop the video)
            if AVAudioSession.sharedInstance().category != .playAndRecord { AudioSession.set(mode: "record") }

            let req = SFSpeechAudioBufferRecognitionRequest()
            req.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition { req.requiresOnDeviceRecognition = true }
            // the words the tutor waits for: the recognizer is told to expect them (they are short and easy to miss)
            req.contextualStrings = ["I know", "I don't know", "bye bye", "bye", "hello", "stop", "play", "go on", "let's go", "hi bro", "explain", "again"]
            req.addsPunctuation = false
            request = req

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else { throw NSError(domain: "SpeechListener", code: 1, userInfo: nil) }
            let gain = self.gain
            input.removeTap(onBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
                if gain != 1 { SpeechListener.amplify(buffer, by: gain) }
                req.append(buffer)
            }
            engine.prepare()
            do {
                try engine.start()
            } catch {
                // (the sound was taken away meanwhile, a phone call: set it up again, once)
                AudioSession.set(mode: "record", force: true)
                try engine.start()
            }
            running = true
            ending = false
            began = Date()
            words = []
            sent = []
            cut = 0
            tail = ""
            index = 0

            task = recognizer.recognitionTask(with: req) { [weak self] result, error in
                DispatchQueue.main.async {
                    // (a late answer of an older task changes nothing)
                    guard let self = self, self.running, self.request === req else { return }
                    self.heard(result, error)
                }
            }
        } catch {
            cleanup()
            // (the microphone cannot be opened now, a phone call for example: the page tries again, not at once)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in self?.onEnd?("audio-capture") }
        }
    }

    /// Louder samples for the recognizer (the tutor is spoken to from a distance, over the video's sound). A quiet
    /// voice gets the whole gain; a loud one only as much as fits, so nothing is cut off (cut-off sound is
    /// understood worse than quiet sound).
    private static func amplify(_ buffer: AVAudioPCMBuffer, by gain: Float) {
        guard let channels = buffer.floatChannelData else { return }   // (not float samples: left as they are)
        let frames = Int(buffer.frameLength)
        let count = Int(buffer.format.channelCount)
        var peak: Float = 0
        for c in 0..<count {
            let samples = channels[c]
            for i in 0..<frames { let v = abs(samples[i]); if v > peak { peak = v } }
        }
        let use = peak > 0 ? max(1, min(gain, 0.95 / peak)) : gain
        if use == 1 { return }
        for c in 0..<count {
            let samples = channels[c]
            for i in 0..<frames { samples[i] *= use }
        }
    }

    // ---- what the recognizer reports: one ever-growing text per task; the page gets it in pieces ----
    private func heard(_ result: SFSpeechRecognitionResult?, _ error: Error?) {
        let last = result?.isFinal ?? false
        if let result = result {
            let before = tail
            take(result.bestTranscription.segments.map { $0.substring })
            if !last && !tail.isEmpty && tail != before {
                onText?(tail, false, index)
                waitForPause()
            }
        }
        if error != nil || last {
            closePiece()
            cleanup()
            onEnd?(nil)
        }
    }

    /// the task's words now: what comes after the cut is the piece being heard
    private func take(_ now: [String]) {
        if now.isEmpty { return }   // (nothing: what was heard so far stays)
        // words again after a silence, and no more of them than were already given: the recognizer began its text again
        let quiet = Date().timeIntervalSince(lastResult)
        lastResult = Date()
        if cut > 0 && now.count <= cut && quiet > 1 { cut = 0; sent = [] }
        let n = min(cut, now.count)
        var same = 0
        for i in 0..<n where now[i].lowercased() == sent[i] { same += 1 }
        if n > 0 && same * 2 < n {
            // other words where the closed pieces were: the recognizer began its text again (the one on the iPhone
            // does that after a silence), so all of it is new
            cut = 0
        } else if now.count < cut {
            // it made the closed pieces shorter (revised them): nothing of them is said twice
            cut = now.count
        }
        sent = now.prefix(cut).map { $0.lowercased() }
        words = now
        tail = now.dropFirst(cut).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    }

    /// the piece being heard is closed: the page gets it as final, the next words are a new piece
    private func closePiece() {
        pauseWork?.cancel()
        pauseWork = nil
        if tail.isEmpty { return }
        onText?(tail, true, index)
        index += 1
        cut = words.count
        sent = words.map { $0.lowercased() }
        tail = ""
    }

    /// no new words for a moment = the end of a piece
    private func waitForPause() {
        pauseWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.running else { return }
            self.closePiece()
            // a long task ends here, between two pieces; the page starts the next one (it still wants the microphone)
            if Date().timeIntervalSince(self.began) > SpeechListener.longTaskSeconds { self.finish() }
        }
        pauseWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + SpeechListener.pauseSeconds, execute: work)
    }

    /// Like Chrome's stop(): no more sound; what was heard comes as final, then the end.
    func finish() {
        guard running, !ending else { return }
        ending = true
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        // (no final answer within 2 s: end anyway)
        let t = task
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self = self, self.running, self.task === t else { return }
            self.closePiece()
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
        ending = false
        pauseWork?.cancel()
        pauseWork = nil
        words = []
        sent = []
        cut = 0
        tail = ""
        if engine.isRunning { engine.stop() }
        engine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
        releaseSoon()
    }

    /// The sound is NOT set back to "play" here and now: while the page wants the microphone it starts the next task
    /// within 300 ms, and a stop is often followed by a start. Only when the microphone stays closed for a while.
    private func releaseSoon() {
        releaseToken += 1
        let token = releaseToken
        let delay = wanted ? SpeechListener.idleReleaseSeconds : SpeechListener.releaseSeconds
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, self.releaseToken == token, !self.running else { return }
            if AVAudioSession.sharedInstance().category == .playAndRecord { AudioSession.set(mode: "play") }
        }
    }
}
