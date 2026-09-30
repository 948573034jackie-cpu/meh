import XCTest
@testable import ClaudeEyes

final class VadTests: XCTestCase {
    let quiet = -70.0
    let speech = -25.0

    /// Feeds [(dB, milliseconds)] segments in 20 ms frames; returns (events with their time).
    func run(_ segments: [(Double, Double)], minInterval: Double = 30_000, sensitivity: VoiceDetector.Sensitivity = .normal) -> [(VoiceDetector.Event, Double)] {
        var vad = VoiceDetector()
        vad.minIntervalMs = minInterval
        vad.sensitivity = sensitivity
        var t = 1000.0
        var events: [(VoiceDetector.Event, Double)] = []
        for (db, ms) in segments {
            for _ in 0..<Int(ms / 20) {
                if let e = vad.process(db: db, now: t) { events.append((e, t)) }
                t += 20
            }
        }
        return events
    }
    func starts(_ e: [(VoiceDetector.Event, Double)]) -> [Double] { e.filter { $0.0 == .start }.map { $0.1 } }

    func testSilenceNeverTriggers() {
        XCTAssertEqual(starts(run([(quiet, 10_000)])).count, 0)
    }

    func testSpeechTriggersOnceAtTheFirstWord() {
        let s = starts(run([(quiet, 2000), (speech, 3000), (quiet, 2000)]))
        XCTAssertEqual(s.count, 1)
        XCTAssertLessThanOrEqual(s[0] - 3000, 80)   // speech began at t = 3000 ms
        XCTAssertGreaterThanOrEqual(s[0] - 3000, 0)
    }

    func testFiresLongBeforeTheSentenceIsOver() {
        let s = starts(run([(quiet, 2000), (speech, 5000)]))
        XCTAssertEqual(s.count, 1)
        XCTAssertLessThan(s[0], 3200)
    }

    func testAShortPauseInsideASentenceDoesNotRetrigger() {
        let s = starts(run([(quiet, 2000), (speech, 1000), (quiet, 500), (speech, 1000), (quiet, 2000)], minInterval: 1000))
        XCTAssertEqual(s.count, 1)
    }

    func testWaitTimeBlocksTheNextPictureThenAllowsIt() {
        // sentences 5 s apart inside a 30 s wait: only the first counts
        var seg: [(Double, Double)] = [(quiet, 2000)]
        for _ in 0..<4 { seg.append((speech, 1000)); seg.append((quiet, 4000)) }
        let e = run(seg)
        XCTAssertEqual(starts(e).count, 1)
        XCTAssertEqual(e.filter { $0.0 == .suppressed }.count, 3)
        // after the wait is over the next sentence counts again
        let later = starts(run([(quiet, 2000), (speech, 1000), (quiet, 31_000), (speech, 1000), (quiet, 2000)]))
        XCTAssertEqual(later.count, 2)
        XCTAssertGreaterThanOrEqual(later[1] - later[0], 30_000)
    }

    func testNoSpeechNoPicturesOverManyMinutes() {
        XCTAssertEqual(starts(run([(quiet, 300_000)])).count, 0)
    }

    func testAClickOrPopIsIgnored() {
        XCTAssertEqual(starts(run([(quiet, 2000), (speech, 40), (quiet, 2000)])).count, 0)
    }

    func testStartUpPopIsIgnored() {
        XCTAssertEqual(starts(run([(speech, 300), (quiet, 3000)])).count, 0)
    }

    func testSteadyBackgroundNoiseAdaptsAndSpeechStillWorks() {
        XCTAssertLessThanOrEqual(starts(run([(quiet, 2000), (-55, 60_000)])).count, 1)
        XCTAssertGreaterThanOrEqual(starts(run([(quiet, 2000), (-55, 60_000), (-25, 1500), (-55, 2000)])).count, 1)
    }

    func testNeverEndingLoudSoundIsTreatedAsNoise() {
        let e = run([(quiet, 2000), (-30, 60_000)])
        XCTAssertEqual(starts(e).count, 1)
        XCTAssertTrue(e.contains { $0.0 == .end("noise") })
    }

    func testSensitivityChangesWhatCountsAsSpeech() {
        let soft = -45.0
        XCTAssertEqual(starts(run([(quiet, 2000), (soft, 1000), (quiet, 2000)], sensitivity: .low)).count, 0)
        XCTAssertEqual(starts(run([(quiet, 2000), (soft, 1000), (quiet, 2000)], sensitivity: .high)).count, 1)
    }

    func testBadNumbersDoNotBreakIt() {
        var vad = VoiceDetector()
        for i in 0..<100 { _ = vad.process(db: i % 2 == 0 ? Double.nan : -Double.infinity, now: 1000 + Double(i) * 20) }
        XCTAssertTrue(vad.floorDb.isFinite)
    }

    func testForgetLastTriggerLetsTheNextSpeechThrough() {
        var vad = VoiceDetector()
        var t = 1000.0
        func feed(_ db: Double, _ ms: Double) -> [VoiceDetector.Event] {
            var out: [VoiceDetector.Event] = []
            for _ in 0..<Int(ms / 20) { if let e = vad.process(db: db, now: t) { out.append(e) }; t += 20 }
            return out
        }
        _ = feed(-70, 2000)
        XCTAssertTrue(feed(-25, 1000).contains(.start))
        _ = feed(-70, 3000)
        XCTAssertTrue(feed(-25, 1000).contains(.suppressed))   // too soon
        vad.forgetLastTrigger()                                 // the picture was never sent
        _ = feed(-70, 3000)
        XCTAssertTrue(feed(-25, 1000).contains(.start))        // allowed again at once
    }
}
