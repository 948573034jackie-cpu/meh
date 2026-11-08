import Foundation
import WebKit

/// Receives the messages of the JavaScript in the app's web views (window.webkit.messageHandlers.ytc.postMessage)
/// and answers them: the answer becomes the JavaScript Promise's result. My tutor's kinds are answered here;
/// the old mode's (the chat window, tabs, speech, …) go to AppModel.handle.
/// One Bridge per JavaScript world: the YouTube and chat windows run the scripts in the private "ytc" world,
/// the settings sheet in the page itself.
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var model: AppModel?
    let world: WKContentWorld

    init(world: WKContentWorld) {
        self.world = world
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let model = model, let body = message.body as? [String: Any], let kind = body["kind"] as? String else {
            replyHandler(nil, nil)
            return
        }
        let web = message.webView
        DispatchQueue.main.async { self.handle(kind, body, model: model, web: web, reply: replyHandler) }
    }

    private func handle(_ kind: String, _ body: [String: Any], model: AppModel, web: WKWebView?, reply: @escaping (Any?, String?) -> Void) {
        let area = body["area"] as? String ?? "local"
        switch kind {
        // ---- storage (Store.swift) ----
        case "storageAll":
            reply(model.storageAll(area: area), nil)
        case "storageSet":
            model.storageSet(area: area, json: body["json"] as? String ?? "{}", from: web)
            reply(nil, nil)
        case "storageRemove":
            model.storageRemove(area: area, keys: body["keys"] as? [String] ?? [], from: web)
            reply(nil, nil)
        // ---- the API keys (Keys.swift) ----
        case "keychainGet":
            reply(Keys.get(body["name"] as? String ?? ""), nil)
        case "keychainSet":
            let name = body["name"] as? String ?? ""
            let value = body["value"] as? String
            Keys.set(name, value)
            model.keysChanged(name: name, value: value, from: web)
            reply(nil, nil)
        // ---- the AI and voice services (NativeFetch.swift); the app's own files (SchemeHandler.swift) ----
        case "nativeFetch":
            NativeFetch.shared.run(body, web: web, world: world, reply: reply)
        case "nativeFetchCancel":
            NativeFetch.shared.cancel(body, web: web)
            reply(nil, nil)
        case "resource":
            reply(SchemeHandler.resource(body["path"] as? String ?? ""), nil)
        // ---- the iOS voice (TutorVoice in Voice.swift) ----
        case "voices":
            reply(TutorVoice.voices(), nil)
        case "speak":
            model.tutorVoice.speak(body, web: web, world: world)
            reply(nil, nil)
        case "speakStop":
            model.tutorVoice.stop()
            reply(nil, nil)
        case "speakPause":
            model.tutorVoice.pause()
            reply(nil, nil)
        case "speakResume":
            model.tutorVoice.resume()
            reply(nil, nil)
        case "audioSession":
            AudioSession.set(mode: body["mode"] as? String ?? "play")
            reply(nil, nil)
        // ---- free mode: a sentence in Chinese by Apple's Translation (Translator.swift) ----
        case "translate":
            model.translate(body["text"] as? String ?? "", reply: reply)
        // ---- My tutor's pages: settings, My Vocabulary (a sheet of the app) ----
        case "openPage":
            model.openPage(body["url"] as? String ?? "")
            reply(nil, nil)
        default:
            model.handle(kind: kind, body: body, reply: reply)
        }
    }
}
