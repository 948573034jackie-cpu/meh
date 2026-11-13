import SwiftUI
import WebKit

/// The reader (wish 26): My tutor's own page ytlearn://app/dream/reader.html in its own web view, full screen.
/// Books, PDFs, texts and web articles are read there; the page keeps its small library itself (IndexedDB).
/// It is the app's own page, so it gets the same scripts and the same bridge as the settings sheet.
final class ReaderHost: NSObject, WKNavigationDelegate {
    static let address = "ytlearn://app/dream/reader.html"

    let web: WKWebView
    private let bridge = Bridge(world: .page)
    private var loading = false
    private var ready = false
    /// what waits for the page (an article sent by the browser before the page was there)
    private var waiting: [() -> Void] = []

    init(app: AppModel) {
        bridge.model = app
        web = WKWebView(frame: .zero, configuration: AppModel.makeSheetConfig(bridge: bridge))
        super.init()
        web.navigationDelegate = self
        // what another window saved (a word marked known in a video) reaches the open book at once
        app.storageListeners.append { [weak self] obj, area, from in self?.storageChanged(obj, area: area, except: from) }
    }

    /// the page is loaded once and then kept (the book stays open where it was)
    func open() {
        if loading || ready { return }
        guard let url = URL(string: ReaderHost.address) else { return }
        loading = true
        web.load(URLRequest(url: url))
    }

    /// the browser's "Reader" button: an article's text opens as a book (title = the page's title)
    func openText(title: String, text: String) {
        let run = { [weak self] in
            guard let self = self else { return }
            self.web.callAsyncJavaScript("return window.__iknowReader ? window.__iknowReader.openText(title, text) : false;",
                                         arguments: ["title": title, "text": text], in: nil, in: .page, completionHandler: nil)
        }
        if ready { run() } else { waiting.append(run); open() }
    }

    /// the reader goes away (Done): the reading aloud stops, the place is kept
    func quiet() {
        guard ready else { return }
        web.evaluateJavaScript("window.__iknowReader && window.__iknowReader.quiet && window.__iknowReader.quiet(); 0", in: nil, in: .page, completionHandler: nil)
    }

    private func storageChanged(_ obj: [String: Any], area: String, except from: WKWebView?) {
        guard ready, web !== from else { return }
        web.callAsyncJavaScript("window.__ytcStorageChanged && window.__ytcStorageChanged(obj, area)",
                                arguments: ["obj": obj, "area": area], in: nil, in: .page, completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading = false
        ready = true
        let runs = waiting
        waiting = []
        // (a moment for the page's own script to start)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { runs.forEach { $0() } }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loading = false }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loading = false }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // (iOS stopped the page to free memory: it is loaded again the next time it is shown; the library is on disk)
        ready = false
        loading = false
    }

    /// only the app's own pages are shown here; a link in a book opens nothing
    @objc(webView:decidePolicyForNavigationAction:decisionHandler:)
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let scheme = navigationAction.request.url?.scheme?.lowercased() ?? ""
        decisionHandler(scheme == SchemeHandler.scheme || scheme == "about" || scheme == "blob" ? .allow : .cancel)
    }
}

/// The reader, full screen, with one way out.
struct ReaderScreen: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Read").font(.headline)
                Spacer()
                Button { model.showReader = false } label: {
                    Text("Done").font(.system(size: 17, weight: .semibold)).frame(minWidth: 64, minHeight: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Done: back to the video")
            }
            .padding(.horizontal, 14)
            .background(Color(.secondarySystemBackground))
            WebHost(webView: model.reader.web)
        }
        .onAppear {
            model.coverOpened()
            model.reader.open()
        }
        .onDisappear {
            model.reader.quiet()
            model.coverClosed()
        }
    }
}

/// The two full-screen parts of the app that are not the video: the reader and the browser (each on its own view:
/// two covers on one view do not work on every iOS).
struct AppCovers: View {
    @ObservedObject var model: AppModel

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .fullScreenCover(isPresented: $model.showReader) { ReaderScreen(model: model) }
            .background(
                Color.clear
                    .frame(width: 0, height: 0)
                    .fullScreenCover(isPresented: $model.showBrowser) { BrowserScreen(model: model, browser: model.browser) }
            )
    }
}

extension AppModel {
    /// The reader or the browser comes in front: the video stops and the tutor on the YouTube page is quiet (its own
    /// action "hush": no "you paused" explanation); its microphone is closed, so nothing there hears "hello".
    func coverOpened() {
        let js = "(function(){var d=window.__ytcDream,done=false;try{done=!!(d&&d.action&&d.action('hush'));}catch(e){}if(!done){var v=document.querySelector('video');if(v&&!v.paused)v.pause();}})();0"
        youtube.evaluateJavaScript(js, in: nil, in: AppModel.world, completionHandler: nil)
        tutorVoice.stop()
        handle(kind: "speech", body: ["op": "stop"]) { _, _ in }
    }

    /// Back at the video: the YouTube page's listener is told that the microphone was closed (it opens it again by
    /// itself when voice mode is on).
    func coverClosed() {
        if showReader || showBrowser || coverSwitch { return }
        pageWanted()
        tutorVoice.stop()
        handle(kind: "speech", body: ["op": "stop"]) { _, _ in }
        youtube.evaluateJavaScript("window.__ytcSpeech && window.__ytcSpeech({ type: 'end' }); 0", in: nil, in: AppModel.world, completionHandler: nil)
    }

    /// "Open this link in I Know": iknow://open?url=<the address, percent-encoded> (from Shortcuts or another app).
    /// Only web addresses (http, https) are opened, in the app's browser.
    func openLink(_ link: URL) {
        guard link.scheme?.lowercased() == "iknow",
              let parts = URLComponents(url: link, resolvingAgainstBaseURL: false),
              let value = parts.queryItems?.first(where: { $0.name == "url" })?.value,
              let url = BrowserModel.address(for: value), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return }
        browser.open(url)
        if showBrowser { return }
        if showReader {
            coverSwitch = true
            showReader = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in self?.showBrowser = true; self?.coverSwitch = false }
        } else {
            showBrowser = true
        }
    }
}
