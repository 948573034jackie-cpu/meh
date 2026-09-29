import SwiftUI
import WebKit

/// Talks between the two web views (YouTube and the chat), keeps the settings, and does the listening.
final class AppModel: NSObject, ObservableObject {
    // ---- settings (same names the Chrome extension uses) ----
    @Published var target: String { didSet { changed("target", target); if oldValue != target { openChat() } } }
    @Published var pauseOn: Bool { didSet { changed("pauseOn", pauseOn) } }
    @Published var replayOn: Bool { didSet { changed("replayOn", replayOn) } }
    @Published var sendTranscript: Bool { didSet { changed("sendTranscript", sendTranscript) } }
    @Published var voiceOn: Bool { didSet { changed("voiceOn", voiceOn) } }
    @Published var textLevel: Double { didSet { changed("textLevel", textLevel) } }

    @Published var layoutIndex = 0
    @Published var toast: String?

    let youtube: WKWebView
    let chat: WKWebView
    static let world = WKContentWorld.world(name: "ytc")

    private let speech = SpeechListener()
    private let bridge: Bridge
    private var started = false
    private var jsLogs: [String] = []
    private var selfTestReport: [String: Any] = [:]
    private let defaults = UserDefaults.standard

    /// Share of the screen used by the video, for each layout the layout button cycles through.
    private let shares: [CGFloat] = [0.45, 0.75, 0.2]
    var videoShare: CGFloat { shares[layoutIndex % shares.count] }

