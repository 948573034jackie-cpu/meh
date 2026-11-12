import SwiftUI
import WebKit
import AVFoundation

/// The app: YouTube in a web view with My tutor inside it (the same JavaScript as the Chrome extension), the tutor's
/// settings and vocabulary pages in a sheet, the iPhone's microphone and voice for the tutor, and the vocabulary file
/// shared with the Mac.
final class AppModel: NSObject, ObservableObject, WKNavigationDelegate {
    @Published var toast: String?
    @Published var tutorOn = true        // My tutor is on (its buttons show in the bottom bar); off = free mode (no AI)
    @Published var oneButton = false     // One button mode: a touch on the page or the video explains the last part (the bar stays as it is)
    @Published var tutorVolume = 60      // the tutor's volume, % (drExtras.teacherVolume): the bar's Volume button
    @Published var volumeOpen = false    // the two big buttons, quieter / louder, are on the screen
    @Published var barPeek = false       // full screen on an iPhone on its side: the whole bar is back for a moment ("More")
    /// the page shows the video over the whole window (its own full screen); then a swipe from the edge must not leave the video
    @Published var pageFull = false { didSet { if oldValue != pageFull { youtube.allowsBackForwardNavigationGestures = !pageFull } } }
    private var volumeTouchedAt = Date()
    @Published var bandOn = true         // Video mode: the subtitles on the video (drExtras.band is not "off")
    @Published var pageOn = true         // Video mode: the big page at stops and pauses (drExtras.stageOn)
    @Published var videoMode = false     // the tutor's view is Video mode (drExtras.view "normal"): the two switches show
    @Published var explainSeconds = 20   // the "Explain N s" button: the tutor's part length (drSettings.listen.lastSecondsWindow)
    @Published var sheetOpen = false     // My tutor's settings / My Vocabulary page
    @Published var vocabFolder: String?  // the shared folder of the vocabulary file (iCloud Drive / Google Drive), or nil
    @Published var vocabStatus = ""      // the last save of the vocabulary file, in words
    @Published var showReader = false    // the reader (books, PDFs, texts), full screen: ReaderScreen.swift
    @Published var showBrowser = false   // the browser inside the app, full screen: Browser.swift
    /// other windows of the app that want to know what was saved (the reader, the browser's tabs)
    var storageListeners: [([String: Any], String, WKWebView?) -> Void] = []
    private(set) lazy var reader = ReaderHost(app: self)
    private(set) lazy var browser = BrowserModel(app: self)

    let youtube: WKWebView
    static let world = WKContentWorld.world(name: "ytc")

    /// The scripts of the YouTube window, in this order (tests/ios-webkit-test.js reads this list):
    /// the shims, the extension's page script (lib, background, youtube), then My tutor (its background, then its page part).
    static let youtubeScripts = ["shim-common", "shim-youtube", "shim-dream", "lib", "background", "youtube", "dream-bg", "dream-yt"]
    /// My tutor's settings and vocabulary pages (in the page world, before the page's own script)
    static let sheetScripts = ["shim-common", "shim-dream", "dream-bg"]
    /// in the YouTube page's OWN JavaScript world (not the tutor's): YouTube's full-screen request is handed to the tutor
    static let pageScripts = ["page-hooks"]

    private let speech = SpeechListener()
    let tutorVoice = TutorVoice()
    #if canImport(Translation) && compiler(>=6.0)
    /// free mode's translation of a sentence (Apple's Translation, on the device): a FreeTranslator on iOS 18, else nil
    let translator: AnyObject? = {
        if #available(iOS 18.0, *) { return FreeTranslator() }
        return nil
    }()
    #endif
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
    private var urlWatch: NSKeyValueObservation?   // the YouTube window's address (back where you stopped)
    private var timeWatch: Timer?                   // the minute of the video, kept every 15 s

