import AppKit
import SwiftUI

// MARK: - About FicheBar Panel

struct AboutPanelView: View {
    @Environment(\.theme) private var theme
    let daemonVersion: String?

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.17.0"
    }

    var body: some View {
        VStack(spacing: 14) {
            FicheLogoMark(tooltip: "Fiche — Optical & Text Context Compiler")
                .frame(width: 52, height: 52)
                .padding(.top, 2)

            VStack(spacing: 5) {
                HStack(spacing: 6) {
                    Text("FicheBar")
                        .font(.title3.weight(.bold))
                        .fontWidth(theme.fontWidth)
                        .foregroundStyle(theme.primaryText)

                    Text("v\(appVersion)")
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(theme.secondaryText)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(
                            theme.controlRail,
                            in: RoundedRectangle(cornerRadius: theme.badgeRadius, style: .continuous)
                        )

                    if let daemonVersion, !daemonVersion.isEmpty, daemonVersion != appVersion {
                        Text("daemon v\(daemonVersion)")
                            .font(.caption2.weight(.medium))
                            .monospacedDigit()
                            .foregroundStyle(theme.tertiaryText)
                    }
                }

                Text("Hybrid Optical & Text Context Compiler for Coding Agents")
                    .font(.caption)
                    .foregroundStyle(theme.secondaryText)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)

                Text("Built by Srinivas Pendela (Sriinnu)")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(theme.primaryText)
                    .padding(.top, 2)
            }

            VStack(spacing: 6) {
                AboutLinkRow(
                    symbol: "chevron.left.forwardslash.chevron.right",
                    symbolColor: theme.accent,
                    title: "GitHub Repository",
                    subtitle: "github.com/sriinnu/fiche"
                ) {
                    openExternal("https://github.com/sriinnu/fiche")
                }

                AboutLinkRow(
                    symbol: "heart.fill",
                    symbolColor: Color(nsColor: .systemPink),
                    title: "Sponsor on GitHub",
                    subtitle: "github.com/sponsors/sriinnu"
                ) {
                    openExternal("https://github.com/sponsors/sriinnu")
                }

                AboutLinkRow(
                    symbol: "globe",
                    symbolColor: theme.accentSecondary,
                    title: "Website",
                    subtitle: "fiche.srinivas.dev"
                ) {
                    openExternal("https://fiche.srinivas.dev")
                }
            }

            Hairline()

            Text("MIT License · Local-only loopback proxy · Zero telemetry")
                .font(.caption2)
                .foregroundStyle(theme.tertiaryText)
                .multilineTextAlignment(.center)
        }
        .padding(20)
        .frame(width: 320)
    }

    private func openExternal(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        NSWorkspace.shared.open(url)
    }
}

private struct AboutLinkRow: View {
    @Environment(\.theme) private var theme
    @State private var isHovered = false
    let symbol: String
    let symbolColor: Color
    let title: String
    let subtitle: String
    let action: () -> Void

    var body: some View {
        let radius: CGFloat = theme.layout == .instrumentation ? 3 : 8

        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(symbolColor)
                    .frame(width: 22, alignment: .center)

                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(theme.primaryText)
                    Text(subtitle)
                        .font(.caption2)
                        .foregroundStyle(theme.tertiaryText)
                }

                Spacer()

                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(theme.tertiaryText)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                isHovered ? theme.controlRail : (theme.usesInsetCards ? theme.surface : theme.controlRail.opacity(0.45)),
                in: RoundedRectangle(cornerRadius: radius, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(theme.hairline, lineWidth: 0.75)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
    }
}

// MARK: - Window Controller

@MainActor
final class AboutWindowController {
    static let shared = AboutWindowController()

    private var window: NSWindow?

    private init() {}

    func show(theme: Theme, daemonVersion: String?) {
        let content = AboutPanelView(daemonVersion: daemonVersion).themed(theme)
        let appearance: NSAppearance? = {
            switch theme.scheme {
            case .light: return NSAppearance(named: .aqua)
            case .dark: return NSAppearance(named: .darkAqua)
            case nil: return nil
            @unknown default: return nil
            }
        }()

        if let window {
            window.appearance = appearance
            let hosting = NSHostingController(rootView: content)
            window.contentViewController = hosting
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let hosting = NSHostingController(rootView: content)
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 370),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        win.title = "About FicheBar"
        win.isReleasedWhenClosed = false
        win.level = .floating
        win.isMovableByWindowBackground = true
        win.appearance = appearance
        win.contentViewController = hosting
        win.setContentSize(NSSize(width: 320, height: max(330, hosting.view.fittingSize.height)))
        win.center()
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = win
    }
}