    override init() {
        let d = UserDefaults.standard
        let target = d.string(forKey: "target") ?? "claude"
        let pauseOn = d.object(forKey: "pauseOn") as? Bool ?? true
        let replayOn = d.object(forKey: "replayOn") as? Bool ?? true
        let sendTranscript = d.object(forKey: "sendTranscript") as? Bool ?? true
        let voiceOn = d.object(forKey: "voiceOn") as? Bool ?? true
        let textLevel = d.object(forKey: "textLevel") as? Double ?? 6.0

        self.target = target
        self.pauseOn = pauseOn
        self.replayOn = replayOn
        self.sendTranscript = sendTranscript
        self.voiceOn = voiceOn
        self.textLevel = textLevel

        let bridge = Bridge()
        self.bridge = bridge
        let storage: [String: Any] = [
            "target": target, "pauseOn": pauseOn, "replayOn": replayOn,
            "sendTranscript": sendTranscript, "voiceOn": voiceOn, "textLevel": textLevel
        ]
        self.youtube = WKWebView(frame: .zero, configuration: AppModel.makeConfig(bridge: bridge, isYouTube: true, storage: storage))
        self.chat = WKWebView(frame: .zero, configuration: AppModel.makeConfig(bridge: bridge, isYouTube: false, storage: storage))
        super.init()

        bridge.model = self
        youtube.allowsBackForwardNavigationGestures = true
        chat.allowsBackForwardNavigationGestures = true

        speech.onText = { [weak self] text in self?.sendSpeech(["type": "result", "text": text]) }
        speech.onEnd = { [weak self] reason in
            if let reason = reason { self?.sendSpeech(["type": "error", "error": reason]) }
            self?.sendSpeech(["type": "end"])
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
        openChat()
    }

    // ---- automatic test (used by the build server: launch the app with the argument -selftest) ----
    private func runSelfTest() {
        selfTestReport = ["ios": UIDevice.current.systemVersion, "device": UIDevice.current.model]
        if let url = URL(string: "https://m.youtube.com/watch?v=iG9CE55wbtY") { youtube.load(URLRequest(url: url)) }
        if let url = URL(string: "https://chatgpt.com/") { chat.load(URLRequest(url: url)) }

        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self = self else { return }
            let ytTest = """
            const out = { url: location.href };
            const v = document.querySelector('video');
            out.hasVideo = !!v;
            out.hasChromeShim = !!(window.chrome && window.chrome.__ytc);
            out.pageText = (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 240);
            try {
              const html = await (await fetch(location.href, { credentials: 'include' })).text();
              const pr = window.YTC.extractPlayerResponse(html);
              out.htmlLength = html.length;
              out.playability = pr && pr.playabilityStatus ? { status: pr.playabilityStatus.status, reason: pr.playabilityStatus.reason } : null;
              out.captionTracks = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer ? (pr.captions.playerCaptionsTracklistRenderer.captionTracks || []).length : 0;
            } catch (e) { out.htmlError = String(e); }
            try { out.transcript = await window.__ytcDebug.load(); } catch (e) { out.transcriptError = String(e); }
            if (v) {
              v.muted = true;
              try { await Promise.race([v.play(), new Promise(r => setTimeout(r, 5000))]); } catch (e) { out.playError = String(e); }
              await new Promise(r => setTimeout(r, 2000));
              v.currentTime = Math.min(40, (v.duration || 90) / 3);
              await new Promise(r => setTimeout(r, 1500));
              v.pause();
              await new Promise(r => setTimeout(r, 3500));
              const o = document.getElementById('yt2c-overlay');
              const b = document.getElementById('yt2c-body');
              out.overlay = o ? { text: b.innerText.slice(0, 200), font: getComputedStyle(b).fontSize, w: o.clientWidth, h: o.clientHeight } : null;
              out.videoState = { t: v.currentTime, paused: v.paused };
              const rect = v.getBoundingClientRect();
              out.videoRect = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)];
              const chain = [];
              for (let n = v.parentElement, i = 0; n && i < 5; n = n.parentElement, i++) chain.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && n.className.baseVal === undefined ? '.' + String(n.className).split(' ')[0] : '') + ' ' + n.clientWidth + 'x' + n.clientHeight);
              out.videoAncestors = chain;
              out.overlayPosition = o ? getComputedStyle(o).position : null;
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
            let chatTest = """
            const r = await window.__ytcDeliver({ type: 'chat-send', text: 'self test message', dryRun: true });
            return { url: location.href, title: document.title, result: r };
            """
            self.chat.callAsyncJavaScript(chatTest, arguments: [:], in: nil, in: AppModel.world) { result in
                DispatchQueue.main.async {
                    switch result {
                    case .success(let value): self.selfTestReport["chat"] = value
                    case .failure(let error): self.selfTestReport["chatError"] = error.localizedDescription
                    }
                    self.writeSelfTestReport()
                }
            }
        }
    }

    private func writeSelfTestReport() {
        var report = selfTestReport
        report["jsLogs"] = jsLogs
        report["writtenAt"] = ISO8601DateFormatter().string(from: Date())
        guard JSONSerialization.isValidJSONObject(report),
              let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted]),
              let dir = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first else { return }
        try? data.write(to: URL(fileURLWithPath: dir).appendingPathComponent("selftest.json"))
    }

    func goHome() {
        let host = UIDevice.current.userInterfaceIdiom == .pad ? "www.youtube.com" : "m.youtube.com"
        if let url = URL(string: "https://\(host)/") { youtube.load(URLRequest(url: url)) }
    }

    func openChat() {
        let address = target == "chatgpt" ? "https://chatgpt.com/" : "https://claude.ai/new"
        if let url = URL(string: address) { chat.load(URLRequest(url: url)) }
    }

    // ---- toolbar actions ----
    func cycleLayout() { layoutIndex = (layoutIndex + 1) % shares.count }

    func pasteLink() {
        let text = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let url = URL(string: text), let host = url.host, host.contains("youtube.com") || host.contains("youtu.be") {
            youtube.load(URLRequest(url: url))
        } else {
            show("Copy a YouTube link first, then tap this button.")
        }
    }

    /// The same as the "Send this video" button of the Chrome extension.
    func sendVideoNow() {
        youtube.callAsyncJavaScript(
            "return await chrome.runtime.sendMessage({type: 'send', target: target});",
            arguments: ["target": target], in: nil, in: AppModel.world
        ) { [weak self] result in
            DispatchQueue.main.async {
                switch result {
                case .success(let value):
                    if let dict = value as? [String: Any], let text = dict["result"] as? String {
                        self?.show(text)
                    } else {
                        self?.show("No answer. Open a YouTube video first.")
                    }
                case .failure(let error):
                    self?.show("Error: \(error.localizedDescription)")
                }
            }
        }
    }

    func show(_ text: String) {
        toast = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 7) { [weak self] in
            if self?.toast == text { self?.toast = nil }
        }
    }

    // ---- settings -> saved + pushed into the YouTube page ----
    private func changed(_ key: String, _ value: Any) {
        defaults.set(value, forKey: key)
        let json = AppModel.jsonString([key: value])
        youtube.evaluateJavaScript("window.__ytcStorageChanged && window.__ytcStorageChanged(\(json))", in: nil, in: AppModel.world, completionHandler: nil)
    }

    private func sendSpeech(_ event: [String: Any]) {
        let json = AppModel.jsonString(event)
        youtube.evaluateJavaScript("window.__ytcSpeech && window.__ytcSpeech(\(json))", in: nil, in: AppModel.world, completionHandler: nil)
    }

    // ---- messages from the JavaScript in the web views ----
    func handle(kind: String, body: [String: Any], reply: @escaping (Any?, String?) -> Void) {
        switch kind {
        case "chatInfo":
            reply(["url": chat.url?.absoluteString ?? ""], nil)

        case "tabsSend":
            guard let msg = body["msg"] else { reply(nil, "no message"); return }
            chat.callAsyncJavaScript("return await window.__ytcDeliver(msg);", arguments: ["msg": msg], in: nil, in: AppModel.world) { result in
                switch result {
                case .success(let value): reply(value, nil)
                case .failure(let error): reply(nil, "chat page not ready: \(error.localizedDescription)")
                }
            }

        case "navigateChat":
            if let text = body["url"] as? String, let url = URL(string: text) { chat.load(URLRequest(url: url)) }
            reply(nil, nil)

        case "storageSet":
            if let obj = body["obj"] as? [String: Any] {
                for (key, value) in obj { defaults.set(value, forKey: key) }
            }
            reply(nil, nil)

        case "speech":
            if (body["op"] as? String) == "start" { speech.start() } else { speech.stop() }
            reply(nil, nil)

        case "log":
            if jsLogs.count < 80 { jsLogs.append((body["text"] as? String ?? "").prefix(300).description) }
            reply(nil, nil)

        default:
            reply(nil, nil)
        }
    }

    // ---- helpers ----
    static func jsonString(_ object: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        return text
    }

    static func script(_ name: String) -> String {
        guard let url = Bundle.main.url(forResource: name, withExtension: "js"),
              let text = try? String(contentsOf: url, encoding: .utf8) else { return "/* missing \(name).js */" }
        return text
    }

    static func makeConfig(bridge: Bridge, isYouTube: Bool, storage: [String: Any]) -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []   // lets the replay start by itself
        config.applicationNameForUserAgent = "Version/17.0 Mobile/15E148 Safari/604.1"

        let controller = config.userContentController
        controller.addScriptMessageHandler(bridge, contentWorld: world, name: "ytc")

        var source: String
        if isYouTube {
            source = "window.__ytcStorageInit = \(jsonString(storage));\n"
            source += ["shim-common", "shim-youtube", "lib", "background", "youtube"].map(script).joined(separator: "\n;\n")
        } else {
            source = ["shim-common", "shim-chat", "chat"].map(script).joined(separator: "\n;\n")
        }
        controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: world))
        return config
    }
}

/// Receives messages from the JavaScript and answers them (the answer becomes a JavaScript Promise result).
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var model: AppModel?

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let model = model, let body = message.body as? [String: Any], let kind = body["kind"] as? String else {
            replyHandler(nil, nil)
            return
        }
        DispatchQueue.main.async {
            model.handle(kind: kind, body: body, reply: replyHandler)
        }
    }
}