    override init() {
        let bridge = Bridge(world: AppModel.world)
        self.bridge = bridge
        self.youtube = WKWebView(frame: .zero, configuration: AppModel.makeConfig(bridge: bridge))
        super.init()

        bridge.model = self
        pageBridge.model = self
        let x = Store.shared.value(area: "local", key: "drExtras") as? [String: Any] ?? [:]
        tutorOn = x["tutorOn"] as? Bool ?? true
        oneButton = x["oneButton"] as? Bool ?? false
        (bandOn, pageOn, videoMode) = AppModel.videoSwitches(x)
        explainSeconds = AppModel.partSeconds(in: Store.shared.value(area: "local", key: "drSettings"))
        tutorVolume = AppModel.volume(in: x)
        vocabFolder = VocabFile.shared.folderName
        NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.leaving() }
        // back in the app: the vocabulary file may have new words from the Mac
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in self?.syncVocabulary() }
        youtube.navigationDelegate = self
        youtube.allowsBackForwardNavigationGestures = true
        // (every new page, also inside YouTube's own page: the last one is opened again next time)
        urlWatch = youtube.observe(\.url, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.rememberPage() }
        }

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
        // back where you stopped: the same page (the same video, at the same minute); the mode, the view and the
        // switches are in My tutor's saved settings already
        let spots = Store.shared.value(area: "local", key: "drSpots") as? [String: Any]
        if let last = AppModel.lastPage(Store.shared.value(area: "local", key: "appLastPage"), spots: spots, now: AppModel.nowMs) {
            youtube.load(URLRequest(url: last.url))
            if let t = last.t { show("Back where you stopped (\(AppModel.clock(t))).") }
        } else {
            goHome()
        }
        timeWatch = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            if UIApplication.shared.applicationState == .active { self?.keepVideoTime() }
        }
    }

    // ---- back where you stopped ----
    static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    /// the video of a YouTube address ("watch:abc", "shorts:abc"), or nil for any other page
    static func videoKey(_ address: String?) -> String? {
        guard let address = address, let parts = URLComponents(string: address) else { return nil }
        if parts.path == "/watch", let v = parts.queryItems?.first(where: { $0.name == "v" })?.value, !v.isEmpty { return "watch:" + v }
        if parts.path.hasPrefix("/shorts/") { return "shorts:" + parts.path.dropFirst(8) }
        return nil
    }

    /// the YouTube page now (m.youtube.com only, without a time in its address) is kept at once (appLastPage, with
    /// the minute of its video while it is the same video); not through storageSet: the page does not need to know
    private func rememberPage() {
        guard let now = youtube.url, var parts = URLComponents(url: now, resolvingAgainstBaseURL: false), parts.host == "m.youtube.com" else { return }
        parts.queryItems = parts.queryItems?.filter { !["t", "start", "pp"].contains($0.name) }
        if parts.queryItems?.isEmpty == true { parts.queryItems = nil }
        guard let url = parts.url?.absoluteString else { return }
        let old = Store.shared.value(area: "local", key: "appLastPage") as? [String: Any]
        if (old?["url"] as? String) == url { return }
        var page: [String: Any] = ["url": url, "at": AppModel.nowMs]
        if let old = old, let key = AppModel.videoKey(url), AppModel.videoKey(old["url"] as? String) == key {
            page["t"] = old["t"]
            page["d"] = old["d"]
        }
        Store.shared.set(area: "local", json: AppModel.jsonString(["appLastPage": page]))
    }

    /// the minute of the video on the page is added to the kept page (then `done`: the app going away writes it at once)
    private func keepVideoTime(then done: (() -> Void)? = nil) {
        let js = "(()=>{const v=document.querySelector('video');if(!v||!(v.duration>0)||(window.__ytcApi&&window.__ytcApi.isAd&&window.__ytcApi.isAd()))return null;return [v.currentTime,v.duration]})()"
        youtube.evaluateJavaScript(js, in: nil, in: AppModel.world) { [weak self] result in
            DispatchQueue.main.async {
                if case .success(let value) = result, let a = value as? [NSNumber], a.count == 2 { self?.keepTime(a[0].doubleValue, a[1].doubleValue) }
                done?()
            }
        }
    }

    private func keepTime(_ t: Double, _ d: Double) {
        guard var page = Store.shared.value(area: "local", key: "appLastPage") as? [String: Any],
              let key = AppModel.videoKey(page["url"] as? String), AppModel.videoKey(youtube.url?.absoluteString) == key else { return }
        // (the same second as before, a paused video: nothing to write)
        if let was = (page["t"] as? NSNumber)?.doubleValue, abs(was - t) < 1 { return }
        page["t"] = t
        page["d"] = d
        page["at"] = AppModel.nowMs
        Store.shared.set(area: "local", json: AppModel.jsonString(["appLastPage": page]))
    }

    /// the app goes to the background (or is closed): the minute of the video is kept and everything is written
    private func leaving() {
        let app = UIApplication.shared
        var task = UIBackgroundTaskIdentifier.invalid
        let end = {
            if task != .invalid { app.endBackgroundTask(task); task = .invalid }
        }
        task = app.beginBackgroundTask(withName: "back where you stopped") { end() }
        Store.shared.flush()
        keepVideoTime {
            Store.shared.flush()
            end()
        }
    }

    /// the page to open at the start: the last YouTube page (kept less than 60 days ago); a video well started and
    /// not finished opens 3 s before its minute (the address's &t=). The minute is the app's own (kept when it went
    /// away), else My tutor's (drSpots, every 5 s while it plays). nil: the home page.
    static func lastPage(_ saved: Any?, spots: [String: Any]?, now: Double) -> (url: URL, t: Double?)? {
        guard let page = saved as? [String: Any], let address = page["url"] as? String,
              let at = (page["at"] as? NSNumber)?.doubleValue, now - at < 60 * 86400 * 1000,
              let url = URL(string: address), url.host == "m.youtube.com" else { return nil }
        // (a /watch address always has its ?v=)
        guard url.path == "/watch", let key = videoKey(address) else { return (url, nil) }
        var t = (page["t"] as? NSNumber)?.doubleValue ?? 0
        var d = (page["d"] as? NSNumber)?.doubleValue ?? 0
        if page["t"] == nil, let spot = spots?[String(key.dropFirst(6))] as? [String: Any] {
            t = (spot["t"] as? NSNumber)?.doubleValue ?? 0
            d = (spot["d"] as? NSNumber)?.doubleValue ?? 0
        }
        guard t > 30, t < d - 30, let back = URL(string: address + "&t=\(Int(t) - 3)s") else { return (url, nil) }
        return (back, t - 3)
    }

    /// 957 s -> "15:57", 3725 s -> "1:02:05"
    static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
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
            // full screen on the REAL YouTube page: the player must cover the whole window, and go back
            try {
              const boxOf = () => { const p = document.querySelector('#player-container-id, ytm-player, .player-container'); const r = p ? p.getBoundingClientRect() : null; const vr = v ? v.getBoundingClientRect() : null;
                return { full: document.documentElement.classList.contains('dr-full'), player: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] : null, video: vr ? [Math.round(vr.left), Math.round(vr.top), Math.round(vr.width), Math.round(vr.height)] : null, win: [window.innerWidth, window.innerHeight] }; };
              const before = boxOf();
              const did = window.__ytcDream && window.__ytcDream.action ? window.__ytcDream.action('full') : null;
              await new Promise(r => setTimeout(r, 900));
              const during = boxOf();
              if (during.full !== before.full) { window.__ytcDream.action('full'); await new Promise(r => setTimeout(r, 600)); }
              out.fullScreen = { did, before, during, after: boxOf(), hookFlag: document.documentElement.dataset.ytcTutor || null,
                topBar: !!document.querySelector('ytm-mobile-topbar-renderer, header.mobile-topbar-header'), fsButton: !!document.querySelector('.ytp-fullscreen-button, .fullscreen-icon, .ytmFullscreenButtonHost, button[aria-label*="ull screen" i], button[aria-label*="ullscreen" i]') };
            } catch (e) { out.fullScreenError = String(e); }
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

    /// a sentence in Chinese by the device (free mode's card, and the tutor's sentence card): the answer goes back to the page
    func translate(_ text: String, reply: @escaping (Any?, String?) -> Void) {
        #if canImport(Translation) && compiler(>=6.0)
        if #available(iOS 18.0, *), let t = translator as? FreeTranslator {
            t.translate(text, reply: reply)
            return
        }
        #endif
        reply(nil, "Translation needs iOS 18")
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
        if showBrowser { browser.heard(event); return }   // the browser is in front: only its page hears "hello" / "stop"
        if showReader { return }                           // the reader is in front: the video's tutor hears nothing
        let json = AppModel.jsonString(event)
        youtube.evaluateJavaScript("window.__ytcSpeech && window.__ytcSpeech(\(json))", in: nil, in: AppModel.world, completionHandler: nil)
    }

    // ---- messages from the JavaScript in the web views (My tutor's own kinds are answered in Bridge.swift) ----
    func handle(kind: String, body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        switch kind {
        case "speech":
            switch body["op"] as? String {
            case "start":
                // (the Bluetooth headphones' microphone, when the learner turned it on: the sound is set up again)
                let headset = (body["headset"] as? Bool) ?? false
                if headset != AudioSession.headsetMic { AudioSession.headsetMic = headset; if AVAudioSession.sharedInstance().category == .playAndRecord { AudioSession.set(mode: "record", force: true) } }
                speech.start(level: (body["level"] as? NSNumber)?.intValue ?? 3)   // the microphone's sensitivity, 1–3
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
            let one = extras["oneButton"] as? Bool ?? false
            if one != oneButton { oneButton = one }
            let vol = AppModel.volume(in: extras)
            if vol != tutorVolume { tutorVolume = vol }
            let (band, page, video) = AppModel.videoSwitches(extras)
            if band != bandOn { bandOn = band }
            if page != pageOn { pageOn = page }
            if video != videoMode { videoMode = video }
        }
        if area == "local", let settings = obj["drSettings"] {
            let seconds = AppModel.partSeconds(in: settings)
            if seconds != explainSeconds { explainSeconds = seconds }
        }
        tellOtherWindows(obj, area: area, except: web)
    }

    /// the tutor's volume in My tutor's extras, % (60 when not set yet)
    static func volume(in x: [String: Any]) -> Int {
        min(100, max(0, (x["teacherVolume"] as? NSNumber)?.intValue ?? 60))
    }

    // ---- the bar's Volume button: two big buttons, quieter / louder, for 4 s after the last touch ----
    func showVolume() {
        if volumeOpen { volumeOpen = false; return }
        volumeOpen = true
        volumeTouched()
    }

    func volumeStep(_ action: String) {
        volumeTouched()
        dream(action)
    }

    private func volumeTouched() {
        let now = Date()
        volumeTouchedAt = now
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
            if self?.volumeTouchedAt == now { self?.volumeOpen = false }
        }
    }

    // ---- full screen: the page puts the video over the whole window; an iPhone also turns on its side ----
    func fullScreen() {
        let entering = !pageFull
        dream("full")
        guard UIDevice.current.userInterfaceIdiom == .phone,
              let scene = youtube.window?.windowScene else { return }
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: entering ? .landscapeRight : .portrait)) { _ in }
    }

    /// full screen on an iPhone on its side: "More" shows the whole bar again for 6 s
    func peekBar() {
        barPeek = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in self?.barPeek = false }
    }

    /// the two switches of Video mode in My tutor's extras: subtitles on the video, the big page; and the view
    static func videoSwitches(_ x: [String: Any]) -> (band: Bool, page: Bool, video: Bool) {
        ((x["band"] as? String) != "off", x["stageOn"] as? Bool ?? true, (x["view"] as? String ?? "normal") == "normal")
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
        for tell in storageListeners { tell(obj, area, web) }   // the reader, the browser's tabs
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
        controller.addUserScript(WKUserScript(source: deviceScript, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        let source = sheetScripts.map(script).joined(separator: "\n;\n")
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        return config
    }

    /// the page is told which device it is on (iPhone or iPad): the sizes and the layouts follow it
    static var deviceScript: String {
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "pad" : "phone"
        return "window.__ytcDevice='\(device)';"
    }

    static func makeConfig(bridge: Bridge) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []   // the tutor plays the video on by itself
        config.applicationNameForUserAgent = "Version/17.0 Mobile/15E148 Safari/604.1"

        let controller = config.userContentController
        controller.addScriptMessageHandler(bridge, contentWorld: world, name: "ytc")

        controller.addUserScript(WKUserScript(source: deviceScript, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: world))
        // (the page's own world gets one small script and nothing of the app: see page-hooks.js)
        controller.addUserScript(WKUserScript(source: pageScripts.map(script).joined(separator: "\n;\n"), injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        // (the saved settings are read from Store when the page starts: storageAll)
        let source = youtubeScripts.map(script).joined(separator: "\n;\n")
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world))
        return config
    }
}
