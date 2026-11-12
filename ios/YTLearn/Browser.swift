import SwiftUI
import WebKit
import AVFoundation

/// The browser inside the app (wish 29): any website, with the tutor on it when Explanation mode is on.
///
/// SAFETY. A web page is somebody else's code. So:
///  - the tutor's script (dream-web.js) is put ONLY into a private script world (`BrowserModel.world`), never into the
///    page's own world, and only into the main frame; with Explanation mode off NO script is put into pages at all;
///  - the bridge (`BrowserBridge`) is registered ONLY for that world, answers only the main frame, and answers only
///    what that script needs: it cannot save keys, open the app's pages or touch the vocabulary file, it gets the AI
///    and voice keys but not the GitHub token, only a few keys of the storage, and its requests go only to the AI and
///    voice services;
///  - websites get no camera, no microphone and no motion sensors; other apps are opened only after a question.
/// There is no private mode: cookies and logins are kept like in any browser (the same store as the YouTube window).
/// The app cannot be the DEFAULT browser of the iPhone: that needs a permission only Apple gives.

/// a page: a bookmark, a history line, a saved tab
struct BrowserPage: Identifiable, Equatable {
    let id = UUID()
    var url: String
    var title: String
    var at: Double = 0

    static func == (a: BrowserPage, b: BrowserPage) -> Bool { a.url == b.url && a.title == b.title && a.at == b.at }
    var dict: [String: Any] { ["url": url, "title": title, "at": at] }
    init(url: String, title: String, at: Double = 0) { self.url = url; self.title = title; self.at = at }
    init?(_ any: Any?) {
        guard let d = any as? [String: Any], let url = d["url"] as? String, !url.isEmpty else { return nil }
        self.url = url
        self.title = d["title"] as? String ?? ""
        self.at = (d["at"] as? NSNumber)?.doubleValue ?? 0
    }
    /// what is shown: the title, else the address without https://
    var name: String { title.isEmpty ? BrowserModel.short(url) : title }
}

/// A question of a page (alert, confirm, prompt) or of the app ("open another app?"). Its answer is always given
/// exactly once, also when nobody answers (WebKit needs that).
final class BrowserAsk: Identifiable {
    enum Kind { case alert, confirm, prompt, openApp }
    let id = UUID()
    let kind: Kind
    let title: String
    let message: String
    let preset: String
    private var done: ((Bool, String?) -> Void)?

    init(kind: Kind, title: String, message: String, preset: String = "", done: @escaping (Bool, String?) -> Void) {
        self.kind = kind; self.title = title; self.message = message; self.preset = preset; self.done = done
    }
    func answer(_ ok: Bool, _ text: String? = nil) {
        let d = done
        done = nil
        d?(ok, text)
    }
    deinit { done?(false, nil) }
}

/// One tab: its web view and what the bars show of it.
final class BrowserTab: NSObject, ObservableObject, Identifiable {
    let id = UUID()
    let web: WKWebView
    @Published var title = ""
    @Published var address = ""
    @Published var progress: Double = 0
    @Published var loading = false
    @Published var canGoBack = false
    @Published var canGoForward = false
    /// the page could not be loaded: the words to show, and what Reload loads
    @Published var problem: String?
    var failedURL: URL?
    /// a tab from last time that was not loaded yet (it loads when it is shown)
    var waitingURL: URL?
    private var watches: [NSKeyValueObservation] = []

    init(web: WKWebView) {
        self.web = web
        super.init()
        // (the values are read on the main thread, a moment after WebKit says they changed)
        let later: (@escaping (BrowserTab) -> Void) -> Void = { [weak self] change in
            DispatchQueue.main.async { if let self = self { change(self) } }
        }
        watches = [
            web.observe(\.title, options: [.new]) { _, _ in later { $0.title = $0.web.title ?? "" } },
            web.observe(\.url, options: [.new]) { _, _ in later { let v = $0.web.url?.absoluteString ?? ""; if !v.isEmpty && v != "about:blank" { $0.address = v } } },
            web.observe(\.estimatedProgress, options: [.new]) { _, _ in later { $0.progress = $0.web.estimatedProgress } },
            web.observe(\.isLoading, options: [.new]) { _, _ in later { $0.loading = $0.web.isLoading } },
            web.observe(\.canGoBack, options: [.new]) { _, _ in later { $0.canGoBack = $0.web.canGoBack } },
            web.observe(\.canGoForward, options: [.new]) { _, _ in later { $0.canGoForward = $0.web.canGoForward } },
        ]
    }

