import SwiftUI
import WebKit

/// Puts an existing WKWebView into SwiftUI. The web view is created once (by AppModel) and only moved
/// around, so pages and logins survive layout changes.
struct WebHost: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = .black
        attach(webView, to: container)
        return container
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        if webView.superview !== uiView {
            attach(webView, to: uiView)
        }
    }

    private func attach(_ web: WKWebView, to container: UIView) {
        web.removeFromSuperview()
        web.frame = container.bounds
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(web)
    }
}
