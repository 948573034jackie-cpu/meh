import CoreImage
import ImageIO
import UIKit

/// Turns one screen frame from the broadcast into a JPEG (longest side at most 1600 px).
enum FrameEncoder {
    private static let context = CIContext()

    static func jpeg(from pixelBuffer: CVPixelBuffer,
                     orientation: CGImagePropertyOrientation = .up,
                     maxEdge: CGFloat = 1600,
                     quality: CGFloat = 0.82) -> Data? {
        var image = CIImage(cvPixelBuffer: pixelBuffer).oriented(orientation)
        let longest = max(image.extent.width, image.extent.height)
        guard longest > 0 else { return nil }
        if longest > maxEdge {
            let s = maxEdge / longest
            image = image.transformed(by: CGAffineTransform(scaleX: s, y: s))
        }
        guard let cg = context.createCGImage(image, from: image.extent) else { return nil }
        return UIImage(cgImage: cg).jpegData(compressionQuality: quality)
    }
}
