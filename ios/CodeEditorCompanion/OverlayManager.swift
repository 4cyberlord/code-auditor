import SwiftUI
import UIKit

@MainActor
final class OverlayManager: NSObject, ObservableObject {
    static let shared = OverlayManager()

    @Published private(set) var isEnabled = false

    private(set) var overlay: OverlayWindow?
    private var isObservingCapture = false

    override private init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRotation),
            name: UIDevice.orientationDidChangeNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    func toggle() {
        isEnabled ? hide() : show()
    }

    func show() {
        guard let appWindow = activeAppWindow() else {
            return
        }
        attach(to: appWindow)
    }

    func attach(to appWindow: UIWindow) {
        if overlay == nil {
            let overlay = OverlayWindow(frame: appWindow.frame)
            overlay.windowScene = appWindow.windowScene
            self.overlay = overlay
        }

        overlay?.show()
        isEnabled = true

        if !isObservingCapture {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(screenCaptureChanged),
                name: UIScreen.capturedDidChangeNotification,
                object: nil
            )
            isObservingCapture = true
        }

        screenCaptureChanged()
    }

    func hide() {
        overlay?.hide()
        overlay = nil
        isEnabled = false
    }

    @objc private func screenCaptureChanged() {
        guard let overlay else { return }
        if !UIScreen.main.isCaptured {
            overlay.layer.isHidden = false
        }
        UIView.animate(withDuration: 0.05) {
            overlay.alpha = UIScreen.main.isCaptured ? 0 : 1
        } completion: { _ in
            overlay.layer.isHidden = UIScreen.main.isCaptured
        }
    }

    @objc private func appDidBecomeActive() {
        screenCaptureChanged()
    }

    @objc private func handleRotation() {
        guard let overlay else { return }
        overlay.frame = UIScreen.main.bounds
        overlay.repositionGlassPanel()
    }

    func updateOverlay(text: String) {
        overlay?.update(text: text)
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

final class OverlayWindow: UIWindow {
    fileprivate let glassPanel: GlassPanelView

    override init(frame: CGRect) {
        glassPanel = GlassPanelView(frame: CGRect(x: 0, y: 0, width: 280, height: 160))
        super.init(frame: frame)

        windowLevel = UIWindow.Level(rawValue: UIWindow.Level.alert.rawValue + 100)
        backgroundColor = .clear
        isOpaque = false
        isUserInteractionEnabled = true

        let rootViewController = UIViewController()
        rootViewController.view.backgroundColor = .clear
        rootViewController.view.isUserInteractionEnabled = true
        self.rootViewController = rootViewController

        rootViewController.view.addSubview(glassPanel)
        repositionGlassPanel()
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        repositionGlassPanel()
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard !isHidden, alpha > 0 else { return nil }
        let pointInPanel = glassPanel.convert(point, from: self)
        guard glassPanel.bounds.contains(pointInPanel) else { return nil }
        return glassPanel.hitTest(pointInPanel, with: event)
    }

    func show() {
        isHidden = false
    }

    func hide() {
        isHidden = true
    }

    func update(text: String) {
        glassPanel.update(text: text)
    }

    func repositionGlassPanel() {
        glassPanel.frame = CGRect(x: 0, y: 0, width: 280, height: 160)
        glassPanel.center = CGPoint(x: bounds.midX, y: safeAreaInsets.top + 80)
    }
}

private final class GlassPanelView: UIView {
    private let blurView: UIVisualEffectView
    private let label: UILabel

    override init(frame: CGRect) {
        blurView = UIVisualEffectView(effect: UIBlurEffect(style: .systemMaterialLight))
        label = UILabel()
        super.init(frame: frame)
        isUserInteractionEnabled = true
        backgroundColor = .clear

        blurView.frame = bounds
        blurView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        blurView.isUserInteractionEnabled = true
        blurView.layer.cornerRadius = 16
        blurView.layer.cornerCurve = .continuous
        blurView.layer.masksToBounds = true
        blurView.layer.borderWidth = 1
        blurView.layer.borderColor = UIColor.white.withAlphaComponent(0.34).cgColor
        blurView.contentView.backgroundColor = UIColor.white.withAlphaComponent(0.10)

        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.15
        layer.shadowOffset = CGSize(width: 0, height: 4)
        layer.shadowRadius = 12

        label.text = "Hint: press \u{2318}+Space"
        label.textColor = .white
        label.font = .systemFont(ofSize: 14, weight: .medium)
        label.textAlignment = .center
        label.frame = CGRect(x: 12, y: 0, width: frame.width - 24, height: frame.height)
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        blurView.contentView.addSubview(label)
        addSubview(blurView)
    }

    required init?(coder: NSCoder) {
        nil
    }

    func update(text: String) {
        label.text = text
    }
}

struct CaptureExemptOverlayToggle: View {
    @ObservedObject private var overlay = OverlayManager.shared

    var body: some View {
        Button {
            overlay.toggle()
        } label: {
            Label("Overlay", systemImage: overlay.isEnabled ? "rectangle.on.rectangle.slash" : "rectangle.on.rectangle")
        }
        .accessibilityLabel(overlay.isEnabled ? "Hide overlay" : "Show overlay")
    }
}
