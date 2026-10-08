import UIKit
import XCTest
@testable import ClaudeEyes

final class PictureOutputTests: XCTestCase {
    func testSentencesSayWhatHappened() {
        XCTAssertTrue(PictureOutput.summary(copied: true, saved: true).contains("copied"))
        XCTAssertTrue(PictureOutput.summary(copied: true, saved: true).contains("Photos"))
        XCTAssertTrue(PictureOutput.summary(copied: true, saved: false).contains("Not saved"))
        XCTAssertTrue(PictureOutput.summary(copied: false, saved: true).contains("saved to Photos"))
        XCTAssertTrue(PictureOutput.summary(copied: false, saved: false).contains("Could not"))
    }

    func testPictureLandsOnTheClipboardAndCompletionIsCalledOnce() throws {
        let jpeg = try XCTUnwrap(AnyAppView.testPicture())
        UIPasteboard.general.items = []
        let done = expectation(description: "completion")
        var calls = 0
        PictureOutput.deliver(jpeg) { text in
            calls += 1
            XCTAssertFalse(text.isEmpty)
            done.fulfill()
        }
        wait(for: [done], timeout: 15)
        XCTAssertEqual(calls, 1)
        XCTAssertTrue(UIPasteboard.general.hasImages)
    }

    func testTestPictureIsARealJPEG() throws {
        let jpeg = try XCTUnwrap(AnyAppView.testPicture())
        XCTAssertGreaterThan(jpeg.count, 3000)
        XCTAssertEqual(UIImage(data: jpeg)?.size.width, 800)
    }
}