    /// nothing was opened in it yet (the start page with "Paste link" shows)
    var isEmpty: Bool { address.isEmpty && waitingURL == nil && !loading }
    var name: String { title.isEmpty ? (address.isEmpty ? "New tab" : BrowserModel.short(address)) : title }
}

final class BrowserModel: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate {
    /// the tutor's private script world in web pages (not the page's own world, and not the YouTube window's)
    static let world = WKContentWorld.world(name: "iknowWeb")
    /// the tutor's scripts for a web page, in this order (tests/ios-browser-test.js reads this list)
    static let webScripts = ["shim-common", "shim-dream", "dream-web"]
    /// words typed into the address bar are searched with DuckDuckGo
    static let searchPrefix = "https://duckduckgo.com/?q="
    static let maxTabs = 12

    @Published var tabs: [BrowserTab] = []
    @Published var currentID: UUID?
    /// Explanation mode: on = a tap on a word explains it; off = a normal browser (no script in the pages)
    @Published var explainOn = false
    /// the tutor is thinking or talking on the page in front (the Explain button is "Stop" then)
    @Published var speaking = false
    @Published var bookmarks: [BrowserPage] = []
    @Published var history: [BrowserPage] = []
    @Published var ask: BrowserAsk?
    /// a short message under the address bar (downloads, the microphone)
    @Published var note: String?

    private weak var app: AppModel?
    private let content = WKUserContentController()
    private let config = WKWebViewConfiguration()
    private let bridge = BrowserBridge()
    private var shown = false
    private var listening = false
    private var micRefused = false
    private var listenStart = Date.distantPast
    /// the tutor's cloud voice on web pages is played by the app itself (a website's own rules cannot silence it)
    fileprivate let audio = PageAudio()

    var current: BrowserTab? { tabs.first { $0.id == currentID } ?? tabs.first }

    init(app: AppModel) {
        self.app = app
        super.init()
        bridge.browser = self
        bridge.inner.model = app
        config.userContentController = content
        config.allowsInlineMediaPlayback = true
        // (the tutor's voice starts by itself after "hello": sound must be allowed to start without a touch)
        config.mediaTypesRequiringUserActionForPlayback = []
        config.applicationNameForUserAgent = "Version/17.0 Mobile/15E148 Safari/604.1"
        // the bridge: ONLY for the tutor's private world, never for the page's own JavaScript
        content.addScriptMessageHandler(bridge, contentWorld: BrowserModel.world, name: "ytc")

        let store = Store.shared
        explainOn = store.value(area: "local", key: "brMode") as? Bool ?? false
        bookmarks = (store.value(area: "local", key: "brBookmarks") as? [Any] ?? []).compactMap { BrowserPage($0) }
        history = (store.value(area: "local", key: "brHistory") as? [Any] ?? []).compactMap { BrowserPage($0) }
        installScripts()
        let saved = store.value(area: "local", key: "brTabs") as? [String: Any]
        let pages = (saved?["tabs"] as? [Any] ?? []).compactMap { BrowserPage($0) }.prefix(BrowserModel.maxTabs)
        for p in pages {
            let tab = makeTab(nil)
            tab.title = p.title
            tab.address = p.url
            tab.waitingURL = URL(string: p.url)
            tabs.append(tab)
        }
        if tabs.isEmpty { tabs.append(makeTab(nil)) }
        let at = (saved?["current"] as? NSNumber)?.intValue ?? 0
        currentID = tabs[min(max(0, at), tabs.count - 1)].id
        // what another window saved (a word marked known in a video) reaches the open pages
        app.storageListeners.append { [weak self] obj, area, from in self?.storageChanged(obj, area: area, except: from) }
    }

