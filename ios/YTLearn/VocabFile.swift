import Foundation

/// The vocabulary database as a file (vocabulary.json, the same document the Mac's Chrome writes), so the MacBook and
/// this phone share one database. The tutor's JavaScript talks to it like to the Mac helper (chrome.runtime.sendNativeMessage,
/// shim-dream.js): "read" gives the file of the shared folder (the tutor merges it with its own words), "write" writes
/// the merged document there and to the app's own copy (Files ▸ On My iPhone ▸ YT Learn ▸ vocabulary.json).
/// The shared place is one you picked in the Files app: the folder iCloud Drive ▸ MEH English, or (where the Files
/// app does not let a folder be chosen, as with Google Drive) the file vocabulary.json itself. A security-scoped
/// bookmark remembers it. Everything runs on one background queue (iCloud may have to download the file).
final class VocabFile {
    static let shared = VocabFile()
    static let name = "vocabulary.json"
    private static let bookmarkKey = "vocabFolderBookmark"
    private static let folderNameKey = "vocabFolderName"
    private static let isFileKey = "vocabBookmarkIsFile"
    /// one request at a time, off the main thread
    let queue = DispatchQueue(label: "local.ytlearn.vocabfile")
    private(set) var statusText = ""
    private(set) var lastError: String?

    /// the name of the shared folder, or nil (the words stay in the app)
    var folderName: String? { UserDefaults.standard.string(forKey: VocabFile.folderNameKey) }

    /// the app's own copy (visible in the Files app)
    static var localURL: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent(name)
    }

    /// remember the folder you picked, or the vocabulary.json file itself (nil = forget it)
    func setFolder(_ url: URL?, isFile: Bool = false) {
        let d = UserDefaults.standard
        guard let url = url else {
            d.removeObject(forKey: VocabFile.bookmarkKey)
            d.removeObject(forKey: VocabFile.folderNameKey)
            d.removeObject(forKey: VocabFile.isFileKey)
            return
        }
        d.set(isFile, forKey: VocabFile.isFileKey)
        let ok = url.startAccessingSecurityScopedResource()
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        if let data = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            d.set(data, forKey: VocabFile.bookmarkKey)
            d.set(isFile ? url.deletingLastPathComponent().lastPathComponent + " ▸ " + url.lastPathComponent : url.lastPathComponent, forKey: VocabFile.folderNameKey)
        }
    }

    private var isFile: Bool { UserDefaults.standard.bool(forKey: VocabFile.isFileKey) }
    /// the shared file inside what was picked
    private func fileURL(in picked: URL) -> URL { isFile ? picked : picked.appendingPathComponent(VocabFile.name) }

    /// the shared folder (or file), from its bookmark (nil = none chosen, or it is gone)
    private func folderURL() -> URL? {
        guard let data = UserDefaults.standard.data(forKey: VocabFile.bookmarkKey) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return nil }
        if stale, url.startAccessingSecurityScopedResource() {
            if let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
                UserDefaults.standard.set(fresh, forKey: VocabFile.bookmarkKey)
            }
            url.stopAccessingSecurityScopedResource()
        }
        return url
    }

    /// what the tutor's JavaScript asked: the Mac helper's messages (ping / read / write), answered the same way
    func handle(_ msg: [String: Any]) -> [String: Any] {
        let type = msg["type"] as? String ?? ""
        let folder = folderURL()
        var out: [String: Any] = ["ok": true, "path": VocabFile.localURL.path, "phone": true, "shared": folder != nil]
        if let n = folderName { out["folder"] = n }
        if let f = folder { out["sharedPath"] = fileURL(in: f).path }
        switch type {
        case "ping":
            return out
        case "read":
            var docs: [Any] = []
            if let folder = folder, let doc = readShared(folder) { docs.append(doc) }
            out["docs"] = docs
            if let e = lastError { out["sharedError"] = e }
            return out
        case "write":
            guard let doc = msg["doc"] as? [String: Any], JSONSerialization.isValidJSONObject(doc),
                  let data = try? JSONSerialization.data(withJSONObject: doc, options: [.prettyPrinted]) else {
                return ["ok": false, "error": "no document to write"]
            }
            do { try data.write(to: VocabFile.localURL, options: [.atomic]) }
            catch { return ["ok": false, "error": "the app's copy could not be written: \(error.localizedDescription)"] }
            let when = DateFormatter.localizedString(from: Date(), dateStyle: .short, timeStyle: .short)
            if let folder = folder {
                if writeShared(folder, data) {
                    out["sharedOk"] = true
                    statusText = "Saved \(when) in “\(folderName ?? "the shared folder")”"
                } else {
                    out["sharedOk"] = false
                    out["sharedError"] = lastError ?? "the shared folder could not be written"
                    statusText = "The shared folder could not be written (\(lastError ?? "unknown problem")). The words are saved in the app."
                }
            } else {
                statusText = "Saved \(when) in the app (no shared folder yet)"
            }
            return out
        default:
            return ["ok": false, "error": "unknown message"]
        }
    }

    private func readShared(_ folder: URL) -> [String: Any]? {
        lastError = nil
        guard folder.startAccessingSecurityScopedResource() else { lastError = "no access to the shared folder any more: choose it again"; return nil }
        defer { folder.stopAccessingSecurityScopedResource() }
        let file = fileURL(in: folder)
        try? FileManager.default.startDownloadingUbiquitousItem(at: file)   // iCloud: the file may still be in the cloud only
        var data: Data?
        var coordError: NSError?
        NSFileCoordinator().coordinate(readingItemAt: file, options: [], error: &coordError) { url in
            data = try? Data(contentsOf: url)
        }
        if let e = coordError { lastError = e.localizedDescription; return nil }
        guard let d = data else { return nil }   // no file there yet: nothing to merge
        guard let obj = try? JSONSerialization.jsonObject(with: d), let dict = obj as? [String: Any] else { lastError = "the shared file is not readable"; return nil }
        return dict
    }

    private func writeShared(_ folder: URL, _ data: Data) -> Bool {
        lastError = nil
        guard folder.startAccessingSecurityScopedResource() else { lastError = "no access to the shared folder any more: choose it again"; return false }
        defer { folder.stopAccessingSecurityScopedResource() }
        let file = fileURL(in: folder)
        var coordError: NSError?
        var writeError: Error?
        NSFileCoordinator().coordinate(writingItemAt: file, options: [.forReplacing], error: &coordError) { url in
            // (a single picked file is written in place: there is no access to its folder for a temporary file)
            do { try data.write(to: url, options: self.isFile ? [] : [.atomic]) } catch { writeError = error }
        }
        if let e = coordError { lastError = e.localizedDescription; return false }
        if let e = writeError { lastError = e.localizedDescription; return false }
        return true
    }

    /// for the automatic test report
    func status() -> [String: Any] {
        ["folder": folderName ?? "", "status": statusText, "error": lastError ?? "", "localCopy": FileManager.default.fileExists(atPath: VocabFile.localURL.path)]
    }
}
