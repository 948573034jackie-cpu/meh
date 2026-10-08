import XCTest
@testable import ClaudeEyes

final class BroadcastCoreTests: XCTestCase {
    func tone(_ seconds: Double, amp: Double = 0.1, rate: Double = 44100) -> [Float] {
        (0..<Int(rate * seconds)).map { Float(amp * sin(2 * Double.pi * 1000 * Double($0) / rate)) }
    }
    func quiet(_ seconds: Double, rate: Double = 44100) -> [Float] {
        [Float](repeating: 0, count: Int(rate * seconds))
    }
    func feed(_ core: BroadcastCore, _ samples: [Float], rate: Double = 44100) {
        // in small pieces, like the real microphone buffers
        var i = 0
        while i < samples.count {
            let end = min(samples.count, i + 1024)
            core.feedMic(Array(samples[i..<end]), sampleRate: rate)
            i = end
        }
    }

    func testFirstWordsTakeOnePicture() {
        let core = BroadcastCore()
        var count = 0
        core.onCapture = { count += 1 }
        feed(core, quiet(1.5))
        feed(core, tone(0.4))
        XCTAssertEqual(count, 1)
    }

    func testSilenceTakesNoPicture() {
        let core = BroadcastCore()
        var count = 0
        core.onCapture = { count += 1 }
        feed(core, quiet(5))
        XCTAssertEqual(count, 0)
    }

    func testSpeechInsideTheWaitTimeTakesNoSecondPicture() {
        let core = BroadcastCore()
        var count = 0
        core.onCapture = { count += 1 }
        feed(core, quiet(1.5)); feed(core, tone(0.4))
        feed(core, quiet(3)); feed(core, tone(0.4))
        XCTAssertEqual(count, 1)
    }

    func testNextSpeechAfterTheWaitTakesAnotherPicture() {
        let core = BroadcastCore(intervalSec: 30)
        var count = 0
        core.onCapture = { count += 1 }
        feed(core, quiet(1.5)); feed(core, tone(0.4))
        feed(core, quiet(31)); feed(core, tone(0.4))
        XCTAssertEqual(count, 2)
    }

    func testAFailedPictureLetsTheNextSpeechTryAtOnce() {
        let core = BroadcastCore()
        var count = 0
        core.onCapture = { count += 1; core.forgetLastTrigger() }   // the picture failed every time
        feed(core, quiet(1.5)); feed(core, tone(0.4))
        feed(core, quiet(3)); feed(core, tone(0.4))
        XCTAssertEqual(count, 2)
    }

    func testWorksAt48kHzAndWithRateChange() {
        let core = BroadcastCore()
        var count = 0
        core.onCapture = { count += 1 }
        feed(core, quiet(1.5, rate: 48000), rate: 48000)
        feed(core, tone(0.4, rate: 48000), rate: 48000)
        XCTAssertEqual(count, 1)
        feed(core, quiet(31, rate: 16000), rate: 16000)
        feed(core, tone(0.4, rate: 16000), rate: 16000)
        XCTAssertEqual(count, 2)
    }

    func testBadInputIsIgnored() {
        let core = BroadcastCore()
        core.feedMic([], sampleRate: 44100)
        core.feedMic([0.1, 0.2], sampleRate: 0)
        XCTAssertEqual(core.captures, 0)
    }
}
