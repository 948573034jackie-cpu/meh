import SwiftUI
import WebKit

/// The app: YouTube in a web view with My tutor inside it (the same JavaScript as the Chrome extension), the tutor's
/// settings and vocabulary pages in a sheet, the iPhone's microphone and voice for the tutor, and the vocabulary file
/// shared with the Mac.
final class AppModel: NSObject, ObservableObject, WKNavigationDelegate {
    @Published var toast: String?
    @Published var tutorOn = true        // My tutor is on (its buttons show in the bottom bar)
    @Published var explainSeconds = 20   // the "Explain N s" button: the tutor's part length (drSettings.listen.lastSecondsWindow)
    @Published var sheetOpen = false     // My tutor's settings / My Vocabulary page
    @Published var vocabFolder: String?  // the shared folder of the vocabulary file (iCloud Drive / Google Drive), or nil
    @Published var vocabStatus = ""      // the last save of the vocabulary file, in words

    let youtube: WKWebView
    static let world = WKContentWorld.world(name: "ytc")

    /// The scripts of the YouTube window, in this order (tests/ios-webkit-test.js reads this list):
    /// the shims, the extension's page script (lib, background, youtube), then My tutor (its background, then its page part).
    static let youtubeScripts = ["shim-common", "shim-youtube", "shim-dream", "lib", "background", "youtube", "dream-bg", "dream-yt"]
    /// My tutor's settings and vocabulary pages (in the page world, before the page's own script)
    static let sheetScripts = ["shim-common", "shim-dream", "dream-bg"]

    private let speech = SpeechListener()
    let tutorVoice = TutorVoice()
    private let pageBridge = Bridge(world: .page)
    private(set) lazy var sheet: WKWebView = {
        let web = WKWebView(frame: .zero, configuration: AppModel.makeSheetConfig(bridge: self.pageBridge))
        web.navigationDelegate = self
        return web
    }()
    private let bridge: Bridge
    private var started = false
    private var jsLogs: [String] = []
    private var selfTestReport: [String: Any] = [:]

