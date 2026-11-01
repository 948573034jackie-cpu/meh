import Foundation

/// My tutor's saved data (chrome.storage.local / .sync in Chrome): one JSON file per area in the app's Documents
/// folder (`storage-local.json`, `storage-sync.json`). The vocabulary and the subtitle caches can reach megabytes,
/// so this is not UserDefaults. Writes are merged in memory and written to disk a moment later, atomically.
/// The API keys are never here (Keys.swift: the Keychain).
final class Store {
    static let shared = Store()
    private var areas: [String: [String: Any]] = [:]
    private var dirty = Set<String>()
    private var writeScheduled = false
    private let queue = DispatchQueue(label: "local.ytlearn.store")

    private func fileURL(_ area: String) -> URL {
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("storage-\(area).json")
    }

    private func load(_ area: String) -> [String: Any] {
        if let a = areas[area] { return a }
        var a: [String: Any] = [:]
        if let data = try? Data(contentsOf: fileURL(area)),
           let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { a = obj }
        areas[area] = a
        return a
    }

    /// The whole area as JSON text (what a page gets when it starts); `overrides` win (the old mode's switches).
    func allJSON(area: String, overrides: [String: Any] = [:]) -> String {
        queue.sync {
            var a = load(area)
            for (k, v) in overrides { a[k] = v }
            a.removeValue(forKey: "drKeys")
            guard let data = try? JSONSerialization.data(withJSONObject: a), let text = String(data: data, encoding: .utf8) else { return "{}" }
            return text
        }
    }

    func value(area: String, key: String) -> Any? {
        queue.sync { load(area)[key] }
    }

    /// Merges the values (JSON text of an object) into the area; returns them as an object.
    @discardableResult
    func set(area: String, json: String) -> [String: Any] {
        guard let data = json.data(using: .utf8),
              var obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
        obj.removeValue(forKey: "drKeys")
        queue.sync {
            var a = load(area)
            for (k, v) in obj { a[k] = v }
            areas[area] = a
            dirty.insert(area)
            scheduleWrite()
        }
        return obj
    }

    func remove(area: String, keys: [String]) {
        queue.sync {
            var a = load(area)
            for k in keys { a.removeValue(forKey: k) }
            areas[area] = a
            dirty.insert(area)
            scheduleWrite()
        }
    }

    private func scheduleWrite() {
        if writeScheduled { return }
        writeScheduled = true
        queue.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.writeNow() }
    }

    /// Writes everything that changed (the app going to the background calls this too).
    func flush() { queue.sync { writeNow() } }

    private func writeNow() {
        writeScheduled = false
        for area in dirty {
            guard let a = areas[area], let data = try? JSONSerialization.data(withJSONObject: a) else { continue }
            try? data.write(to: fileURL(area), options: [.atomic])
        }
        dirty.removeAll()
    }
}
