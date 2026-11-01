import Foundation
import AVFoundation
import WebKit

/// Reads the AI's answer out loud.
final class Voice: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    private(set) var isSpeaking = false
    private var current: AVSpeechUtterance?
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
        current = utterance
        isSpeaking = true
        onChange?(true)
        synth.speak(utterance)
    }

    func stop() {
        current = nil                      // late "cancelled" messages of the old sentence must not count
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        if isSpeaking { isSpeaking = false; onChange?(false) }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) { ended(utterance) }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) { ended(utterance) }

    private func ended(_ utterance: AVSpeechUtterance) {
        guard utterance === current else { return }   // an old sentence ended; the new one is still going
        current = nil
        isSpeaking = false
        onChange?(false)
    }
}

/// My tutor's iOS voice: the Web Speech interface in shim-dream.js (speechSynthesis) is this AVSpeechSynthesizer.
/// One sentence at a time; its start / each word / end go back to the page that asked (window.__ytcTts).
/// Better voices: iOS Settings → Accessibility → Spoken Content → Voices → English → a Premium or Enhanced voice.
final class TutorVoice: NSObject, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    private struct Asker { let id: Int; weak var web: WKWebView?; let world: WKContentWorld }
    private var askers: [ObjectIdentifier: Asker] = [:]

    override init() {
        super.init()
        synth.delegate = self
    }

    /// English and Chinese voices; Premium / Enhanced in the name (the tutor picks those first)
    static func voices() -> [[String: Any]] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("en") || $0.language.hasPrefix("zh") }
            .map { v -> [String: Any] in
                var name = v.name
                if v.quality == .premium && !name.contains("Premium") { name += " (Premium)" }
                else if v.quality == .enhanced && !name.contains("Enhanced") { name += " (Enhanced)" }
                return ["id": v.identifier, "name": name, "lang": v.language]
            }
    }

    func speak(_ body: [String: Any], web: WKWebView?, world: WKContentWorld) {
        let id = (body["id"] as? NSNumber)?.intValue ?? 0
        let text = body["text"] as? String ?? ""
        let lang = (body["lang"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "en-GB"
        let u = AVSpeechUtterance(string: text)
        u.voice = (body["voice"] as? String).flatMap { AVSpeechSynthesisVoice(identifier: $0) } ?? AVSpeechSynthesisVoice(language: lang)
        let rate = Float((body["rate"] as? NSNumber)?.doubleValue ?? 1) * AVSpeechUtteranceDefaultSpeechRate
        u.rate = min(AVSpeechUtteranceMaximumSpeechRate, max(AVSpeechUtteranceMinimumSpeechRate, rate))
        u.pitchMultiplier = Float(min(2, max(0.5, (body["pitch"] as? NSNumber)?.doubleValue ?? 1)))
        u.volume = Float(min(1, max(0, (body["volume"] as? NSNumber)?.doubleValue ?? 1)))
        askers[ObjectIdentifier(u)] = Asker(id: id, web: web, world: world)
        synth.speak(u)
    }

    func stop() { synth.stopSpeaking(at: .immediate) }
    func pause() { synth.pauseSpeaking(at: .immediate) }
    func resume() { synth.continueSpeaking() }

    private func send(_ u: AVSpeechUtterance, _ event: String, range: NSRange? = nil, done: Bool = false) {
        let key = ObjectIdentifier(u)
        guard let a = askers[key] else { return }
        if done { askers.removeValue(forKey: key) }
        var ev: [String: Any] = ["id": a.id, "event": event]
        if let r = range { ev["charIndex"] = r.location; ev["charLength"] = r.length }
        a.web?.callAsyncJavaScript("window.__ytcTts && window.__ytcTts(ev)", arguments: ["ev": ev], in: nil, in: a.world, completionHandler: nil)
    }

    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) { send(u, "start") }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, willSpeakRangeOfSpeechString r: NSRange, utterance u: AVSpeechUtterance) { send(u, "word", range: r) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { send(u, "end", done: true) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { send(u, "cancel", done: true) }
}