    override init() {
        let bridge = Bridge(world: AppModel.world)
        self.bridge = bridge
        self.youtube = WKWebView(frame: .zero, configuration: AppModel.makeConfig(bridge: bridge))
        super.init()

        bridge.model = self
        pageBridge.model = self
        tutorOn = ((Store.shared.value(area: "local", key: "drExtras") as? [String: Any])?["tutorOn"] as? Bool) ?? true
        explainSeconds = AppModel.partSeconds(in: Store.shared.value(area: "local", key: "drSettings"))
        vocabFolder = VocabFile.shared.folderName
        NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in Store.shared.flush() }
        // back in the app: the vocabulary file may have new words from the Mac
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in self?.syncVocabulary() }
        youtube.navigationDelegate = self
        youtube.allowsBackForwardNavigationGestures = true

        // (index: the number of the piece that was heard; the page acts once per piece)
        speech.onText = { [weak self] text, final, index in
            self?.sendSpeech(["type": "result", "text": text, "final": final, "index": index])
        }
        speech.onEnd = { [weak self] reason in
            guard let self = self else { return }
            if let reason = reason { self.sendSpeech(["type": "error", "error": reason]) }
            self.sendSpeech(["type": "end"])
        }
    }

    // ---- start-up ----
    func start() {
        if started { return }
        started = true
        if ProcessInfo.processInfo.arguments.contains("-selftest") {
            runSelfTest()
            return
        }
        goHome()
    }

    // ---- automatic test (used by the build server: launch the app with the argument -selftest) ----
    private func runSelfTest() {
        selfTestReport = ["ios": UIDevice.current.systemVersion, "device": UIDevice.current.model]
        if let url = URL(string: "https://m.youtube.com/watch?v=iG9CE55wbtY") { youtube.load(URLRequest(url: url)) }

        Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in self?.writeSelfTestReport() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self = self else { return }
            let ytTest = """
            const out = { url: location.href };
            const v = document.querySelector('video');
            out.hasVideo = !!v;
            out.hasChromeShim = !!(window.chrome && window.chrome.__ytc);
            out.viewport = [window.innerWidth, window.innerHeight];
            out.pageText = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240);
            try {
              const html = await (await fetch(location.href, { credentials: 'include' })).text();
              const pr = window.YTC.extractPlayerResponse(html);
              out.htmlLength = html.length;
              out.playability = pr && pr.playabilityStatus ? { status: pr.playabilityStatus.status, reason: pr.playabilityStatus.reason } : null;
              out.captionTracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer ? (pr.captions.playerCaptionsTracklistRenderer.captionTracks || []).length : 0;
            } catch (e) { out.htmlError = String(e); }
            try { out.transcript = await window.__ytcDebug.load(); } catch (e) { out.transcriptError = String(e); }
            // My tutor: loaded, its dictionary from the app, its background answers through the in-page port and messages
            out.tutor = { loaded: !!window.__ytcDream, buttons: typeof (window.__ytcDream && window.__ytcDream.action) };
            try { out.tutor.dictionaryBytes = (await (await fetch(chrome.runtime.getURL('dream/dict.json.gz'))).arrayBuffer()).byteLength; } catch (e) { out.tutor.dictionaryError = String(e); }
            try { out.tutor.keyTest = await chrome.runtime.sendMessage({ type: 'dream-test-key', provider: 'anthropic' }); } catch (e) { out.tutor.keyTestError = String(e); }
            try { out.tutor.voices = speechSynthesis.getVoices().length; } catch (e) { out.tutor.voicesError = String(e); }
            try { out.tutor.diag = window.__ytcDream && window.__ytcDream.diag(); } catch (e) { out.tutor.diagError = String(e); }
            try { out.tutor.vocabFile = await chrome.runtime.sendMessage({ type: 'dream-db-write' }); } catch (e) { out.tutor.vocabFileError = String(e); }
            if (v) {
              v.muted = true;
              try { await Promise.race([v.play(), new Promise(r => setTimeout(r, 5000))]); } catch (e) { out.playError = String(e); }
              await new Promise(r => setTimeout(r, 2000));
              out.videoState = { t: v.currentTime, paused: v.paused };
              const rect = v.getBoundingClientRect();
              out.videoRect = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
            }
            return out;
            """
            self.youtube.callAsyncJavaScript(ytTest, arguments: [:], in: nil, in: AppModel.world) { result in
                DispatchQueue.main.async {
                    switch result {
                    case .success(let value): self.selfTestReport["youtube"] = value
                    case .failure(let error): self.selfTestReport["youtubeError"] = error.localizedDescription
                    }
                    self.writeSelfTestReport()
                }
            }
        }
    }

    private func writeSelfTestReport() {
        var report = selfTestReport
        report["jsLogs"] = jsLogs
        report["frames"] = [
            "youtube": NSCoder.string(for: youtube.frame),
            "youtubeContainer": NSCoder.string(for: youtube.superview?.frame ?? .zero),
            "window": NSCoder.string(for: youtube.window?.frame ?? .zero),
            "screen": NSCoder.string(for: UIScreen.main.bounds),
            "safeArea": NSCoder.string(for: youtube.window?.safeAreaInsets ?? .zero)
        ]
        report["writtenAt"] = ISO8601DateFormatter().string(from: Date())
        report["youtubeUrlNow"] = youtube.url?.absoluteString ?? "-"
        report["vocabFile"] = VocabFile.shared.status()
        guard JSONSerialization.isValidJSONObject(report),
              let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted]),
              let dir = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first else { return }
        try? data.write(to: URL(fileURLWithPath: dir).appendingPathComponent("selftest.json"))
    }

    func goHome() {
        if let url = URL(string: "https://m.youtube.com/") { youtube.load(URLRequest(url: url)) }
    }

    // ---- the bar's own buttons (Home, Paste link) ----
    func pasteLink() {
        let text = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let url = URL(string: text), let host = url.host, host.contains("youtube.com") || host.contains("youtu.be") {
            youtube.load(URLRequest(url: url))
        } else {
            show("Copy a YouTube link first, then tap this button.")
        }
    }

    func show(_ text: String) {
        toast = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 7) { [weak self] in
            if self?.toast == text { self?.toast = nil }
        }
    }

    // ---- the shared vocabulary file ----
    /// the Files app folder (iCloud Drive), or the vocabulary.json file itself (Google Drive), you chose: the Mac's Chrome
    /// and this phone share one file
    func chooseVocabFolder(_ url: URL, isFile: Bool = false) {
        VocabFile.shared.setFolder(url, isFile: isFile)
        vocabFolder = VocabFile.shared.folderName
        show("The vocabulary file is shared in “\(vocabFolder ?? url.lastPathComponent)”.")
        syncVocabulary()
    }

    func forgetVocabFolder() {
        VocabFile.shared.setFolder(nil)
        vocabFolder = nil
        syncVocabulary()
    }

    /// the tutor reads the shared file (new words from the Mac), merges it with its own words and writes it back
    func syncVocabulary() {
        youtube.evaluateJavaScript("window.chrome && chrome.runtime && chrome.runtime.sendMessage({ type: 'dream-db-write' }).catch(function () {}); 0",
                                   in: nil, in: AppModel.world, completionHandler: nil)
    }

    private func sendSpeech(_ event: [String: Any]) {
        let json = AppModel.jsonString(event)
        youtube.evaluateJavaScript("window.__ytcSpeech && window.__ytcSpeech(\(json))", in: nil, in: AppModel.world, completionHandler: nil)
    }

    // ---- messages from the JavaScript in the web views (My tutor's own kinds are answered in Bridge.swift) ----
    func handle(kind: String, body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        switch kind {
        case "speech":
            switch body["op"] as? String {
            case "start": speech.start(level: (body["level"] as? NSNumber)?.intValue ?? 3)   // the microphone's sensitivity, 1–3
            case "finish": speech.finish()
            default: speech.stop()
            }
            reply(nil, nil)

        case "vocabFile":
            // the vocabulary file, read or written off the main thread (iCloud may have to download it first)
            let msg = body["msg"] as? [String: Any] ?? [:]
            VocabFile.shared.queue.async {
                let r = VocabFile.shared.handle(msg)
                let text = VocabFile.shared.statusText
                DispatchQueue.main.async { [weak self] in
                    self?.vocabStatus = text
                    reply(r, nil)
                }
            }

        case "log":
            if jsLogs.count < 80 { jsLogs.append((body["text"] as? String ?? "").prefix(300).description) }
            reply(nil, nil)

        default:
            reply(nil, nil)
        }
    }

    // ---- navigation events (kept for the automatic test report) ----
    private func navLog(_ event: String, _ webView: WKWebView, _ error: Error? = nil) {
        guard jsLogs.count < 120 else { return }
        let who = webView === youtube ? "youtube" : "sheet"
        jsLogs.append("nav \(event) \(who) \(webView.url?.absoluteString ?? "-")" + (error.map { " error: \($0.localizedDescription)" } ?? ""))
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        navLog("start", webView)
        // (a whole new page: the old page's listener is gone without closing the microphone; the new page asks again)
        if webView === youtube { speech.stop() }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === youtube { speech.stop() }
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { navLog("commit", webView) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { navLog("finish", webView) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navLog("fail", webView, error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navLog("failProvisional", webView, error) }

    // ---- helpers ----
    /// the tutor's part length in seconds, from its saved settings (drSettings.listen.lastSecondsWindow; 20 when absent)
    static func partSeconds(in settings: Any?) -> Int {
        let listen = (settings as? [String: Any])?["listen"] as? [String: Any]
        let seconds = (listen?["lastSecondsWindow"] as? NSNumber)?.intValue ?? 20
        return seconds > 0 ? seconds : 20
    }

    static func jsonString(_ object: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        return text
    }

    static func script(_ name: String) -> String {
        #if SWIFT_PACKAGE
        let bundle = Bundle.module   // Swift Playgrounds (iPad) package: the scripts are its resources
        #else
        let bundle = Bundle.main     // Xcode app
        #endif
        guard let url = bundle.url(forResource: name, withExtension: "js"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return "/* missing \(name).js */" }
        return text
    }

    // ---- My tutor's storage (chrome.storage.local / .sync: Store.swift) ----
    func storageAll(area: String) -> String {
        // (the app has its own buttons: no bar under the video)
        Store.shared.allJSON(area: area, overrides: area == "local" ? ["barOn": false] : [:])
    }

    func storageSet(area: String, json: String, from web: WKWebView?) {
        let obj = Store.shared.set(area: area, json: json)
        if area == "local", let extras = obj["drExtras"] as? [String: Any] {
            let on = extras["tutorOn"] as? Bool ?? true
            if on != tutorOn { tutorOn = on }
        }
        if area == "local", let settings = obj["drSettings"] {
            let seconds = AppModel.partSeconds(in: settings)
            if seconds != explainSeconds { explainSeconds = seconds }
        }
        tellOtherWindows(obj, area: area, except: web)
    }

    func storageRemove(area: String, keys: [String], from web: WKWebView?) {
        Store.shared.remove(area: area, keys: keys)
        if area == "local", keys.contains("drSettings"), explainSeconds != 20 { explainSeconds = 20 }
        var gone: [String: Any] = [:]
        for k in keys { gone[k] = NSNull() }
        tellOtherWindows(gone, area: area, except: web)
    }

    func keysChanged(name: String, value: String?, from web: WKWebView?) {
        var parsed: Any = NSNull()
        if let value = value, let data = value.data(using: .utf8), let obj = try? JSONSerialization.jsonObject(with: data) { parsed = obj }
        tellOtherWindows([name: parsed], area: "local", except: web)
    }

    /// what one window saved, the other window (YouTube / the settings sheet) learns at once (chrome.storage.onChanged)
    private func tellOtherWindows(_ obj: [String: Any], area: String, except web: WKWebView?) {
        if obj.isEmpty { return }
        var targets: [(WKWebView, WKContentWorld)] = [(youtube, AppModel.world)]
        if sheetOpen { targets.append((sheet, .page)) }
        for (view, world) in targets where view !== web {
            view.callAsyncJavaScript("window.__ytcStorageChanged && window.__ytcStorageChanged(obj, area)",
                                     arguments: ["obj": obj, "area": area], in: nil, in: world, completionHandler: nil)
        }
    }

    /// My tutor opens its settings or My Vocabulary (ytlearn://app/dream/…) in a sheet
    func openPage(_ address: String) {
        guard let url = URL(string: address), url.scheme == SchemeHandler.scheme else { return }
        sheet.load(URLRequest(url: url))
        sheetOpen = true
    }

    /// a button of the bottom bar: the same as the tutor's keyboard shortcut of that name (window.__ytcDream.action)
    func dream(_ action: String) {
        youtube.callAsyncJavaScript("return window.__ytcDream && window.__ytcDream.action ? window.__ytcDream.action(id) : null;",
                                    arguments: ["id": action], in: nil, in: AppModel.world) { [weak self] result in
            DispatchQueue.main.async {
                // (no answer at all: the tutor is not on this page)
                if case .success(let value) = result, value is NSNull { self?.show("Open a YouTube video first.") }
                // (the page answered "nothing to do" and it is not a video page: the buttons need a video)
                if case .success(let value) = result, (value as? Bool) == false, self?.youtube.url?.path != "/watch" { self?.show("Open a YouTube video first.") }
                if case .failure = result { self?.show("Open a YouTube video first.") }
            }
        }
    }

    static func makeSheetConfig(bridge: Bridge) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(SchemeHandler(), forURLScheme: SchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        let controller = config.userContentController
        controller.addScriptMessageHandler(bridge, contentWorld: .page, name: "ytc")
        let source = sheetScripts.map(script).joined(separator: "\n;\n")
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        return config
    }

    static func makeConfig(bridge: Bridge) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []   // the tutor plays the video on by itself
        config.applicationNameForUserAgent = "Version/17.0 Mobile/15E148 Safari/604.1"

        let controller = config.userContentController
        controller.addScriptMessageHandler(bridge, contentWorld: world, name: "ytc")

        // (the saved settings are read from Store when the page starts: storageAll)
        let source = youtubeScripts.map(script).joined(separator: "\n;\n")
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world))
        return config
    }
}
