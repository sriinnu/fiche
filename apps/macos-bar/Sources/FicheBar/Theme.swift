import AppKit
import SwiftUI

// Five purposefully distinct macOS instrument personalities sharing one semantic data model.
// Editorial preserves Swiss paper & hairline rules; Native embodies Apple Control Center
// grouped cards; Slate renders Braun/TE anodized hardware; Terminal delivers a sharp
// carbon instrumentation bench; Midnight brings Apple Weather twilight calm.

enum ThemeID: String, CaseIterable, Identifiable, Sendable {
    case editorial, native, slate, terminal, midnight

    var id: String { rawValue }

    var label: String {
        switch self {
        case .editorial: return "Editorial"
        case .native: return "Native"
        case .slate: return "Slate"
        case .terminal: return "Terminal"
        case .midnight: return "Midnight"
        }
    }
}

enum TabBarStyle: Sendable {
    case editorial
    case pillRail
    case hardwareKeys
    case terminal
    case celestialPills
}

enum ThemeLayout: Sendable {
    case editorial
    case controlCenter
    case hardware
    case instrumentation
    case celestial
}

struct Theme: Sendable {
    let id: ThemeID
    let layout: ThemeLayout
    let tabStyle: TabBarStyle
    let scheme: ColorScheme?        // nil = follow macOS appearance
    let ground: Color
    let groundTop: Color?           // optional atmospheric top wash (e.g. Midnight twilight sky)
    let surface: Color              // card / module / band fill
    let heroSurface: Color          // hero readout fill (recessed bezel in Slate, clear in Editorial)
    let controlRail: Color
    let controlPill: Color
    let primaryText: Color
    let secondaryText: Color
    let tertiaryText: Color
    let fontDesign: Font.Design
    let fontWidth: Font.Width
    let accent: Color
    let accentSecondary: Color
    let live: Color                 // active compression / positive savings
    let warn: Color                 // paused / notice
    let ready: Color                // starting / informational
    let danger: Color               // stopped / error
    let hairline: Color
    let cardBorder: Color
    let cardTopHighlight: Color
    let cardCornerRadius: CGFloat
    let cardHorizontalMargin: CGFloat
    let cardShadowOpacity: Double
    let bigNumberWeight: Font.Weight
    let badgeRadius: CGFloat
    let swatchGround: Color
    let swatchAccent: Color

    var usesInsetCards: Bool {
        layout != .editorial
    }

