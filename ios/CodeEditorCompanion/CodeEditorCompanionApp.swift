import SwiftUI
import UIKit
import UserNotifications

@main
struct CodeEditorCompanionApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            JobListView()
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var window: UIWindow?

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        requestNotifications(application)
        DispatchQueue.main.async {
            self.attachOverlayIfPossible()
        }
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        attachOverlayIfPossible()
    }

    private func requestNotifications(_ application: UIApplication) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async {
                application.registerForRemoteNotifications()
            }
        }
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task {
            await NotificationRegistrar().register(deviceToken: token)
        }
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let jobId = response.notification.request.content.userInfo["jobId"] as? String else {
            return
        }
        NotificationCenter.default.post(name: .openJobFromNotification, object: jobId)
    }

    private func attachOverlayIfPossible() {
        guard let appWindow = activeAppWindow() else { return }
        window = appWindow
        OverlayManager.shared.attach(to: appWindow)
    }

    private func activeAppWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            .flatMap { scene in
                scene.windows.first { window in
                    window.isKeyWindow && !(window is OverlayWindow)
                } ?? scene.windows.first { !($0 is OverlayWindow) }
            }
    }
}
