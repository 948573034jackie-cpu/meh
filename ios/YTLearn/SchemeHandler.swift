import Foundation
import WebKit

/// The app's own files at ytlearn://app/<path>, from the `Web` folder in the app: the dictionary (dream/dict.json.gz)
/// and My tutor's settings and vocabulary pages (dream/options.html, dream/vocab.html, their scripts and styles).
/// The settings sheet loads its page from here; the YouTube page gets the same files through the bridge ("resource").
final class SchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "ytlearn"

    static func fileURL(_ path: String) -> URL? {
        guard let base = Bundle.main.resourceURL?.appendingPathComponent("Web", isDirectory: true) else { return nil }
        let parts = path.split(separator: "/").filter { $0 != ".." && $0 != "." && !$0.isEmpty }
        guard !parts.isEmpty else { return nil }
        let url = base.appendingPathComponent(parts.joined(separator: "/"))
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    static func mime(_ url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "gz": return "application/gzip"
        case "txt": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }

    /// For the bridge: { b64, mime } or nil
    static func resource(_ path: String) -> [String: Any]? {
        guard let url = fileURL(path), let data = try? Data(contentsOf: url) else { return nil }
        return ["b64": data.base64EncodedString(), "mime": mime(url)]
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "app", let file = SchemeHandler.fileURL(url.path),
              let data = try? Data(contentsOf: file),
              let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                             headerFields: ["Content-Type": SchemeHandler.mime(file), "Content-Length": "\(data.count)", "Cache-Control": "no-cache"])
        else { task.didFailWithError(URLError(.fileDoesNotExist)); return }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
