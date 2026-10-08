import Photos
import UIKit
import UserNotifications

/// Where a picture goes in "any app" mode: onto the clipboard (paste it into Claude),
/// into Photos (attach it from there), and a notification that says what happened.
enum PictureOutput {
    static func summary(copied: Bool, saved: Bool) -> String {
        switch (copied, saved) {
        case (true, true): return "Picture copied (paste it into Claude) and saved to Photos."
        case (true, false): return "Picture copied (paste it into Claude). Not saved to Photos: allow Photos in the Claude Eyes app."
        case (false, true): return "Picture saved to Photos. Attach it in Claude from Photos."
        case (false, false): return "Could not copy or save the picture."
        }
    }

    /// Copies, saves and notifies. `completion` is called exactly once with the sentence that was shown.
    static func deliver(_ jpeg: Data, completion: ((String) -> Void)? = nil) {
        // Local only (not shared to your other devices) and it disappears from the clipboard after 15 minutes.
        UIPasteboard.general.setItems([["public.jpeg": jpeg]],
                                      options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(900)])
        let copied = UIPasteboard.general.hasImages

        let finish: (Bool) -> Void = { saved in
            let text = summary(copied: copied, saved: saved)
            notify(text)
            completion?(text)
        }
        let status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        guard status == .authorized || status == .limited else { finish(false); return }
        PHPhotoLibrary.shared().performChanges({
            PHAssetCreationRequest.forAsset().addResource(with: .photo, data: jpeg, options: nil)
        }, completionHandler: { ok, _ in finish(ok) })
    }

    static func notify(_ text: String) {
        let content = UNMutableNotificationContent()
        content.title = "Claude Eyes"
        content.body = text
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request, withCompletionHandler: nil)
    }
}