    static func of(_ id: ThemeID) -> Theme {
        switch id {
        case .editorial:
            // Swiss white paper, bold condensed type, one disciplined crimson accent.
            return Theme(
                id: id,
                layout: .editorial,
                tabStyle: .editorial,
                scheme: .light,
                ground: hex(0xFFFFFF),
                groundTop: nil,
                surface: .clear,
                heroSurface: .clear,
                controlRail: hex(0xF4F4F5),
                controlPill: hex(0xFFFFFF),
                primaryText: hex(0x09090B),
                secondaryText: hex(0x52525B),
                tertiaryText: hex(0x71717A),
                fontDesign: .default,
                fontWidth: .condensed,
                accent: hex(0xC70F2E),
                accentSecondary: hex(0x166534),
                live: hex(0x166534),
                warn: hex(0x18181B),
                ready: hex(0xC70F2E),
                danger: hex(0xC70F2E),
                hairline: Color.black.opacity(0.14),
                cardBorder: .clear,
                cardTopHighlight: .clear,
                cardCornerRadius: 0,
                cardHorizontalMargin: 0,
                cardShadowOpacity: 0,
                bigNumberWeight: .heavy,
                badgeRadius: 3,
                swatchGround: hex(0xFFFFFF),
                swatchAccent: hex(0xC70F2E)
            )

        case .native:
            // Apple Sequoia / Tahoe Control Center — Adaptive Light & Dark inset grouped cards.
            return Theme(
                id: id,
                layout: .controlCenter,
                tabStyle: .pillRail,
                scheme: nil,
                ground: dyn(0xF1F3F7, 0x15171C),
                groundTop: nil,
                surface: dyn(0xFFFFFF, 0x20232B),
                heroSurface: dyn(0xFFFFFF, 0x20232B),
                controlRail: dyn(0xE3E7EF, 0x101216),
                controlPill: dyn(0xFFFFFF, 0x2C303B),
                primaryText: dyn(0x0F172A, 0xF4F6FA),
                secondaryText: dyn(0x475569, 0x9CA3B4),
                tertiaryText: dyn(0x64748B, 0x6F7788),
                fontDesign: .default,
                fontWidth: .standard,
                accent: dyn(0x0066EE, 0x3B9EFF),
                accentSecondary: dyn(0x15803D, 0x30D158),
                live: dyn(0x15803D, 0x30D158),
                warn: dyn(0xB45309, 0xFBBF24),
                ready: dyn(0x0066EE, 0x3B9EFF),
                danger: dyn(0xDC2626, 0xFF453A),
                hairline: dynAlpha(0x0F172A, 0.09, 0xFFFFFF, 0.08),
                cardBorder: dynAlpha(0x0F172A, 0.08, 0xFFFFFF, 0.10),
                cardTopHighlight: dynAlpha(0xFFFFFF, 0.85, 0xFFFFFF, 0.14),
                cardCornerRadius: 12,
                cardHorizontalMargin: 12,
                cardShadowOpacity: 0.08,
                bigNumberWeight: .semibold,
                badgeRadius: 6,
                swatchGround: dyn(0xF1F3F7, 0x20232B),
                swatchAccent: dyn(0x0066EE, 0x3B9EFF)
            )

        case .slate:
            // Braun / Dieter Rams / Teenage Engineering tactile hardware instrument.
            return Theme(
                id: id,
                layout: .hardware,
                tabStyle: .hardwareKeys,
                scheme: .dark,
                ground: hex(0x202226),
                groundTop: nil,
                surface: hex(0x2A2C31),
                heroSurface: hex(0x131417),
                controlRail: hex(0x16171B),
                controlPill: hex(0x34373E),
                primaryText: hex(0xF3F0EA),
                secondaryText: hex(0xA3A6AD),
                tertiaryText: hex(0x757880),
                fontDesign: .default,
                fontWidth: .standard,
                accent: hex(0xFF5A1F),
                accentSecondary: hex(0x2FD16B),
                live: hex(0x2FD16B),
                warn: hex(0xF5A623),
                ready: hex(0xFF5A1F),
                danger: hex(0xFF453A),
                hairline: Color.white.opacity(0.09),
                cardBorder: Color.white.opacity(0.12),
                cardTopHighlight: Color.white.opacity(0.08),
                cardCornerRadius: 6,
                cardHorizontalMargin: 12,
                cardShadowOpacity: 0.24,
                bigNumberWeight: .bold,
                badgeRadius: 2.5,
                swatchGround: hex(0x202226),
                swatchAccent: hex(0xFF5A1F)
            )

        case .terminal:
            // Developer Instrumentation Bench — razor 2pt panes, cyan/green phosphor, monospace discipline.
            return Theme(
                id: id,
                layout: .instrumentation,
                tabStyle: .terminal,
                scheme: .dark,
                ground: hex(0x06080B),
                groundTop: nil,
                surface: hex(0x0C1016),
                heroSurface: hex(0x0C1016),
                controlRail: hex(0x0F141C),
                controlPill: hex(0x18202B),
                primaryText: hex(0xE6EDF3),
                secondaryText: hex(0x8D98A5),
                tertiaryText: hex(0x687382),
                fontDesign: .monospaced,
                fontWidth: .standard,
                accent: hex(0x58D1EB),
                accentSecondary: hex(0x3FB950),
                live: hex(0x3FB950),
                warn: hex(0xE3B341),
                ready: hex(0x58D1EB),
                danger: hex(0xF85149),
                hairline: Color.white.opacity(0.11),
                cardBorder: hex(0x27303D),
                cardTopHighlight: hex(0x344052),
                cardCornerRadius: 2,
                cardHorizontalMargin: 12,
                cardShadowOpacity: 0,
                bigNumberWeight: .bold,
                badgeRadius: 2,
                swatchGround: hex(0x06080B),
                swatchAccent: hex(0x3FB950)
            )

        case .midnight:
            // Apple Weather Twilight / Celestial — deep navy sky wash, starlight glass cards, SF Rounded.
            return Theme(
                id: id,
                layout: .celestial,
                tabStyle: .celestialPills,
                scheme: .dark,
                ground: hex(0x080D1F),
                groundTop: hex(0x172652),
                surface: hex(0x111A38),
                heroSurface: hex(0x142044),
                controlRail: hex(0x0B1228),
                controlPill: hex(0x1E2D5A),
                primaryText: hex(0xF0F4FF),
                secondaryText: hex(0xA6B6DA),
                tertiaryText: hex(0x7486B5),
                fontDesign: .rounded,
                fontWidth: .standard,
                accent: hex(0x7DD3FC),
                accentSecondary: hex(0x5EEAD4),
                live: hex(0x4ADE80),
                warn: hex(0xFCD34D),
                ready: hex(0x7DD3FC),
                danger: hex(0xFB7185),
                hairline: hex(0xC7D2FE).opacity(0.11),
                cardBorder: hex(0xC7D2FE).opacity(0.15),
                cardTopHighlight: hex(0xE0E7FF).opacity(0.18),
                cardCornerRadius: 14,
                cardHorizontalMargin: 12,
                cardShadowOpacity: 0.22,
                bigNumberWeight: .bold,
                badgeRadius: 7,
                swatchGround: hex(0x121D42),
                swatchAccent: hex(0x7DD3FC)
            )
        }
    }
}

private struct ThemeKey: EnvironmentKey {
    static let defaultValue = Theme.of(.editorial)
}

extension EnvironmentValues {
    var theme: Theme {
        get { self[ThemeKey.self] }
        set { self[ThemeKey.self] = newValue }
    }
}

