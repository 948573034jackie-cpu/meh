import SwiftUI
import WebKit

/// One browser pane. The app has two: the page you are reading, and the Claude / ChatGPT chat.
@MainActor
final class WebController: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    @Published var title = ""
    @Published var isLoading = false
    @Published var currentURL = ""

    private var attachSource: String = {
        guard let url = Bundle.main.url(forResource: "attach", withExtension: "js"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return "" }
        return text
    }()

    init(mediaCapture: Bool) {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.applicationNameForUserAgent = "Safari/604.1"   // look like Safari, not an embedded view
        let view = WKWebView(frame: .zero, configuration: config)
        view.allowsBackForwardNavigationGestures = true
        self.webView = view
        self.mediaCapture = mediaCapture
        super.init()
        view.navigationDelegate = self
        view.uiDelegate = self
    }

    private let mediaCapture: Bool

    // MARK: loading

    /// Accepts "example.com", "https://example.com" or a search phrase.
    func open(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        if let url = WebController.url(from: t) { webView.load(URLRequest(url: url)) }
    }

    static func url(from text: String) -> URL? {
        if text.contains(" ") || !text.contains(".") {
            var c = URLComponents(string: "https://www.google.com/search")
            c?.queryItems = [URLQueryItem(name: "q", value: text)]
            return c?.url
        }
        if text.hasPrefix("http://") || text.hasPrefix("https://") { return URL(string: text) }
        return URL(string: "https://" + text)
    }

    func loadLocal(_ name: String) {
        guard let url = Bundle.main.url(forResource: name, withExtension: "html") else { return }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func waitUntilLoaded(timeout: TimeInterval = 15) async {
        let end = Date().addingTimeInterval(timeout)
        try? await Task.sleep(nanoseconds: 300_000_000)
        while webView.isLoading && Date() < end {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        try? await Task.sleep(nanoseconds: 700_000_000)   // let it paint before any snapshot
    }

    // MARK: the two jobs the app needs

    /// A JPEG picture of what this pane shows right now, at most `maxEdge` pixels on its long side.
    func snapshotJPEG(maxEdge: CGFloat = 1600, quality: CGFloat = 0.82) async -> Data? {
        await withCheckedContinuation { (cont: CheckedContinuation<Data?, Never>) in
            webView.takeSnapshot(with: WKSnapshotConfiguration()) { image, _ in
                guard let image = image else { cont.resume(returning: nil); return }
                cont.resume(returning: WebController.resized(image, maxEdge: maxEdge).jpegData(compressionQuality: quality))
            }
        }
    }

    nonisolated private static func resized(_ image: UIImage, maxEdge: CGFloat) -> UIImage {
        let longSide = max(image.size.width, image.size.height) * image.scale
        guard longSide > maxEdge else { return image }
        let k = maxEdge / longSide
        let size = CGSize(width: image.size.width * image.scale * k, height: image.size.height * image.scale * k)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    /// Puts the picture into this chat page's message box, like attaching a file. Does not send anything.
    func attachImage(base64: String) async -> (ok: Bool, detail: String) {
        guard !attachSource.isEmpty else { return (false, "attach script missing") }
        do {
            let body = attachSource + "\nreturn claudeEyesAttach(b64, mime, name);"
            let result = try await webView.callAsyncJavaScript(
                body,
                arguments: ["b64": base64, "mime": "image/jpeg", "name": "screenshot.jpg"],
                in: nil,
                contentWorld: .page)
            if let d = result as? [String: Any] {
                let ok = (d["ok"] as? Bool) ?? false
                let detail = (d["method"] as? String) ?? (d["error"] as? String) ?? ""
                return (ok, detail)
            }
            return (false, "no answer from the page")
        } catch {
            return (false, error.localizedDescription)
        }
    }

    func evaluate(_ script: String) async -> Any? {
        do { return try await webView.callAsyncJavaScript(script, arguments: [:], in: nil, contentWorld: .page) }
        catch { return nil }
    }

    // MARK: delegates

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { isLoading = true }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        isLoading = false
        title = webView.title ?? ""
        currentURL = webView.url?.absoluteString ?? ""
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { isLoading = false }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { isLoading = false }

    // Links that want a new window open in the same pane.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
        return nil
    }

    // The chat pane may use the microphone itself (e.g. the chat site's own dictation / voice).
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(mediaCapture ? .grant : .deny)
    }
}

struct WebPane: UIViewRepresentable {
    let controller: WebController
    func makeUIView(context: Context) -> WKWebView { controller.webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
