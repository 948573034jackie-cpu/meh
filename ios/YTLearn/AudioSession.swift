import Foundation
import AVFoundation

/// How the app's sound works. "play": the tutor's voice plays over the video (both from this app, so mixing is fine)
/// and keeps going with the screen off (UIBackgroundModes audio). "record": the microphone is open too; the sound
/// stays on the loudspeaker (not the earpiece), or on the Bluetooth speaker, headphones or AirPlay when one is on.
enum AudioSession {
    /// Nothing is done when the sound is already in that mode: every change of the category can stop the video in
    /// the web view. `force`: set it up again anyway (after iOS took the sound away, a phone call).
    static func set(mode: String, force: Bool = false) {
        let session = AVAudioSession.sharedInstance()
        let category: AVAudioSession.Category = mode == "record" ? .playAndRecord : .playback
        if !force && session.category == category { return }
        do {
            if mode == "record" {
                // (.allowBluetoothA2DP and .allowAirPlay: the video and the tutor keep playing on a Bluetooth speaker,
                // headphones or AirPlay while the microphone listens. Not .allowBluetooth: that is the phone-call kind
                // of Bluetooth, which a speaker does not have and which makes the sound poor on headphones; the
                // iPhone's own microphone listens instead.)
                // (if this iOS refuses the set, the older one: the microphone must always open)
                do { try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP, .allowAirPlay, .mixWithOthers]) }
                catch { try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .mixWithOthers]) }
            } else {
                try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            }
            try session.setActive(true, options: [])
        } catch {
            NSLog("[audio] %@ failed: %@", mode, error.localizedDescription)
        }
    }
}
