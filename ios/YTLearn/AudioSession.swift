import Foundation
import AVFoundation

/// How the app's sound works. "play": the tutor's voice plays over the video (both from this app, so mixing is fine)
/// and keeps going with the screen off (UIBackgroundModes audio). "record": the microphone is open too; the sound
/// stays on the loudspeaker (not the earpiece).
enum AudioSession {
    static func set(mode: String) {
        let session = AVAudioSession.sharedInstance()
        do {
            if mode == "record" {
                try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .mixWithOthers])
            } else {
                try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            }
            try session.setActive(true, options: [])
        } catch {
            NSLog("[audio] %@ failed: %@", mode, error.localizedDescription)
        }
    }
}
