import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        if let dir = Self.snapshotDirArgument() {
            Self.renderSnapshots(to: dir)
            NSApplication.shared.terminate(nil)
            return
        }
        NSApplication.shared.setActivationPolicy(.accessory)
    }

    private static func snapshotDirArgument() -> URL? {
        let args = ProcessInfo.processInfo.arguments
        guard let idx = args.firstIndex(of: "--snapshot-dir"), idx + 1 < args.count else {
            return nil
        }
        return URL(fileURLWithPath: args[idx + 1], isDirectory: true)
    }

    private static func renderSnapshots(to dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let specs: [(filename: String, theme: ThemeID, appearance: NSAppearance.Name, tab: PopoverTab)] = [
            ("editorial.png", .editorial, .aqua, .activity),
            ("native-light.png", .native, .aqua, .activity),
            ("native-dark.png", .native, .darkAqua, .activity),
            ("slate.png", .slate, .darkAqua, .activity),
            ("terminal.png", .terminal, .darkAqua, .activity),
            ("midnight.png", .midnight, .darkAqua, .activity),
            ("control-editorial.png", .editorial, .aqua, .control),
            ("control-native.png", .native, .aqua, .control),
            ("control-slate.png", .slate, .darkAqua, .control),
            ("stages-editorial.png", .editorial, .aqua, .stages),
        ]

        for spec in specs {
            let controller = DaemonController.previewSample(theme: spec.theme)
            let view = PopoverView(controller: controller, initialTab: spec.tab)
            guard let data = renderRetinaPNG(rootView: view, width: 360, appearanceName: spec.appearance) else {
                continue
            }
            let outURL = dir.appendingPathComponent(spec.filename)
            try? data.write(to: outURL)
        }

        let aboutView = AboutPanelView(daemonVersion: "0.17.0").themed(Theme.of(.editorial))
        if let aboutData = renderRetinaPNG(
            rootView: aboutView,
            width: 320,
            minHeight: 280,
            appearanceName: .aqua
        ) {
            try? aboutData.write(to: dir.appendingPathComponent("about-editorial.png"))
        }
    }

    private static func renderRetinaPNG<Content: View>(
        rootView: Content,
        width: CGFloat,
        minHeight: CGFloat = 500,
        appearanceName: NSAppearance.Name
    ) -> Data? {
        let appearance = NSAppearance(named: appearanceName)
        let hosting = NSHostingView(rootView: rootView)
        hosting.appearance = appearance

        let window = NSWindow(
            contentRect: NSRect(x: -10_000, y: -10_000, width: width, height: 860),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.appearance = appearance
        window.isOpaque = true
        window.contentView = hosting

        var fitHeight: CGFloat = 620
        appearance?.performAsCurrentDrawingAppearance {
            hosting.frame = NSRect(origin: .zero, size: CGSize(width: width, height: 860))
            hosting.layoutSubtreeIfNeeded()
            let fitting = hosting.fittingSize
            fitHeight = max(minHeight, min(ceil(fitting.height), 760))
            hosting.frame = NSRect(origin: .zero, size: CGSize(width: width, height: fitHeight))
            window.setContentSize(CGSize(width: width, height: fitHeight))
            hosting.layoutSubtreeIfNeeded()
        }

        let targetSize = CGSize(width: width, height: fitHeight)
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(targetSize.width * 2),
            pixelsHigh: Int(targetSize.height * 2),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            return nil
        }
        rep.size = targetSize

        appearance?.performAsCurrentDrawingAppearance {
            hosting.cacheDisplay(in: hosting.bounds, to: rep)
        }
        window.close()
        return rep.representation(using: .png, properties: [:])
    }
}

@main
struct FicheBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var controller = DaemonController()

    var body: some Scene {
        MenuBarExtra {
            PopoverView(controller: controller)
        } label: {
            Label {
                Text(menuBarDisplay.text)
                    .monospacedDigit()
            } icon: {
                Image(nsImage: FicheMenuBarIcon.makeTemplateImage(phase: controller.phase))
            }
            .accessibilityLabel(menuBarDisplay.accessibilityText)
        }
        .menuBarExtraStyle(.window)
    }

    private var menuBarDisplay: (text: String, accessibilityText: String) {
        switch controller.phase {
        case .stopped:
            return ("Off", "Fiche daemon stopped")
        case .starting:
            return ("Starting", "Fiche daemon starting")
        case .paused:
            return ("Paused", "Fiche compression paused")
        case .live:
            let compressed = controller.stats?.compressedRequests ?? 0
            let savedTokens = controller.stats?.savedInputTokens ?? 0
            let savedPct = controller.stats?.savedPct ?? 0
            let savedUsd = controller.stats?.savedUsd ?? 0

            guard compressed > 0 || savedTokens > 0 else {
                return ("fiche", "Fiche active, no compressed turns yet")
            }

            let usdStr = Fmt.usd(savedUsd)
            let summary: String
            if savedPct >= 0.5 {
                summary = "-\(Int(savedPct.rounded()))% · \(usdStr)"
            } else if savedTokens > 0 {
                summary = "-\(Fmt.tokens(savedTokens)) · \(usdStr)"
            } else {
                summary = "\(compressed) req · \(usdStr)"
            }

            return (
                summary,
                "Fiche active: \(Fmt.tokens(savedTokens)) tokens saved, \(usdStr) saved"
            )
        }
    }
}
