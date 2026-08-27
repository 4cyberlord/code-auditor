import Foundation

enum AppConfig {
    static var supabaseURL: URL {
        requiredURL("CODE_EDITOR_SUPABASE_URL")
    }

    static var supabaseAnonKey: String {
        requiredString("CODE_EDITOR_SUPABASE_ANON_KEY")
    }

    static var deviceRegistrationURL: URL {
        requiredURL("CODE_EDITOR_DEVICE_REGISTRATION_URL")
    }

    static var deviceRegistrationToken: String {
        requiredString("CODE_EDITOR_DEVICE_REGISTRATION_TOKEN")
    }

    private static func requiredString(_ key: String) -> String {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            fatalError("Missing \(key)")
        }
        return value
    }

    private static func requiredURL(_ key: String) -> URL {
        guard let url = URL(string: requiredString(key)) else {
            fatalError("Invalid \(key)")
        }
        return url
    }
}
