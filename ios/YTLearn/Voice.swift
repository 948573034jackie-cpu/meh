import Foundation
import AVFoundation
import WebKit

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
        // (the playback category: heard with the Ring/Silent switch on silent, and with the screen off; an open
        // microphone session, play-and-record, is left alone)
        let category = AVAudioSession.sharedInstance().category
        if category != .playback && category != .playAndRecord { AudioSession.set(mode: "play") }
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
