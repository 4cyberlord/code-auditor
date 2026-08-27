import Foundation
import UIKit

final class NotificationRegistrar {
    func register(deviceToken: String) async {
        var request = URLRequest(url: AppConfig.deviceRegistrationURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(AppConfig.deviceRegistrationToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "deviceToken": deviceToken,
            "label": UIDevice.current.name
        ])
        _ = try? await URLSession.shared.data(for: request)
    }
}
