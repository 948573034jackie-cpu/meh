import SwiftUI
import WebKit

/// Talks between the two web views (YouTube and the chat), keeps the settings, and does the listening.
final class AppModel: NSObject, ObservableObject, WKNavigationDelegate {
    // ---- settings (same names the Chrome extension uses) ----
    @Published var target: String { didSet { changed("target", target); if oldValue != target { openChat() } } }
    @Published var pauseOn: Bool { didSet { changed("pauseOn", pauseOn) } }
    @Published var replayOn: Bool { didSet { changed("replayOn", replayOn) } }
    @Published var sendTranscript: Bool { didSet { changed("sendTranscript", sendTranscript) } }
    @Published var voiceOn: Bool { didSet { changed("voiceOn", voiceOn) } }
    @Published var textLevel: Double { didSet { changed("textLevel", textLevel) } }
    @Published var tapOn: Bool { didSet { changed("tapOn", tapOn) } }
    @Published var badgeOn: Bool { didSet { changed("badgeOn", badgeOn) } }
    @Published var speakOn: Bool { didSet { defaults.set(speakOn, forKey: "speakOn"); if !speakOn { voice.stop() } } }
    @Published var listening = false     // the microphone is open for your question
    @Published var speaking = false      // the app is reading an answer aloud

    @Published var layoutIndex = 0
    @Published var toast: String?

    let youtube: WKWebView
    let chat: WKWebView
    static let world = WKContentWorld.world(name: "ytc")

    private let speech = SpeechListener()
    private let voice = Voice()
    private var dictating = false
    private var dictated = ""
    private var dictationTimer: Timer?
    private var answerToken = 0
    private let bridge: Bridge
    private var started = false
    private var jsLogs: [String] = []
    private var selfTestReport: [String: Any] = [:]
    private let defaults = UserDefaults.standard

    /// The AI (chat) window sits under the video. It starts as a small strip; the button cycles
    /// small strip -> half -> big. The video gets the rest of the height.
    func chatLength(in size: CGSize) -> CGFloat {
        switch layoutIndex % 3 {
        case 0: return 96
        case 1: return size.height * 0.45
        default: return size.height * 0.75
        }
    }
    func videoLength(in size: CGSize) -> CGFloat {
        max(120, size.height - chatLength(in: size) - 1)
    }