    // ---- the tutor's script in the pages ----
    private static var scriptSource: String = {
        "window.__ytcWebMode=true;\n" + AppModel.deviceScript + "\n;\n" + webScripts.map(AppModel.script).joined(separator: "\n;\n")
    }()

    /// Explanation mode on: every new page gets the script (private world, main frame). Off: pages get nothing.
    private func installScripts() {
        content.removeAllUserScripts()
        guard explainOn else { return }
        content.addUserScript(WKUserScript(source: BrowserModel.scriptSource, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: BrowserModel.world))
    }

    private func run(_ js: String, in tab: BrowserTab?) {
        tab?.web.evaluateJavaScript(js + ";0", in: nil, in: BrowserModel.world, completionHandler: nil)
    }

    func setExplain(_ on: Bool) {
        if on == explainOn { return }
        explainOn = on
        Store.shared.set(area: "local", json: AppModel.jsonString(["brMode": on]))
        installScripts()
        // the pages that are open now: the script starts (or goes quiet) without a reload
        for tab in tabs where tab.waitingURL == nil && !tab.address.isEmpty {
            if on { run(BrowserModel.scriptSource + "\n;window.__iknowWeb&&window.__iknowWeb.setMode(true)", in: tab) }
            else { run("window.__iknowWeb&&window.__iknowWeb.setMode(false)", in: tab) }
        }
        if !on { speaking = false; app?.tutorVoice.stop(); audio.stop() }
        micRefused = false
        updateListening()
    }

    /// the Explain button: what is on the screen now (one request); while the tutor talks it is the Stop button
    func explainOrStop() {
        if speaking { stopTalking(); return }
        if !explainOn {
            setExplain(true)
            // (the script has just been put into the page: a moment for it to start)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.run("window.__iknowWeb&&window.__iknowWeb.explainScreen()", in: self?.current) }
            return
        }
        run("window.__iknowWeb&&window.__iknowWeb.explainScreen()", in: current)
    }

    func stopTalking() {
        run("window.__iknowWeb&&window.__iknowWeb.stop()", in: current)
        app?.tutorVoice.stop()
        audio.stop()
        speaking = false
    }

    /// the page's script says whether the tutor is busy (thinking or talking)
    fileprivate func pageState(_ web: WKWebView?, busy: Bool) {
        if web === current?.web { speaking = busy }
    }

    // ---- the microphone: only "hello" and "stop", only while the browser is in front with Explanation mode on ----
    func setShown(_ on: Bool) {
        shown = on
        micRefused = false
        if on { loadIfWaiting(current) }
        else {
            // (nothing talks or plays behind the video: the tutor stops, a site's own video or sound is paused)
            for tab in tabs where tab.waitingURL == nil && !tab.address.isEmpty {
                run("window.__iknowWeb&&window.__iknowWeb.stop();document.querySelectorAll('video,audio').forEach(function(m){try{m.pause()}catch(e){}})", in: tab)
            }
            audio.stop()
            speaking = false
            saveTabs()
        }
        updateListening()
    }

    private func updateListening() {
        guard let app = app else { return }
        // (free mode has no "hello": nothing to listen for)
        let want = shown && explainOn && app.tutorOn && !micRefused
        if want == listening { return }
        listening = want
        if want {
            let extras = Store.shared.value(area: "local", key: "drExtras") as? [String: Any]
            let level = (extras?["micLevel"] as? NSNumber)?.intValue ?? 3
            let headset = extras?["headsetMic"] as? Bool ?? false
            listenStart = Date()
            app.handle(kind: "speech", body: ["op": "start", "level": level, "headset": headset]) { _, _ in }
        } else {
            app.handle(kind: "speech", body: ["op": "stop"]) { _, _ in }
        }
    }

