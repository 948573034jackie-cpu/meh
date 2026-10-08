import Foundation

/// The decision logic of the "any app" mode, with no iOS parts in it so it can be tested:
/// microphone samples go in; when you START speaking (and the wait time is over) `onCapture` is called once.
/// Time is counted in audio (20 ms per loudness value), so it does not depend on any clock.
final class BroadcastCore {
    /// Called when a picture should be taken now. Runs on the thread that feeds the microphone.
    var onCapture: (() -> Void)?

    private let lock = NSRecursiveLock()
    private var detector = VoiceDetector()
    private var meter: LevelMeter?
    private var meterRate = 0.0
    private var clockMs = 0.0
    private(set) var captures = 0

    init(intervalSec: Double = 30) {
        detector.minIntervalMs = intervalSec * 1000
    }

    func feedMic(_ samples: [Float], sampleRate: Double) {
        guard sampleRate > 0, !samples.isEmpty else { return }
        lock.lock()
        defer { lock.unlock() }
        if meter == nil || meterRate != sampleRate {
            meter = LevelMeter(sampleRate: sampleRate)
            meterRate = sampleRate
        }
        guard let levels = meter?.process(samples) else { return }
        for db in levels {
            clockMs += detector.frameMs
            if detector.process(db: db, now: clockMs) == .start {
                captures += 1
                onCapture?()
            }
        }
    }

    /// The picture could not be made: let the next speech try again at once.
    func forgetLastTrigger() {
        lock.lock()
        detector.forgetLastTrigger()
        lock.unlock()
    }
}
