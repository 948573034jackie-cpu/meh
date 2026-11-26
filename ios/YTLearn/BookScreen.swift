import SwiftUI
import WebKit

/// I Know Book: the reading and listening app. Its one page is ytlearn://app/dream/book.html (the library, the
/// pages of the book, the tutor), in a web view over the whole screen. It is the app's own page, so it gets the same
/// scripts and the same bridge as the settings pages: the same word store, the same keys, the same voices.
final class BookHost: NSObject, WKNavigationDelegate {
    static let address = "ytlearn://app/dream/book.html"

    let web: WKWebView
    private let bridge = Bridge(world: .page)
    private var loading = false
    private(set) var ready = false
    private weak var app: AppModel?

    init(app: AppModel) {
        self.app = app
        bridge.model = app
        web = WKWebView(frame: .zero, configuration: AppModel.makeSheetConfig(bridge: bridge))
        super.init()
        web.navigationDelegate = self
        // (the page lays itself out under the clock and the home bar: env(safe-area-inset-…))
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.scrollView.isScrollEnabled = false
        web.allowsBackForwardNavigationGestures = false
        // what another window saved (a key typed in the app's own settings) reaches the page at once
        app.storageListeners.append { [weak self] obj, area, from in self?.storageChanged(obj, area: area, except: from) }
        NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.leaving() }
    }

    /// the page is loaded once and then kept (the book stays open where it was)
    func open() {
        if loading || ready { return }
        guard let url = URL(string: BookHost.address) else { return }
        loading = true
        web.load(URLRequest(url: url))
    }

    /// the app goes away: the place in the book is written now
    private func leaving() {
        guard ready else { return }
        web.evaluateJavaScript("window.__iknowBook && window.__iknowBook.save && window.__iknowBook.save(); 0", in: nil, in: .page, completionHandler: nil)
        Store.shared.flush()
    }

    private func storageChanged(_ obj: [String: Any], area: String, except from: WKWebView?) {
        guard ready, web !== from else { return }
        web.callAsyncJavaScript("window.__ytcStorageChanged && window.__ytcStorageChanged(obj, area)",
                                arguments: ["obj": obj, "area": area], in: nil, in: .page, completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading = false
        ready = true
        // (the build server starts the app with -demo: the short story opens, so its screenshot shows a page of a book)
        if ProcessInfo.processInfo.arguments.contains("-demo") { runDemo() }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loading = false }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { loading = false }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // (iOS stopped the page to free memory: it is loaded again; the book that was open opens again on its page)
        ready = false
        loading = false
        if UIApplication.shared.applicationState == .active { open() }
    }

    /// back in front after iOS stopped the page: it comes again
    func backInFront() { if !ready && !loading { open() } }

    /// only the app's own pages are shown here; a link in a book opens nothing
    @objc(webView:decidePolicyForNavigationAction:decisionHandler:)
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let scheme = navigationAction.request.url?.scheme?.lowercased() ?? ""
        decisionHandler(scheme == SchemeHandler.scheme || scheme == "about" || scheme == "blob" ? .allow : .cancel)
    }

    // ---- the build server's look at the app: the sample story opens, and what the page says about itself is written ----
    private func runDemo() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            self?.web.evaluateJavaScript("window.__iknowBook && window.__iknowBook.sample(); 0", in: nil, in: .page, completionHandler: nil)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 14) { [weak self] in
            let js = "(()=>{const f=document.getElementById('flow');const c=f?getComputedStyle(f):null;const r=document.getElementById('rd');return JSON.stringify({ready:document.body.dataset.ready||'',books:document.body.dataset.books||'',sentences:document.body.dataset.sentences||'',reading:!!(r&&!r.hidden),font:c?c.fontFamily:'',size:c?c.fontSize:'',column:c?c.columnWidth:'',window:[innerWidth,innerHeight],safeTop:getComputedStyle(document.documentElement).getPropertyValue('--top'),foot:(document.getElementById('foot-l')||{}).textContent||'',marks:document.querySelectorAll('#flow .w.hard').length,words:document.querySelectorAll('#flow .w').length})})()"
            self?.web.evaluateJavaScript(js, in: nil, in: .page) { result in
                var text = "{\"error\":\"no answer from the page\"}"
                if case .success(let value) = result, let s = value as? String { text = s }
                let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("selftest-book.json")
                try? text.write(to: url, atomically: true, encoding: .utf8)
            }
        }
    }
}

#if BOOK
/// The whole app: the book page, over the whole screen. The app's own settings (the word file, the keys) and the
/// tutor's settings pages come as sheets when the page asks for them.
struct BookRootView: View {
    @StateObject private var model = AppModel()

    var body: some View {
        WebHost(webView: model.bookHost.web)
            .ignoresSafeArea()
            .onAppear {
                model.bookHost.open()
                model.openShotScreen { model.showAppSettings = true }   // (only with -shot <name>: the build server's pictures)
            }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in model.bookHost.backInFront() }
            .sheet(isPresented: $model.showAppSettings) { SettingsView(model: model) }
            .background(EmptyView().sheet(isPresented: $model.sheetOpen) { TutorPageView(model: model) })
            .background(translatorHost)
            .overlay(alignment: .top) { toastView }
    }

    /// the free translation (Apple's Translation, iOS 18): an invisible view keeps its session open, as in I Know
    @ViewBuilder
    private var translatorHost: some View {
        #if canImport(Translation) && compiler(>=6.0)
        if #available(iOS 18.0, *) {
            if let t = model.translator as? FreeTranslator { TranslatorHost(translator: t) }
        }
        #endif
    }

    /// what the app itself has to say (the word file was shared, a key was saved)
    @ViewBuilder
    private var toastView: some View {
        if let text = model.toast {
            // (the one look's toast, the same as I Know's and the book page's)
            Text(text)
                .font(Theme.footnote)
                .foregroundColor(Theme.bg)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Space.l).padding(.vertical, Theme.Space.m - 2)
                .background(Theme.text, in: RoundedRectangle(cornerRadius: Theme.Radius.control, style: .continuous))
                .padding()
                .onTapGesture { model.toast = nil }
        }
    }
}
#endif
