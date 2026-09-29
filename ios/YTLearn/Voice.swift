import Foundation
import AVFoundation

/// Reads the AI's answer out loud.
final class Voice: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    private(set) var isSpeaking = false
    var onChange: ((Bool) -> Void)?

    override init() {
        super.init()
        synth.delegate = self
    }

    /// Takes away the marks that sound bad when read aloud (stars, hashes, links).
    static func clean(_ text: String) -> String {
        var t = text
        t = t.replacingOccurrences(of: "\\[([^\\]]*)\\]\\([^)]*\\)", with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: "https?://\\S+", with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: "[*_#`>~]", with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: "\\n{2,}", with: "\n", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func speak(_ text: String) {
        let clean = Voice.clean(text)
        if clean.isEmpty { return }
        stop()
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
            try session.setActive(true, options: [])
        } catch { /* speak anyway */ }
        let utterance = AVSpeechUtterance(string: clean)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = 0.47   // a little slower than normal: easier to follow
        isSpeaking = true
        onChange?(true)
        synth.speak(utterance)
    }

    func stop() {
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        if isSpeaking { isSpeaking = false; onChange?(false) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        isSpeaking = false
        onChange?(false)
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        isSpeaking = false
        onChange?(false)
    }
}
