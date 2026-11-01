import Foundation
import Security

/// The API keys (Claude, OpenAI, ElevenLabs, Microsoft) in the iOS Keychain, only on this device.
/// shim-dream.js keeps `drKeys` out of the JSON store and reads / writes it here as JSON text.
enum Keys {
    static let service = "local.ytlearn.keys"

    private static func query(_ name: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name]
    }

    static func get(_ name: String) -> String? {
        var q = query(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// nil removes it
    static func set(_ name: String, _ value: String?) {
        SecItemDelete(query(name) as CFDictionary)
        guard let value = value, let data = value.data(using: .utf8) else { return }
        var add = query(name)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status != errSecSuccess { NSLog("[keys] could not save (%d)", Int(status)) }
    }
}