    override init() {
        let d = UserDefaults.standard
        let target = d.string(forKey: "target") ?? "claude"
        let pauseOn = d.object(forKey: "pauseOn") as? Bool ?? true
        let replayOn = d.object(forKey: "replayOn") as? Bool ?? true
        let sendTranscript = d.object(forKey: "sendTranscript") as? Bool ?? true
        let voiceOn = d.object(forKey: "voiceOn") as? Bool ?? true
        if !d.bool(forKey: "textLevelMigrated2") { d.set(7.5, forKey: "textLevel"); d.set(true, forKey: "textLevelMigrated2") }
        let textLevel = d.object(forKey: "textLevel") as? Double ?? 7.5
        let tapOn = d.object(forKey: "tapOn") as? Bool ?? true
        let badgeOn = d.object(forKey: "badgeOn") as? Bool ?? true
        let speakOn = d.object(forKey: "speakOn") as? Bool ?? true

        self.target = target
        self.pauseOn = pauseOn
        self.replayOn = replayOn
        self.sendTranscript = sendTranscript
        self.voiceOn = voiceOn
        self.textLevel = textLevel
        self.tapOn = tapOn
        self.badgeOn = badgeOn
        self.speakOn = speakOn

        let bridge = Bridge()
        self.bridge = bridge
        let storage: [String: Any] = [
            "target": target, "pauseOn": pauseOn, "replayOn": replayOn,
            "sendTranscript": sendTranscript, "voiceOn": voiceOn, "textLevel": textLevel,
            "tapOn": tapOn, "badgeOn": badgeOn, "barOn": false, "sendOn": true
        ]
        self.youtube = WKWebView(frame: .zero, configuration: AppModel.makeConfig(bridge: bridge, isYouTube: true, storage: storage))
        self.chat = WKWebView(frame: .zero, configuration: AppModel.makeConfig(bridge: bridge, isYouTube: false, storage: storage))
        super.init()

        bridge.model = self
        youtube.navigationDelegate = self
        chat.navigationDelegate = self
        youtube.allowsBackForwardNavigationGestures = true
        chat.allowsBackForwardNavigationGestures = true

        speech.onText = { [weak self] text in
            guard let self = self else { return }
            if self.dictating { self.heardQuestion(text); return }
            if self.voice.isSpeaking { return }   // do not listen to our own voice
            self.sendSpeech(["type": "result", "text": text])
        }
        speech.onEnd = { [weak self] reason in
            guard let self = self else { return }
            if self.dictating {
                if reason != nil { self.cancelDictation(); self.show("The microphone is not allowed. Settings > YT Learn > allow Microphone and Speech Recognition.") }
                else { self.finishDictation() }
                return
            }
            if let reason = reason { self.sendSpeech(["type": "error", "error": reason]) }
            self.sendSpeech(["type": "end"])
        }
        voice.onChange = { [weak self] on in DispatchQueue.main.async { self?.speaking = on } }
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

        Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in self?.writeSelfTestReport() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self = self else { return }
            self.voice.speak("This is a test of the voice. **Hello** [link](https://example.com) there.")
            self.selfTestReport["voiceCleaned"] = Voice.clean("This is a test of the voice. **Hello** [link](https://example.com) there.")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.selfTestReport["voiceSpeaking"] = self.voice.isSpeaking; self.voice.stop() }
        }
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
              const bd = document.getElementById('yt2c-badge');
              out.badge = bd ? bd.textContent : null;
              const hitEl = document.elementFromPoint(rect.left + rect.width * 0.5, rect.top + rect.height * 0.45);
              out.tapLayerHit = hitEl ? (hitEl.id || hitEl.tagName) : null;
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
            const r = await window.__ytcDeliver({ type: 'chat-send', text: 'REALTEXT', dryRun: DRYRUN });
            return { url: location.href, title: document.title, result: r };
            """
            let real = ProcessInfo.processInfo.arguments.contains("-selftest-send")
            let chatScript = chatTest
                .replacingOccurrences(of: "DRYRUN", with: real ? "false" : "true")
                .replacingOccurrences(of: "REALTEXT", with: real ? "Hello! This is an automatic test of my own app. Please reply with just the word OK." : "self test message")
            self.chat.callAsyncJavaScript(chatScript, arguments: [:], in: nil, in: AppModel.world) { result in
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
        report["frames"] = [
            "youtube": NSCoder.string(for: youtube.frame), "chat": NSCoder.string(for: chat.frame),
            "youtubeContainer": NSCoder.string(for: youtube.superview?.frame ?? .zero),
            "chatContainer": NSCoder.string(for: chat.superview?.frame ?? .zero),
            "window": NSCoder.string(for: youtube.window?.frame ?? .zero),
            "screen": NSCoder.string(for: UIScreen.main.bounds),
            "safeArea": NSCoder.string(for: youtube.window?.safeAreaInsets ?? .zero)
        ]
        report["writtenAt"] = ISO8601DateFormatter().string(from: Date())
        report["chatUrlNow"] = chat.url?.absoluteString ?? "-"
        report["youtubeUrlNow"] = youtube.url?.absoluteString ?? "-"
        guard JSONSerialization.isValidJSONObject(report),
              let data = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted]),
              let dir = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first else { return }
        try? data.write(to: URL(fileURLWithPath: dir).appendingPathComponent("selftest.json"))
    }

    func goHome() {
        if let url = URL(string: "https://m.youtube.com/") { youtube.load(URLRequest(url: url)) }
    }

    func openChat() {
        let address = target == "chatgpt" ? "https://chatgpt.com/" : "https://claude.ai/new"
        if let url = URL(string: address) { chat.load(URLRequest(url: url)) }
    }

    // ---- talking with the AI: tap the microphone, say your question, hear the answer ----
    func micTapped() {
        if listening { finishDictation(); return }
        voice.stop()
        dictating = true
        dictated = ""
        listening = true
        speech.stop()
        sendSpeech(["type": "end"])          // the "let's go" listener steps aside for a moment
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            guard let self = self, self.dictating else { return }
            self.speech.start()
            self.show("Listening… say your question.")
            self.restartDictationTimer(seconds: 8)   // if you say nothing it stops after 8 s
        }
    }

    private func heardQuestion(_ text: String) {
        dictated = text
        restartDictationTimer(seconds: 1.8)          // 1.8 s of quiet = you finished
    }

    private func restartDictationTimer(seconds: TimeInterval) {
        dictationTimer?.invalidate()
        dictationTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in self?.finishDictation() }
    }

    private func cancelDictation() {
        dictationTimer?.invalidate()
        dictating = false
        listening = false
    }

    private func finishDictation() {
        guard dictating else { return }
        let question = dictated.trimmingCharacters(in: .whitespacesAndNewlines)
        cancelDictation()
        speech.stop()
        sendSpeech(["type": "end"])              // the "let's go" listener starts again
        if question.split(separator: " ").count < 2 { show("I did not hear a question. Tap the microphone and try again."); return }
        show("Asking: \(question)")
        youtube.callAsyncJavaScript(
            "return await chrome.runtime.sendMessage({type: 'ask', text: text, target: target});",
            arguments: ["text": question, "target": target], in: nil, in: AppModel.world
        ) { [weak self] result in
            DispatchQueue.main.async {
                switch result {
                case .success(let value):
                    if let dict = value as? [String: Any], let text = dict["result"] as? String, !text.hasPrefix("Sent") { self?.show(text) }
                case .failure(let error): self?.show("Could not ask: \(error.localizedDescription)")
                }
            }
        }
    }

    /// After a message went into the chat: wait until the AI has finished its answer, then read it aloud.
    private func followAnswer(baseline: Int) {
        guard speakOn else { return }
        answerToken += 1
        let token = answerToken
        var lastText = ""
        var stable = 0
        func poll(_ round: Int) {
            if token != answerToken { return }                 // a newer message took over
            if round > 130 { return }                          // about 2.5 minutes
            chat.callAsyncJavaScript("return window.__ytcReplyState ? window.__ytcReplyState() : null;", arguments: [:], in: nil, in: AppModel.world) { [weak self] result in
                DispatchQueue.main.async {
                    guard let self = self, token == self.answerToken else { return }
                    var done = false
                    if case .success(let value) = result, let st = value as? [String: Any],
                       let count = st["count"] as? Int, let text = st["text"] as? String, let busy = st["busy"] as? Bool {
                        if count > baseline && !text.isEmpty {
                            if text == lastText { stable += 1 } else { stable = 0; lastText = text }
                            // finished: it stopped growing (and the "stop" button is gone, or nothing changed for 4 checks)
                            if (!busy && stable >= 2) || stable >= 4 { done = true }
                        }
                    }
                    if done {
                        // read it aloud only while the video is stopped (not over the video's own sound)
                        self.youtube.callAsyncJavaScript("const v = document.querySelector('video'); return !v || v.paused;", arguments: [:], in: nil, in: AppModel.world) { r in
                            DispatchQueue.main.async {
                                guard token == self.answerToken else { return }
                                var stopped = true
                                if case .success(let v) = r, let b = v as? Bool { stopped = b }
                                if stopped { self.show("Reading the answer…"); self.voice.speak(lastText) }
                                else { self.show("The answer is ready. Tap AI to read it.") }
                            }
                        }
                    } else {
                        if round == 30 && lastText.isEmpty { self.show("I cannot read the answer from this page. Tap AI to read it there.") }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { poll(round + 1) }
                    }
                }
            }
        }
        poll(0)
    }

    // ---- toolbar actions ----
    func cycleLayout() { layoutIndex = (layoutIndex + 1) % 3 }

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
            let startPath = chat.url?.path ?? ""
            var answered = false
            let finish: (Any?, String?) -> Void = { value, error in
                if answered { return }
                answered = true
                reply(value, error)
            }
            let msgDict = msg as? [String: Any]
            let isChatSend = (msgDict?["type"] as? String) == "chat-send"
            let sentText = msgDict?["text"] as? String ?? ""
            let readAnswer = isChatSend && !sentText.contains("just reply \"Ready\"")   // the plain "Send video" button only says Ready
            var baseline = 0
            let deliver = {
                self.chat.callAsyncJavaScript("return await window.__ytcDeliver(msg);", arguments: ["msg": msg], in: nil, in: AppModel.world) { result in
                    DispatchQueue.main.async {
                        switch result {
                        case .success(let value):
                            if readAnswer, let d = value as? [String: Any], (d["ok"] as? Bool) == true { self.followAnswer(baseline: baseline) }
                            finish(value, nil)
                        case .failure(let error): finish(nil, "chat page not ready: \(error.localizedDescription)")
                        }
                    }
                }
            }
            if readAnswer {
                self.chat.callAsyncJavaScript("return window.__ytcReplyState ? window.__ytcReplyState().count : 0;", arguments: [:], in: nil, in: AppModel.world) { result in
                    DispatchQueue.main.async {
                        if case .success(let v) = result, let n = v as? Int { baseline = n }
                        deliver()
                    }
                }
            } else { deliver() }
            // A page that jumps to a new address right after "Send" can lose the answer. Then the move itself
            // (a fresh chat turning into /c/... or /chat/...) is the proof that the message was sent.
            func watch(_ round: Int) {
                if answered { return }
                let path = self.chat.url?.path ?? ""
                if (startPath == "/" || startPath == "/new") && path != "/" && path != "/new" {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        if !answered && readAnswer { self.followAnswer(baseline: 0) }
                        finish(["ok": true, "steps": ["message sent (the page moved on to a new chat)"]], nil)
                    }
                    return
                }
                if round >= 40 { finish(nil, "the chat page did not answer within 60 seconds"); return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { watch(round + 1) }
            }
            watch(0)

        case "navigateChat":
            if let text = body["url"] as? String, let url = URL(string: text) { chat.load(URLRequest(url: url)) }
            reply(nil, nil)

        case "storageSet":
            if let obj = body["obj"] as? [String: Any] {
                for (key, value) in obj { defaults.set(value, forKey: key) }
            }
            reply(nil, nil)

        case "voice":
            if (body["op"] as? String) == "stop" { voice.stop() }
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

    // ---- navigation events (kept for the automatic test report) ----
    private func navLog(_ event: String, _ webView: WKWebView, _ error: Error? = nil) {
        guard jsLogs.count < 120 else { return }
        let who = webView === chat ? "chat" : "youtube"
        jsLogs.append("nav \(event) \(who) \(webView.url?.absoluteString ?? "-")" + (error.map { " error: \($0.localizedDescription)" } ?? ""))
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { navLog("start", webView) }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { navLog("commit", webView) }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { navLog("finish", webView) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { navLog("fail", webView, error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { navLog("failProvisional", webView, error) }

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