extension View {
    /// Applies a theme to a whole subtree: opaque/atmospheric ground, ink hierarchy, font design, tint, and color scheme.
    @ViewBuilder
    func themed(_ t: Theme) -> some View {
        let base = self
            .environment(\.theme, t)
            .fontDesign(t.fontDesign)
            .foregroundStyle(t.primaryText)
            .tint(t.accent)
            .background {
                if let top = t.groundTop {
                    LinearGradient(
                        stops: [
                            .init(color: top, location: 0.0),
                            .init(color: t.ground, location: 0.52),
                            .init(color: t.ground, location: 1.0),
                        ],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                } else {
                    t.ground
                }
            }
        if let scheme = t.scheme {
            base.environment(\.colorScheme, scheme)
        } else {
            base
        }
    }
}

/// A thin full-width horizontal rule in the theme's hairline colour.
struct Hairline: View {
    @Environment(\.theme) private var theme
    var inset: CGFloat = 0

    var body: some View {
        Rectangle()
            .fill(theme.hairline)
            .frame(height: 1)
            .padding(.leading, inset)
    }
}

/// A thin vertical rule in the theme's hairline colour.
struct VerticalHairline: View {
    @Environment(\.theme) private var theme

    var body: some View {
        Rectangle()
            .fill(theme.hairline)
            .frame(width: 1)
    }
}

/// Theme-adaptive surface container:
/// - Editorial: flush full-width paper band bounded by 1px horizontal hairlines.
/// - Native: inset grouped rounded Control Center card with crisp 0.5px rim & subtle shadow.
/// - Slate: chamfered anodized hardware module (or recessed OLED readout when `isHero == true`).
/// - Terminal: sharp 2pt-radius bordered instrumentation pane.
/// - Midnight: atmospheric starlight glass card with soft translucent rim.
struct Band<Content: View>: View {
    @Environment(\.theme) private var theme
    var isHero: Bool = false
    @ViewBuilder let content: Content

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: theme.cardCornerRadius, style: .continuous)
        let fill = isHero ? theme.heroSurface : theme.surface

        if theme.layout == .editorial {
            VStack(alignment: .leading, spacing: 0) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(fill)
                .overlay(alignment: .top) { Hairline() }
                .overlay(alignment: .bottom) { Hairline() }
        } else {
            let borderWidth: CGFloat = (theme.layout == .hardware || theme.layout == .instrumentation) ? 1.0 : 0.65

            VStack(alignment: .leading, spacing: 0) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(fill, in: shape)
                .clipShape(shape)
                .overlay {
                    shape.strokeBorder(theme.cardBorder, lineWidth: borderWidth)
                }
                .overlay {
                    if theme.layout == .controlCenter || theme.layout == .celestial || theme.layout == .hardware {
                        shape.strokeBorder(
                            LinearGradient(
                                stops: [
                                    .init(color: theme.cardTopHighlight, location: 0.0),
                                    .init(color: .clear, location: 0.35),
                                ],
                                startPoint: .top,
                                endPoint: .bottom
                            ),
                            lineWidth: 0.75
                        )
                        .allowsHitTesting(false)
                    }
                }
                .shadow(
                    color: theme.cardShadowOpacity > 0 ? Color.black.opacity(theme.cardShadowOpacity) : .clear,
                    radius: theme.layout == .hardware ? 3 : 5,
                    x: 0,
                    y: theme.layout == .hardware ? 1.5 : 2
                )
                .padding(.horizontal, theme.cardHorizontalMargin)
        }
    }
}

func hex(_ v: UInt32) -> Color {
    Color(
        red: Double((v >> 16) & 0xFF) / 255.0,
        green: Double((v >> 8) & 0xFF) / 255.0,
        blue: Double(v & 0xFF) / 255.0
    )
}

private func nsHex(_ v: UInt32, alpha: CGFloat = 1.0) -> NSColor {
    NSColor(
        srgbRed: CGFloat((v >> 16) & 0xFF) / 255.0,
        green: CGFloat((v >> 8) & 0xFF) / 255.0,
        blue: CGFloat(v & 0xFF) / 255.0,
        alpha: alpha
    )
}

/// A colour that resolves per appearance (light, dark) at draw time.
func dyn(_ light: UInt32, _ dark: UInt32) -> Color {
    Color(nsColor: NSColor(name: nil) { $0.isDark ? nsHex(dark) : nsHex(light) })
}

/// A semi-transparent hairline colour that resolves per appearance (light, dark) at draw time.
func dynAlpha(_ light: UInt32, _ lightAlpha: CGFloat, _ dark: UInt32, _ darkAlpha: CGFloat) -> Color {
    Color(nsColor: NSColor(name: nil) {
        $0.isDark ? nsHex(dark, alpha: darkAlpha) : nsHex(light, alpha: lightAlpha)
    })
}

extension NSAppearance {
    var isDark: Bool { bestMatch(from: [.darkAqua, .aqua]) == .darkAqua }
}
