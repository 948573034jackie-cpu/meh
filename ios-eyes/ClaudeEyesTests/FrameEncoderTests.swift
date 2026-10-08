import CoreImage
import UIKit
import XCTest
@testable import ClaudeEyes

final class FrameEncoderTests: XCTestCase {
    /// A solid magenta frame; the left half is solid green so orientation can be told apart.
    func frame(_ w: Int, _ h: Int) -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, w, h, kCVPixelFormatType_32BGRA, nil, &buffer), kCVReturnSuccess)
        let pb = buffer!
        CVPixelBufferLockBaseAddress(pb, [])
        let base = CVPixelBufferGetBaseAddress(pb)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(pb)
        for y in 0..<h {
            for x in 0..<w {
                let p = base + y * stride + x * 4
                if x < w / 2 { p[0] = 0; p[1] = 255; p[2] = 0; p[3] = 255 }       // green
                else { p[0] = 255; p[1] = 0; p[2] = 255; p[3] = 255 }              // magenta
            }
        }
        CVPixelBufferUnlockBaseAddress(pb, [])
        return pb
    }

    func rgb(_ image: UIImage, atX fx: CGFloat, y fy: CGFloat) -> (Int, Int, Int) {
        let cg = image.cgImage!
        var px = [UInt8](repeating: 0, count: 4)
        let ctx = CGContext(data: &px, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        let x = Int(fx * CGFloat(cg.width)), y = Int(fy * CGFloat(cg.height))
        ctx.draw(cg.cropping(to: CGRect(x: x, y: y, width: 1, height: 1))!, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        return (Int(px[0]), Int(px[1]), Int(px[2]))
    }

    func testLargeFrameIsShrunkAndColoursAreRight() throws {
        let jpeg = try XCTUnwrap(FrameEncoder.jpeg(from: frame(2400, 1200)))
        let image = try XCTUnwrap(UIImage(data: jpeg))
        XCTAssertEqual(image.cgImage!.width, 1600)
        XCTAssertEqual(image.cgImage!.height, 800)
        let left = rgb(image, atX: 0.25, y: 0.5), right = rgb(image, atX: 0.75, y: 0.5)
        XCTAssertTrue(left.1 > 200 && left.0 < 60 && left.2 < 60, "left should be green: \(left)")
        XCTAssertTrue(right.0 > 200 && right.2 > 200 && right.1 < 60, "right should be magenta: \(right)")
    }

    func testSmallFrameIsNotEnlarged() throws {
        let image = try XCTUnwrap(UIImage(data: try XCTUnwrap(FrameEncoder.jpeg(from: frame(600, 400)))))
        XCTAssertEqual(image.cgImage!.width, 600)
        XCTAssertEqual(image.cgImage!.height, 400)
    }

    func testRotatedFrameSwapsWidthAndHeight() throws {
        let image = try XCTUnwrap(UIImage(data: try XCTUnwrap(FrameEncoder.jpeg(from: frame(800, 400), orientation: .right))))
        XCTAssertEqual(image.cgImage!.width, 400)
        XCTAssertEqual(image.cgImage!.height, 800)
    }
}
