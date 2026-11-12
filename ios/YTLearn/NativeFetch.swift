import Foundation
import WebKit

/// fetch() for My tutor's AI and voice services, done by URLSession (no CORS, no limits of the YouTube page).
/// The page (shim-dream.js) gets the status and headers as the answer to its message, then the body in pieces through
/// `window.__ytcFetchChunk(id, base64)` and `window.__ytcFetchEnd(id, error)`: a streamed answer (the AI writing) arrives
/// while it is written. Only the services' own addresses are allowed.
final class NativeFetch: NSObject, URLSessionDataDelegate {
    static let shared = NativeFetch()

    static func allowed(_ url: URL) -> Bool {
        guard url.scheme == "https", let host = url.host?.lowercased() else { return false }
        // (+ lrclib.net and api.lyrics.ovh: the lyrics of lyrics mode; api.github.com and gist.githubusercontent.com: the online vocabulary)
        return ["api.anthropic.com", "api.openai.com", "api.elevenlabs.io", "lrclib.net", "api.lyrics.ovh", "api.github.com", "gist.githubusercontent.com"].contains(host) || host.hasSuffix(".tts.speech.microsoft.com")
    }

    private final class Job {
        let id: Int
        weak var web: WKWebView?
        let world: WKContentWorld
        var reply: ((Any?, String?) -> Void)?
        init(id: Int, web: WKWebView?, world: WKContentWorld, reply: @escaping (Any?, String?) -> Void) {
            self.id = id; self.web = web; self.world = world; self.reply = reply
        }
    }
    private var jobs: [Int: Job] = [:]                 // by URLSession task
    private var tasks: [String: URLSessionDataTask] = [:] // by web view + the page's id (to cancel)

    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 60
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        return URLSession(configuration: c, delegate: self, delegateQueue: .main)
    }()

    private func key(_ web: WKWebView?, _ id: Int) -> String {
        "\(web.map { ObjectIdentifier($0).hashValue } ?? 0):\(id)"
    }

    func run(_ body: [String: Any], web: WKWebView?, world: WKContentWorld, reply: @escaping (Any?, String?) -> Void) {
        guard let id = (body["id"] as? NSNumber)?.intValue, let text = body["url"] as? String,
              let url = URL(string: text), NativeFetch.allowed(url) else { reply(nil, "address not allowed"); return }
        var req = URLRequest(url: url)
        req.httpMethod = body["method"] as? String ?? "GET"
        for (k, v) in body["headers"] as? [String: Any] ?? [:] { req.setValue("\(v)", forHTTPHeaderField: k) }
        if let b64 = body["body"] as? String, let data = Data(base64Encoded: b64) { req.httpBody = data }
        let task = session.dataTask(with: req)
        jobs[task.taskIdentifier] = Job(id: id, web: web, world: world, reply: reply)
        tasks[key(web, id)] = task
        task.resume()
    }

    func cancel(_ body: [String: Any], web: WKWebView?) {
        guard let id = (body["id"] as? NSNumber)?.intValue else { return }
        tasks[key(web, id)]?.cancel()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let job = jobs[dataTask.taskIdentifier] else { completionHandler(.cancel); return }
        let http = response as? HTTPURLResponse
        var headers: [String: String] = [:]
        for (k, v) in http?.allHeaderFields ?? [:] {
            guard let name = (k as? String)?.lowercased() else { continue }
            // URLSession already unpacked the body: its packed length / encoding no longer apply
            if ["content-encoding", "content-length", "transfer-encoding", "connection"].contains(name) { continue }
            headers[name] = "\(v)"
        }
        let head: [String: Any] = ["status": http?.statusCode ?? 200, "statusText": "", "headers": headers]
        job.reply?(head, nil)
        job.reply = nil
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let job = jobs[dataTask.taskIdentifier] else { return }
        job.web?.callAsyncJavaScript("window.__ytcFetchChunk && window.__ytcFetchChunk(id, b64)",
                                     arguments: ["id": job.id, "b64": data.base64EncodedString()], in: nil, in: job.world, completionHandler: nil)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let job = jobs.removeValue(forKey: task.taskIdentifier) else { return }
        tasks.removeValue(forKey: key(job.web, job.id))
        if let reply = job.reply { reply(nil, error?.localizedDescription ?? "no answer"); return }
        let message: Any = error?.localizedDescription ?? NSNull()
        job.web?.callAsyncJavaScript("window.__ytcFetchEnd && window.__ytcFetchEnd(id, error)",
                                     arguments: ["id": job.id, "error": message], in: nil, in: job.world, completionHandler: nil)
    }
}