    /// what the app's listener heard while the browser is in front (AppModel.sendSpeech)
    func heard(_ event: [String: Any]) {
        guard shown, explainOn else { return }
        let type = event["type"] as? String ?? ""
        if type == "error" {
            if (event["error"] as? String) == "not-allowed" {
                micRefused = true
                note = "Allow the microphone (iOS Settings ▸ I Know) to say “hello”. The Explain button works without it."
            }
            return
        }
        if type == "end" {
            // (a listening task ended by itself: the next one starts, like the video page does)
            // (one that ended as soon as it began — no internet for the recognizer — is tried again more slowly)
            listening = false
            let wait = Date().timeIntervalSince(listenStart) < 2 ? 5.0 : 0.4
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in self?.updateListening() }
            return
        }
        current?.web.callAsyncJavaScript("window.__iknowWeb && window.__iknowWeb.heard(ev)", arguments: ["ev": event], in: nil, in: BrowserModel.world, completionHandler: nil)
    }

    // ---- storage: what another window saved ----
    /// the keys of the app's storage a web page's script may read (no caches of videos, no browser history)
    static let readKeys = ["drSettings", "drExtras", "drVocab", "drEntries", "drUsage", "drLevel", "drTestBaseUrls"]
    /// ... and the ones it may write (the vocabulary and the cost meter)
    static let writeKeys = ["drVocab", "drEntries", "drUsage", "drLevel"]

    private func storageChanged(_ obj: [String: Any], area: String, except from: WKWebView?) {
        guard explainOn, area == "local" else { return }
        let part = obj.filter { BrowserModel.readKeys.contains($0.key) }
        if part.isEmpty { return }
        for tab in tabs where tab.web !== from && tab.waitingURL == nil && !tab.address.isEmpty {
            tab.web.callAsyncJavaScript("window.__ytcStorageChanged && window.__ytcStorageChanged(obj, area)",
                                        arguments: ["obj": part, "area": area], in: nil, in: BrowserModel.world, completionHandler: nil)
        }
        if obj["drExtras"] != nil { DispatchQueue.main.async { [weak self] in self?.updateListening() } }
    }

    // ---- addresses ----
    /// "example.com" -> https://example.com ; words -> a web search. The same rule as addressOrSearch in web-text.ts.
    static func address(for input: String) -> URL? {
        let t = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.isEmpty { return nil }
        let hasSpace = t.rangeOfCharacter(from: .whitespacesAndNewlines) != nil
        if !hasSpace {
            if t.range(of: "^[a-zA-Z][a-zA-Z0-9+.-]*://\\S+$", options: .regularExpression) != nil { return URL(string: t) }
            if t.range(of: "^(about|data|mailto|tel|sms):", options: [.regularExpression, .caseInsensitive]) != nil { return URL(string: t) }
            if t.range(of: "^(localhost|\\d{1,3}(\\.\\d{1,3}){3})(:\\d+)?(/.*)?$", options: [.regularExpression, .caseInsensitive]) != nil { return URL(string: "http://" + t) }
            if t.range(of: "^[^\\s/?#@]+\\.[a-zA-Z]{2,}(:\\d+)?([/?#]\\S*)?$", options: .regularExpression) != nil, let url = URL(string: "https://" + t) { return url }
        }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        guard let q = t.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: searchPrefix + q)
    }

    /// "https://www.example.com/a/b" -> "example.com/a/b"
    static func short(_ address: String) -> String {
        var s = address
        for p in ["https://", "http://"] where s.hasPrefix(p) { s = String(s.dropFirst(p.count)) }
        if s.hasPrefix("www.") { s = String(s.dropFirst(4)) }
        if s.hasSuffix("/") { s = String(s.dropLast()) }
        return s
    }

    // ---- tabs ----
    private func makeTab(_ given: WKWebViewConfiguration?) -> BrowserTab {
        // (a window a page opens must be made from the configuration WebKit gives; it is a copy of ours)
        let web = WKWebView(frame: .zero, configuration: given ?? config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        return BrowserTab(web: web)
    }

    func newTab(_ url: URL? = nil) {
        if tabs.count >= BrowserModel.maxTabs { note = "\(BrowserModel.maxTabs) tabs are open. Close one first."; if let url = url { open(url) }; return }
        let tab = makeTab(nil)
        tabs.append(tab)
        select(tab)
        if let url = url { load(url, in: tab) }
        saveTabs()
    }

    func select(_ tab: BrowserTab) {
        if currentID != tab.id { stopTalking() }
        currentID = tab.id
        loadIfWaiting(tab)
        saveTabs()
    }

    func close(_ tab: BrowserTab) {
        guard let i = tabs.firstIndex(where: { $0.id == tab.id }) else { return }
        tab.web.stopLoading()
        tabs.remove(at: i)
        if tabs.isEmpty { tabs.append(makeTab(nil)) }
        if currentID == tab.id { currentID = tabs[min(i, tabs.count - 1)].id; speaking = false; loadIfWaiting(current) }
        saveTabs()
    }

    private func loadIfWaiting(_ tab: BrowserTab?) {
        guard let tab = tab, let url = tab.waitingURL else { return }
        tab.waitingURL = nil
        tab.web.load(URLRequest(url: url))
    }

    private func load(_ url: URL, in tab: BrowserTab) {
        tab.waitingURL = nil
        tab.problem = nil
        tab.address = url.absoluteString
        tab.web.load(URLRequest(url: url))
    }

    /// an address in the tab in front (the address bar, a bookmark, "Open this link in I Know")
    func open(_ url: URL) {
        guard let tab = current else { return }
        load(url, in: tab)
    }

    /// what was typed into the address bar: an address, or words to search for
    func go(_ text: String) {
        guard let url = BrowserModel.address(for: text) else { return }
        open(url)
    }

    func pasteLink() {
        let text = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if text.isEmpty { note = "Copy a link first, then tap Paste link."; return }
        go(text)
    }

    func reloadOrStop() {
        guard let tab = current else { return }
        if tab.loading { tab.web.stopLoading(); return }
        tab.problem = nil
        if let url = tab.failedURL { tab.failedURL = nil; tab.web.load(URLRequest(url: url)) }
        else if tab.web.url == nil, let url = URL(string: tab.address) { tab.web.load(URLRequest(url: url)) }
        else { tab.web.reload() }
    }

    func back() { current?.problem = nil; current?.web.goBack() }
    func forward() { current?.problem = nil; current?.web.goForward() }

    func openInSafari() {
        guard let text = current?.address, let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        UIApplication.shared.open(url)
    }

    private func saveTabs() {
        let list = tabs.filter { !$0.address.isEmpty }.map { ["url": $0.address, "title": $0.title] }
        let at = tabs.filter { !$0.address.isEmpty }.firstIndex { $0.id == currentID } ?? 0
        let saved: [String: Any] = ["tabs": list, "current": at]
        Store.shared.set(area: "local", json: AppModel.jsonString(["brTabs": saved]))
    }

    // ---- bookmarks and history ----
    var isBookmarked: Bool { guard let a = current?.address, !a.isEmpty else { return false }; return bookmarks.contains { $0.url == a } }

    func toggleBookmark() {
        guard let tab = current, !tab.address.isEmpty else { return }
        if let i = bookmarks.firstIndex(where: { $0.url == tab.address }) { bookmarks.remove(at: i) }
        else { bookmarks.insert(BrowserPage(url: tab.address, title: tab.title, at: AppModel.nowMs), at: 0) }
        saveBookmarks()
    }

    func removeBookmark(_ page: BrowserPage) {
        bookmarks.removeAll { $0.id == page.id }
        saveBookmarks()
    }

    private func saveBookmarks() {
        Store.shared.set(area: "local", json: AppModel.jsonString(["brBookmarks": bookmarks.map { $0.dict }]))
    }

    private func remember(_ tab: BrowserTab) {
        guard let url = tab.web.url, ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        let address = url.absoluteString
        if history.first?.url == address { history[0].title = tab.web.title ?? history[0].title }
        else { history.insert(BrowserPage(url: address, title: tab.web.title ?? "", at: AppModel.nowMs), at: 0) }
        if history.count > 300 { history.removeLast(history.count - 300) }
        Store.shared.set(area: "local", json: AppModel.jsonString(["brHistory": history.map { $0.dict }]))
    }

    func clearHistory() {
        history = []
        Store.shared.set(area: "local", json: AppModel.jsonString(["brHistory": [Any]()]))
    }

    // ---- the article of the page, in the reader (the "Reader" button) ----
    func openInReader() {
        guard let app = app, let tab = current, !tab.address.isEmpty else { return }
        // (with Explanation mode off the page has no script: it is put in now, only to read the article's text)
        let js = BrowserModel.scriptSource + "\n;return window.__iknowWeb ? window.__iknowWeb.article() : null;"
        let source = explainOn ? "return window.__iknowWeb ? window.__iknowWeb.article() : null;" : js.replacingOccurrences(of: "window.__ytcWebMode=true;", with: "")
        tab.web.callAsyncJavaScript(source, arguments: [:], in: nil, in: BrowserModel.world) { [weak self] result in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard case .success(let value) = result, let d = value as? [String: Any], let text = d["text"] as? String, !text.isEmpty else {
                    self.note = "No article text was found on this page."
                    return
                }
                app.reader.openText(title: d["title"] as? String ?? tab.name, text: text)
                app.showBrowser = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { app.showReader = true }
            }
        }
    }

    // ---- questions (a page's alert / confirm / prompt, "open another app?") ----
    private func put(_ q: BrowserAsk, from web: WKWebView?) {
        // (only the page in front may ask, one question at a time; any other is answered "no" at once)
        if ask != nil || !shown || (web != nil && web !== current?.web) { q.answer(false); return }
        ask = q
    }

    func answer(_ ok: Bool, _ text: String? = nil) {
        let q = ask
        ask = nil
        q?.answer(ok, text)
    }

    // ---- WKNavigationDelegate ----
    private func tab(of web: WKWebView) -> BrowserTab? { tabs.first { $0.web === web } }

    @objc(webView:decidePolicyForNavigationAction:decisionHandler:)
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.allow); return }
        let scheme = url.scheme?.lowercased() ?? ""
        if ["http", "https", "about", "blob", "data"].contains(scheme) { decisionHandler(.allow); return }
        decisionHandler(.cancel)
        // mailto:, tel:, the App Store, another app: handed to iOS, after a question, only for the page in front
        if ["file", "javascript", "iknow", SchemeHandler.scheme].contains(scheme) { return }
        if navigationAction.targetFrame?.isMainFrame == false { return }
        put(BrowserAsk(kind: .openApp, title: "Open another app?", message: BrowserModel.short(url.absoluteString).prefix(120).description) { ok, _ in
            if ok { UIApplication.shared.open(url) }
        }, from: webView)
    }

    @objc(webView:decidePolicyForNavigationResponse:decisionHandler:)
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (navigationResponse.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")?.lowercased() ?? ""
        if navigationResponse.isForMainFrame && (!navigationResponse.canShowMIMEType || disposition.hasPrefix("attachment")) {
            decisionHandler(.cancel)
            note = "Downloads are not supported yet. Use “Open in Safari” for this file."
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard let tab = tab(of: webView) else { return }
        tab.problem = nil
        tab.failedURL = nil
        if tab.id == currentID { speaking = false; note = nil }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let tab = tab(of: webView) else { return }
        remember(tab)
        saveTabs()
    }

    private func failed(_ webView: WKWebView, _ error: Error) {
        let e = error as NSError
        // (a load that was stopped or replaced, a download or another app taking over: no error page)
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        if e.domain == "WebKitErrorDomain" && (e.code == 102 || e.code == 204) { return }
        guard let tab = tab(of: webView) else { return }
        tab.failedURL = (e.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url ?? URL(string: tab.address)
        tab.problem = e.localizedDescription
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(webView, error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(webView, error) }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard let tab = tab(of: webView) else { return }
        if tab.id == currentID { speaking = false }
        tab.failedURL = webView.url ?? URL(string: tab.address)
        tab.problem = "This page stopped. Tap Reload."
    }

    // ---- WKUIDelegate ----
    /// a link that wants a new window (target=_blank, window.open): a new tab
    @objc(webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:)
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame != nil { return nil }
        if tabs.count >= BrowserModel.maxTabs {
            // (too many tabs: it opens in this one)
            webView.load(navigationAction.request)
            return nil
        }
        let tab = makeTab(configuration)
        tabs.append(tab)
        select(tab)
        return tab.web
    }

    func webViewDidClose(_ webView: WKWebView) {
        if let tab = tab(of: webView) { close(tab) }
    }

    @objc(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:)
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        put(BrowserAsk(kind: .alert, title: BrowserModel.short(webView.url?.host ?? "This page"), message: String(message.prefix(600))) { _, _ in completionHandler() }, from: webView)
    }

    @objc(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:)
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        put(BrowserAsk(kind: .confirm, title: BrowserModel.short(webView.url?.host ?? "This page"), message: String(message.prefix(600))) { ok, _ in completionHandler(ok) }, from: webView)
    }

    @objc(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:)
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        put(BrowserAsk(kind: .prompt, title: BrowserModel.short(webView.url?.host ?? "This page"), message: String(prompt.prefix(600)), preset: defaultText ?? "") { ok, text in completionHandler(ok ? (text ?? "") : nil) }, from: webView)
    }

    /// websites get no camera and no microphone (the tutor's own "hello" is heard by the app, not by the page)
    @available(iOS 15.0, *)
    @objc(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    /// ... and no motion sensors
    @available(iOS 15.0, *)
    @objc(webView:requestDeviceOrientationAndMotionPermissionForOrigin:initiatedByFrame:decisionHandler:)
    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }
}

