import Foundation
import AVFoundation
import WebKit

/// iPhone / iPad: an app cannot copy a YouTube video's sound, so during a voice call the app's own voice
/// reads the paused part (~30 s of complete sentences) and plays it INTO the chat page's microphone line
/// (see mic-mix.js). Claude / ChatGPT hears it and answers by voice. Nothing goes to the speakers.
final class CallFeeder {
    private let synth = AVSpeechSynthesizer()
    weak var chat: WKWebView?

    func speak(_ text: String) {
        guard let chat = chat, !text.isEmpty else { return }
        synth.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        utterance.rate = 0.47
        synth.write(utterance) { [weak chat] buffer in
            guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else { return }
            let n = Int(pcm.frameLength)
            var data = Data(count: n * 2)
            data.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
                let out = raw.bindMemory(to: Int16.self)
                if let f = pcm.floatChannelData?[0] {
                    for i in 0..<n { out[i] = Int16(max(-1, min(1, f[i])) * 32767).littleEndian }
                } else if let s = pcm.int16ChannelData?[0] {
                    for i in 0..<n { out[i] = s[i].littleEndian }
                }
            }
            let b64 = data.base64EncodedString()
            let rate = pcm.format.sampleRate
            DispatchQueue.main.async {
                chat?.evaluateJavaScript("window.__ytcFeedPCM && window.__ytcFeedPCM('\(b64)', \(rate))", in: nil, in: .page, completionHandler: nil)
            }
        }
    }

    func stop() { synth.stopSpeaking(at: .immediate) }
}
