import Photos
import ReplayKit
import SwiftUI
import UserNotifications

/// The system's own "start screen broadcast" button, set to our broadcast part.
struct BroadcastPickerButton: UIViewRepresentable {
    static let extensionID = "local.claudeeyes.app.broadcast"

    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let view = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 64, height: 64))
        view.preferredExtension = BroadcastPickerButton.extensionID
        view.showsMicrophoneButton = true
        return view
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}

/// "Any app" mode: set-up page. Start the broadcast once, then use any app.
struct AnyAppView: View {
    @Environment(\.presentationMode) private var presentation
    @State private var message = ""

    var body: some View {
        NavigationView {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Use it in any app").font(.title2).bold()
                    Text("Start the screen broadcast once. Then, in any app, when you start speaking, a picture of the screen is copied (and saved to Photos). Paste it into Claude. It listens to the microphone only. No speech, no picture. Then it waits 30 seconds.")

                    Text("1. Allow the two things below (once)").font(.headline)
                    HStack {
                        Button("Allow notifications") {
                            UNUserNotificationCenter.current().requestAuthorization(options: [.alert]) { ok, _ in
                                DispatchQueue.main.async { message = ok ? "Notifications allowed." : "Notifications are blocked (Settings > Claude Eyes)." }
                            }
                        }
                        Spacer()
                        Button("Allow saving to Photos") {
                            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                                DispatchQueue.main.async {
                                    message = (status == .authorized || status == .limited) ? "Photos allowed." : "Photos are blocked (Settings > Claude Eyes)."
                                }
                            }
                        }
                    }
                    .buttonStyle(.bordered)

                    Text("2. Check that copying works").font(.headline)
                    Button("Copy a test picture now") {
                        guard let jpeg = AnyAppView.testPicture() else { message = "Could not make the test picture."; return }
                        PictureOutput.deliver(jpeg) { text in DispatchQueue.main.async { message = text } }
                    }
                    .buttonStyle(.borderedProminent)
                    Text("Then open Claude, press and hold in the message box, tap Paste.").font(.footnote).foregroundColor(.secondary)

                    Text("3. Start the broadcast").font(.headline)
                    HStack(spacing: 14) {
                        BroadcastPickerButton().frame(width: 64, height: 64)
                        Text("Tap the round button, choose Claude Eyes, turn the Microphone on (red), then Start Broadcast. To stop it, tap the red clock or the same button again.")
                            .font(.footnote)
                    }

                    if !message.isEmpty {
                        Text(message).padding(10).frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(UIColor.secondarySystemBackground)).cornerRadius(8)
                    }

                    Text("Good to know").font(.headline)
                    Text("• iPadOS shows a red recording mark while it is on.\n• The picture is copied to the clipboard for 15 minutes only, on this device only.\n• A few apps (for example some video apps) show a black picture.\n• You start the broadcast again after restarting the iPad.")
                        .font(.footnote)
                }
                .padding(16)
            }
            .navigationBarTitle("Any app", displayMode: .inline)
            .navigationBarItems(trailing: Button("Done") { presentation.wrappedValue.dismiss() })
        }
        .navigationViewStyle(.stack)
    }

    /// A plain picture, so the clipboard / Photos / notification can be checked without the broadcast.
    static func testPicture() -> Data? {
        let size = CGSize(width: 800, height: 500)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.systemGreen.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            let text = "Claude Eyes test picture" as NSString
            text.draw(at: CGPoint(x: 40, y: 200), withAttributes: [.font: UIFont.boldSystemFont(ofSize: 52), .foregroundColor: UIColor.white])
        }
        return image.jpegData(compressionQuality: 0.85)
    }
}
