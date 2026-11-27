import AppKit
import Combine
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate {
    private var controller: DaemonController?
    private var statusItem: NSStatusItem?
    private var popover: NSPopover?
    private var cancellables: Set<AnyCancellable> = []
    private var localEventMonitor: Any?
    private var globalEventMonitor: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let dir = Self.snapshotDirArgument() {
            Self.renderSnapshots(to: dir)
            NSApplication.shared.terminate(nil)
            return
        }
        NSApplication.shared.setActivationPolicy(.accessory)
        Self.installMinimalEditMenu()

        let controller = DaemonController()
        self.controller = controller
        setupStatusItem(controller: controller)
    }

    private static func installMinimalEditMenu() {
        let mainMenu = NSApp.mainMenu ?? NSMenu()
        if mainMenu.items.isEmpty {
            let appItem = NSMenuItem()
            appItem.submenu = NSMenu()
            mainMenu.addItem(appItem)
        }
        let hasEditShortcuts = mainMenu.items.contains { item in
            item.submenu?.items.contains(where: { $0.action == #selector(NSText.paste(_:)) }) == true
        }
        if !hasEditShortcuts {
            let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
            let editMenu = NSMenu(title: "Edit")
            editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
            editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
            editMenu.addItem(.separator())
            editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
            editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
            editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
            editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
            editItem.submenu = editMenu
            mainMenu.addItem(editItem)
        }
        NSApp.mainMenu = mainMenu
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    private func setupStatusItem(controller: DaemonController) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item.button {
            button.imagePosition = .imageLeading
            button.font = NSFont.monospacedDigitSystemFont(
                ofSize: NSFont.menuBarFont(ofSize: 0).pointSize,
                weight: .regular
            )
            button.target = self
            button.action = #selector(togglePopover(_:))
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        self.statusItem = item
        updateStatusItemDisplay(controller: controller)

        Publishers.CombineLatest(controller.$phase, controller.$stats)
            .receive(on: DispatchQueue.main)
            .sink { [weak self, weak controller] _, _ in
                guard let self, let controller else { return }
                self.updateStatusItemDisplay(controller: controller)
            }
            .store(in: &cancellables)

        controller.$themeID
            .receive(on: DispatchQueue.main)
            .sink { [weak self] themeID in
                self?.popover?.appearance = Self.nsAppearance(for: Theme.of(themeID).scheme)
            }
            .store(in: &cancellables)
    }

    private func updateStatusItemDisplay(controller: DaemonController) {
        guard let button = statusItem?.button else { return }
        let display = Self.menuBarDisplay(phase: controller.phase, stats: controller.stats)
        button.image = FicheMenuBarIcon.makeTemplateImage(phase: controller.phase)
        button.title = display.text
        button.setAccessibilityLabel(display.accessibilityText)
    }

    @objc private func togglePopover(_ sender: Any?) {
        if popover?.isShown == true {
            closePopover()
            return
        }
        guard let button = (sender as? NSStatusBarButton) ?? statusItem?.button,
              let controller
        else {
            return
        }
        showPopover(relativeTo: button, controller: controller)
    }

    private func showPopover(relativeTo button: NSStatusBarButton, controller: DaemonController) {
        let hosting = NSHostingController(rootView: PopoverView(controller: controller))
        hosting.sizingOptions = [.preferredContentSize]
        hosting.view.frame = NSRect(x: 0, y: 0, width: 360, height: 640)
        hosting.view.layoutSubtreeIfNeeded()
        let maxHeight = min(740.0, max(420.0, (button.window?.screen?.visibleFrame.height ?? 800.0) - 48.0))
        let fitHeight = max(420.0, min(ceil(hosting.view.fittingSize.height), maxHeight))
        let initialSize = NSSize(width: 360, height: fitHeight)
        hosting.preferredContentSize = initialSize

        let popover = NSPopover()
        popover.behavior = .applicationDefined
        popover.animates = true
        popover.delegate = self
        popover.appearance = Self.nsAppearance(for: Theme.of(controller.themeID).scheme)
        popover.contentViewController = hosting
        popover.contentSize = initialSize
        self.popover = popover

        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        NSApp.activate()
        popover.contentViewController?.view.window?.makeKey()
        installPopoverDismissMonitors(anchor: button)
    }

    private func closePopover() {
        removePopoverDismissMonitors()
        let current = popover
        popover = nil
        current?.performClose(nil)
    }

    private func installPopoverDismissMonitors(anchor button: NSStatusBarButton) {
        removePopoverDismissMonitors()
        let localMask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]
        let globalMask: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]

        localEventMonitor = NSEvent.addLocalMonitorForEvents(matching: localMask) { [weak self, weak button] event in
            guard let self, self.popover?.isShown == true else { return event }
            if event.type == .keyDown {
                if event.keyCode == 53,
                   let popoverWindow = self.popover?.contentViewController?.view.window,
                   event.window === popoverWindow
                {
                    if popoverWindow.firstResponder is NSTextView {
                        return event
                    }
                    self.closePopover()
                    return nil
                }
                return event
            }
            if !self.eventIsInsidePopoverOrAnchor(event, anchor: button) {
                self.closePopover()
            }
            return event
        }

        globalEventMonitor = NSEvent.addGlobalMonitorForEvents(matching: globalMask) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, self.popover?.isShown == true else { return }
                self.closePopover()
            }
        }
    }

    private func removePopoverDismissMonitors() {
        if let monitor = localEventMonitor {
            NSEvent.removeMonitor(monitor)
            localEventMonitor = nil
        }
        if let monitor = globalEventMonitor {
            NSEvent.removeMonitor(monitor)
            globalEventMonitor = nil
        }
    }

    private func eventIsInsidePopoverOrAnchor(_ event: NSEvent, anchor button: NSStatusBarButton?) -> Bool {
        if let eventWindow = event.window {
            if eventWindow.level.rawValue >= NSWindow.Level.popUpMenu.rawValue {
                return true
            }
            if let popoverWindow = popover?.contentViewController?.view.window {
                if eventWindow === popoverWindow {
                    return true
                }
                if popoverWindow.childWindows?.contains(where: { $0 === eventWindow }) == true {
                    return true
                }
            }
        }
        guard let button,
              let buttonWindow = button.window,
              event.window === buttonWindow
        else {
            return false
        }
        let location = button.convert(event.locationInWindow, from: nil)
        return button.bounds.contains(location)
    }

    nonisolated func popoverDidClose(_ notification: Notification) {
        let closedID = (notification.object as AnyObject?).map(ObjectIdentifier.init)
        if Thread.isMainThread {
            MainActor.assumeIsolated {
                guard let active = self.popover, closedID == ObjectIdentifier(active) else { return }
                self.removePopoverDismissMonitors()
                self.popover = nil
            }
        } else {
            Task { @MainActor [weak self] in
                guard let self, let active = self.popover, closedID == ObjectIdentifier(active) else { return }
                self.removePopoverDismissMonitors()
                self.popover = nil
            }
        }
    }

    private static func nsAppearance(for scheme: ColorScheme?) -> NSAppearance? {
        switch scheme {
        case .light: return NSAppearance(named: .aqua)
        case .dark: return NSAppearance(named: .darkAqua)
        case nil: return nil
        @unknown default: return nil
        }
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
            ("agents-editorial.png", .editorial, .aqua, .agents),
            ("control-editorial.png", .editorial, .aqua, .control),
            ("control-native.png", .native, .aqua, .control),
            ("control-slate.png", .slate, .darkAqua, .control),
            ("stages-editorial.png", .editorial, .aqua, .stages),
        ]

        for spec in specs {
            let controller = DaemonController.previewSample(theme: spec.theme, tab: spec.tab)
            let view = PopoverView(controller: controller, initialTab: spec.tab)
            guard let data = renderRetinaPNG(rootView: view, width: 360, appearanceName: spec.appearance) else {
                continue
            }
            let outURL = dir.appendingPathComponent(spec.filename)
            try? data.write(to: outURL)
        }

        let aboutView = AboutPanelView(daemonVersion: "0.20.0").themed(Theme.of(.editorial))
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

    private static func menuBarDisplay(
        phase: DaemonPhase,
        stats: ProxyStatsResponse?
    ) -> (text: String, accessibilityText: String) {
        switch phase {
        case .stopped:
            return ("Off", "Fiche daemon stopped")
        case .starting:
            return ("Starting", "Fiche daemon starting")
        case .paused:
            return ("Paused", "Fiche compression paused")
        case .live:
            let compressed = stats?.compressedRequests ?? 0
            let savedTokens = stats?.savedInputTokens ?? 0
            let savedPct = stats?.savedPct ?? 0
            let savedUsd = stats?.savedUsd ?? 0

            guard compressed > 0 || abs(savedTokens) >= 0.5 else {
                return ("fiche", "Fiche active, no compressed turns yet")
            }

            let unpricedAll = stats?.allRequestsUnpriced ?? false
            let isOverhead = savedTokens < -0.5 || savedUsd < 0
            let usdStr: String = {
                if unpricedAll {
                    return "unpriced"
                }
                if isOverhead && savedUsd < 0 {
                    return "\(Fmt.usd(abs(savedUsd))) cost"
                }
                return Fmt.usd(savedUsd)
            }()
            let summary: String
            if abs(savedPct) >= 0.5 {
                summary = "\(Fmt.signedPctDelta(savedPct)) · \(usdStr)"
            } else if abs(savedTokens) >= 0.5 {
                summary = "\(Fmt.signedTokenDelta(savedTokens)) · \(usdStr)"
            } else {
                summary = "\(compressed) req · \(usdStr)"
            }

            let accessibilityText: String
            if unpricedAll {
                accessibilityText = "Fiche active: \(Fmt.signedTokenDelta(savedTokens)) tokens delta, pricing unavailable"
            } else if isOverhead {
                accessibilityText = "Fiche active: \(Fmt.signedTokenDelta(savedTokens)) tokens overhead, \(Fmt.usd(abs(savedUsd))) net cost"
            } else {
                accessibilityText = "Fiche active: \(Fmt.tokens(savedTokens)) tokens saved, \(usdStr) saved"
            }

            return (summary, accessibilityText)
        }
    }
}

@main
struct FicheBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
        }
    }
}