/// The bridge of the browser's pages. It is registered only for the tutor's private script world; a message from any
/// other world or from a frame inside the page is refused. It answers only what dream-web.js needs:
///  - the storage: a few keys to read, fewer to write (never everything, never the browser's history);
///  - the keys: the AI and voice keys, read only (no saving, no GitHub token);
///  - requests: only to the AI and voice services; the app's files: only the dictionary and the frequency table;
///  - the device's voice and translation. Everything else (the app's pages, the vocabulary file, the microphone) is not here.
final class BrowserBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var browser: BrowserModel?
    /// the app's ordinary bridge, for this world: it does the work for the kinds let through below
    let inner = Bridge(world: BrowserModel.world)

    /// the kinds handed on as they are
    static let passed: Set<String> = ["nativeFetchCancel", "voices", "speak", "speakStop", "speakPause", "speakResume", "audioSession", "translate", "log"]
    static let files: Set<String> = ["dream/dict.json.gz", "dream/zipf.json.gz"]

    static func fetchAllowed(_ text: String) -> Bool {
        guard let url = URL(string: text), url.scheme == "https", let host = url.host?.lowercased() else { return false }
        return ["api.anthropic.com", "api.openai.com", "api.elevenlabs.io"].contains(host) || host.hasSuffix(".tts.speech.microsoft.com")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.world == BrowserModel.world, message.frameInfo.isMainFrame,
              let body = message.body as? [String: Any], let kind = body["kind"] as? String,
              let app = inner.model else { replyHandler(nil, "not allowed"); return }
        let area = body["area"] as? String ?? "local"
        switch kind {
        case "storageAll":
            guard area == "local" else { replyHandler("{}", nil); return }
            var out: [String: Any] = [:]
            for key in BrowserModel.readKeys { if let v = Store.shared.value(area: "local", key: key) { out[key] = v } }
            replyHandler(AppModel.jsonString(out), nil)
        case "storageSet":
            guard area == "local", let data = (body["json"] as? String ?? "").data(using: .utf8),
                  let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { replyHandler(nil, nil); return }
            let part = obj.filter { BrowserModel.writeKeys.contains($0.key) }
            let web = message.webView
            if !part.isEmpty { DispatchQueue.main.async { app.storageSet(area: "local", json: AppModel.jsonString(part), from: web) } }
            replyHandler(nil, nil)
        case "keychainGet":
            // the AI and voice keys only, to read (the private world needs them for the requests; the page never sees them)
            guard (body["name"] as? String) == "drKeys", let text = Keys.get("drKeys"), let data = text.data(using: .utf8),
                  let all = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { replyHandler(nil, nil); return }
            let part = all.filter { ["anthropic", "openai", "elevenlabs", "azure"].contains($0.key) }
            replyHandler(AppModel.jsonString(part), nil)
        case "nativeFetch":
            guard BrowserBridge.fetchAllowed(body["url"] as? String ?? "") else { replyHandler(nil, "address not allowed"); return }
            inner.userContentController(userContentController, didReceive: message, replyHandler: replyHandler)
        case "resource":
            guard BrowserBridge.files.contains(body["path"] as? String ?? "") else { replyHandler(nil, nil); return }
            inner.userContentController(userContentController, didReceive: message, replyHandler: replyHandler)
        case "audioPlay":
            // the tutor's cloud voice: played by the app (not by the page), for the page in front only
            guard let browser = browser, message.webView === browser.current?.web else { replyHandler(["ok": false], nil); return }
            replyHandler(browser.audio.play(body, web: message.webView), nil)
        case "audioStop":
            browser?.audio.stop(id: (body["id"] as? NSNumber)?.intValue)
            replyHandler(nil, nil)
        case "webState":
            let busy = body["busy"] as? Bool ?? false
            let web = message.webView
            DispatchQueue.main.async { [weak self] in self?.browser?.pageState(web, busy: busy) }
            replyHandler(nil, nil)
        default:
            if BrowserBridge.passed.contains(kind) { inner.userContentController(userContentController, didReceive: message, replyHandler: replyHandler) }
            else { replyHandler(nil, nil) }   // keychainSet, storageRemove, openPage, vocabFile, speech, …: not for web pages
        }
    }
}

