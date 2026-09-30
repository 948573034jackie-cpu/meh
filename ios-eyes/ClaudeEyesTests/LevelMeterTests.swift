import XCTest
@testable import ClaudeEyes

final class LevelMeterTests: XCTestCase {
    func sine(_ hz: Double, amp: Double, rate: Double, seconds: Double) -> [Float] {
        (0..<Int(rate * seconds)).map { Float(amp * sin(2 * Double.pi * hz * Double($0) / rate)) }
    }
    func average(_ v: [Double]) -> Double { v.reduce(0, +) / Double(max(1, v.count)) }

    func testFiftyLevelsPerSecond() {
        let m = LevelMeter(sampleRate: 48000)
        XCTAssertEqual(m.process(sine(1000, amp: 0.1, rate: 48000, seconds: 1)).count, 50)
    }

    func testVoiceBandPassesAtTheRightLevel() {
        let m = LevelMeter(sampleRate: 48000)
        let levels = Array(m.process(sine(1000, amp: 0.1, rate: 48000, seconds: 1)).dropFirst(5))
        // 0.1 amplitude sine = 0.0707 RMS = -23 dBFS
        XCTAssertEqual(average(levels), -23, accuracy: 2.5)
    }

    func testLowRumbleCountsForMuchLess() {
        let voice = Array(LevelMeter(sampleRate: 48000).process(sine(1000, amp: 0.1, rate: 48000, seconds: 1)).dropFirst(5))
        let rumble = Array(LevelMeter(sampleRate: 48000).process(sine(40, amp: 0.1, rate: 48000, seconds: 1)).dropFirst(5))
        XCTAssertLessThan(average(rumble), average(voice) - 12)
    }

    func testHissAboveTheVoiceBandCountsForMuchLess() {
        let voice = Array(LevelMeter(sampleRate: 48000).process(sine(1000, amp: 0.1, rate: 48000, seconds: 1)).dropFirst(5))
        let hiss = Array(LevelMeter(sampleRate: 48000).process(sine(12000, amp: 0.1, rate: 48000, seconds: 1)).dropFirst(5))
        XCTAssertLessThan(average(hiss), average(voice) - 12)
    }

    func testSilenceIsVeryQuietAndFinite() {
        let levels = LevelMeter(sampleRate: 44100).process([Float](repeating: 0, count: 44100))
        XCTAssertTrue(levels.allSatisfy { $0.isFinite && $0 < -100 })
    }

    func testWorksAtOtherSampleRates() {
        for rate in [16000.0, 44100.0, 48000.0] {
            let l = LevelMeter(sampleRate: rate).process(sine(1000, amp: 0.1, rate: rate, seconds: 1))
            XCTAssertEqual(l.count, 50, "rate \(rate)")
        }
    }
}
