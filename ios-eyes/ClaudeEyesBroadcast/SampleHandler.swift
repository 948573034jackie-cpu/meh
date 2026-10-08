import CoreImage
import ImageIO
import CoreMedia
import ReplayKit

/// The "any app" part. iPadOS runs this while the screen broadcast is on, whatever app is in front.
/// It listens to the MICROPHONE only (the iPad's own sound is ignored), and when you start speaking it
/// makes one picture of the screen, copies it, saves it to Photos and tells you with a notification.
class SampleHandler: RPBroadcastSampleHandler {
    private let core = BroadcastCore(intervalSec: 30)
    private let frameLock = NSLock()
    private var lastFrame: CVPixelBuffer?
    private var lastOrientation = CGImagePropertyOrientation.up
    private let work = DispatchQueue(label: "claudeeyes.encode")

    override func broadcastStarted(withSetupInfo setupInfo: [String: NSObject]?) {
        core.onCapture = { [weak self] in self?.capture() }
        PictureOutput.notify("Claude Eyes is watching. When you start speaking, a picture of the screen is copied.")
    }

    override func broadcastFinished() {
        PictureOutput.notify("Claude Eyes stopped watching.")
    }

    override func processSampleBuffer(_ sampleBuffer: CMSampleBuffer, with sampleBufferType: RPSampleBufferType) {
        switch sampleBufferType {
        case .video:
            guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            var orientation = CGImagePropertyOrientation.up
            if let value = CMGetAttachment(sampleBuffer, key: RPVideoSampleOrientationKey as CFString, attachmentModeOut: nil),
               let number = value as? NSNumber,
               let o = CGImagePropertyOrientation(rawValue: number.uint32Value) {
                orientation = o
            }
            frameLock.lock()
            lastFrame = pixels
            lastOrientation = orientation
            frameLock.unlock()
        case .audioMic:
            if let audio = AudioSamples.mono(from: sampleBuffer) {
                core.feedMic(audio.samples, sampleRate: audio.rate)
            }
        default:
            break   // the iPad's own sound (.audioApp) is ignored on purpose
        }
    }

    /// Runs on the microphone thread: take the newest frame and make the picture elsewhere.
    private func capture() {
        frameLock.lock()
        let frame = lastFrame
        let orientation = lastOrientation
        frameLock.unlock()
        guard let pixels = frame else {
            core.forgetLastTrigger()
            return
        }
        work.async { [weak self] in
            guard let jpeg = FrameEncoder.jpeg(from: pixels, orientation: orientation) else {
                self?.core.forgetLastTrigger()
                PictureOutput.notify("Could not make the picture.")
                return
            }
            PictureOutput.deliver(jpeg)
        }
    }
}