/// Plays the tutor's cloud voice for a web page: the sound comes from the page's private script world as data, and
/// the start and the end go back there (window.__ytcAudio). One sound at a time.
final class PageAudio: NSObject, AVAudioPlayerDelegate {
    private var player: AVAudioPlayer?
    private var id = 0
    private weak var web: WKWebView?

    private func tell(_ event: String, id: Int, web: WKWebView?) {
        let ev: [String: Any] = ["id": id, "event": event]
        web?.callAsyncJavaScript("window.__ytcAudio && window.__ytcAudio(ev)", arguments: ["ev": ev], in: nil, in: BrowserModel.world, completionHandler: nil)
    }

    /// { ok, duration } for the page; the sound starts at once
    func play(_ body: [String: Any], web: WKWebView?) -> [String: Any] {
        stop()
        guard let id = (body["id"] as? NSNumber)?.intValue, let b64 = body["b64"] as? String, let data = Data(base64Encoded: b64), !data.isEmpty else { return ["ok": false] }
        // (heard with the Ring/Silent switch on silent; an open microphone session, play-and-record, is left alone)
        let category = AVAudioSession.sharedInstance().category
        if category != .playback && category != .playAndRecord { AudioSession.set(mode: "play") }
        guard let p = try? AVAudioPlayer(data: data) else { return ["ok": false] }
        p.delegate = self
        p.enableRate = true
        p.rate = Float(min(2.5, max(0.5, (body["rate"] as? NSNumber)?.doubleValue ?? 1)))
        p.volume = Float(min(1, max(0, (body["volume"] as? NSNumber)?.doubleValue ?? 1)))
        guard p.prepareToPlay(), p.play() else { return ["ok": false] }
        player = p
        self.id = id
        self.web = web
        tell("start", id: id, web: web)
        return ["ok": true, "duration": p.duration]
    }

    /// `id` nil: whatever plays
    func stop(id only: Int? = nil) {
        guard let p = player, only == nil || only == id else { return }
        player = nil
        p.delegate = nil
        p.stop()
        tell("cancel", id: id, web: web)
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        guard player === self.player else { return }
        self.player = nil
        tell(flag ? "end" : "error", id: id, web: web)
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        guard player === self.player else { return }
        self.player = nil
        tell("error", id: id, web: web)
    }
}
