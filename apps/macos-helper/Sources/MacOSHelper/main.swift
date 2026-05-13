import Foundation

// MARK: - Command Protocol

enum HelperCommand: String {
    case keychainGet = "keychain-get"
    case keychainSet = "keychain-set"
    case keychainDelete = "keychain-delete"
    case keychainList = "keychain-list"
    case notify = "notify"
    case spotlightIndex = "spotlight-index"
}

// MARK: - JSON Response

struct HelperResponse: Codable {
    let success: Bool
    let data: String?
    let error: String?
}

// MARK: - Keychain Service

struct KeychainService {
    static let serviceName = "com.metalmind.api-keys"

    static func get(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            return nil
        }
        return value
    }

    static func set(account: String, value: String) -> Bool {
        // Delete existing if present
        delete(account: account)

        let data = value.data(using: .utf8)!
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    static func list() -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess,
              let items = result as? [[String: Any]] else {
            return []
        }

        return items.compactMap { $0[kSecAttrAccount as String] as? String }
    }
}

// MARK: - Notification Service

struct NotificationService {
    static func send(title: String, body: String, identifier: String = UUID().uuidString) {
        let center = NSUserNotificationCenter.default

        let notification = NSUserNotification()
        notification.title = title
        notification.informativeText = body
        notification.identifier = identifier

        center.deliver(notification)
    }
}

// MARK: - Spotlight Service

struct SpotlightService {
    static func indexProject(path: String, name: String) {
        // Spotlight indexing is handled automatically by the system
        // We can add metadata using mdimport if needed
        let process = Process()
        process.launchPath = "/usr/bin/mdimport"
        process.arguments = [path]
        try? process.run()
        process.waitUntilExit()
    }
}

// MARK: - Main

func sendResponse(_ response: HelperResponse) {
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(response),
          let json = String(data: data, encoding: .utf8) else {
        print("{\"success\":false,\"error\":\"Failed to encode response\"}")
        return
    }
    print(json)
}

func fail(_ message: String) -> Never {
    sendResponse(HelperResponse(success: false, data: nil, error: message))
    exit(1)
}

// Parse arguments
let args = CommandLine.arguments

guard args.count >= 2 else {
    print("Usage: MacOSHelper <command> [args...]")
    print("Commands: keychain-get, keychain-set, keychain-delete, keychain-list, notify, spotlight-index")
    exit(1)
}

guard let command = HelperCommand(rawValue: args[1]) else {
    fail("Unknown command: \(args[1])")
}

switch command {
case .keychainGet:
    guard args.count >= 3 else { fail("Usage: keychain-get <account>") }
    let account = args[2]
    if let value = KeychainService.get(account: account) {
        sendResponse(HelperResponse(success: true, data: value, error: nil))
    } else {
        sendResponse(HelperResponse(success: true, data: nil, error: "Key not found: \(account)"))
    }

case .keychainSet:
    guard args.count >= 4 else { fail("Usage: keychain-set <account> <value>") }
    let account = args[2]
    let value = args[3]
    let ok = KeychainService.set(account: account, value: value)
    sendResponse(HelperResponse(success: ok, data: ok ? "Key stored" : nil, error: ok ? nil : "Failed to store key"))

case .keychainDelete:
    guard args.count >= 3 else { fail("Usage: keychain-delete <account>") }
    KeychainService.delete(account: args[2])
    sendResponse(HelperResponse(success: true, data: "Key deleted", error: nil))

case .keychainList:
    let accounts = KeychainService.list()
    sendResponse(HelperResponse(success: true, data: accounts.joined(separator: "\n"), error: nil))

case .notify:
    guard args.count >= 4 else { fail("Usage: notify <title> <body>") }
    NotificationService.send(title: args[2], body: args[3])
    sendResponse(HelperResponse(success: true, data: "Notification sent", error: nil))

case .spotlightIndex:
    guard args.count >= 4 else { fail("Usage: spotlight-index <path> <name>") }
    SpotlightService.indexProject(path: args[2], name: args[3])
    sendResponse(HelperResponse(success: true, data: "Indexing triggered", error: nil))
}
