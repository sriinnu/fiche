import AppKit
import SwiftUI

// MARK: - Concept A Full-Color Vector Logo (SwiftUI)

/// Full-color vector SwiftUI rendering of `assets/fiche-mark.svg`:
/// Obsidian squircle tile (`#0B0D14` with `#1E293B` border), three S-curve optical
/// compression ribbons (warm -> magenta -> cyan), crisp white microfiche aperture frame,
/// and 6-facet prismatic crystal core.
struct FicheLogoMark: View {
    var tooltip: String = "Fiche optical aperture — click to glint"
    var onTap: (() -> Void)? = nil

    @State private var isHovered = false
    @State private var tiltSign: Double = 1
    @State private var tiltAngle: Double = 0
    @State private var bounceScale: CGFloat = 1.0
    @State private var glintProgress: CGFloat = -0.9
    @State private var sparkleOpacity: Double = 0
    @State private var sparkleScale: CGFloat = 0.4
    @State private var glintGeneration: Int = 0

    var body: some View {
        Button {
            triggerGlint()
            onTap?()
        } label: {
            ZStack {
                logoCanvas
                    .overlay {
                        // Crisp white specular prism sweep clipped to the obsidian squircle tile
                        GeometryReader { geo in
                            let w = geo.size.width
                            let h = geo.size.height
                            let corner = w * (52.0 / 256.0)
                            LinearGradient(
                                stops: [
                                    .init(color: .clear, location: 0.0),
                                    .init(color: .white.opacity(0.08), location: 0.35),
                                    .init(color: .white.opacity(0.65), location: 0.50),
                                    .init(color: .white.opacity(0.08), location: 0.65),
                                    .init(color: .clear, location: 1.0),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                            .frame(width: w * 0.72, height: h * 1.4)
                            .rotationEffect(.degrees(18))
                            .offset(x: glintProgress * w * 1.45, y: -h * 0.2)
                            .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
                            .allowsHitTesting(false)
                        }
                    }
                    .overlay(alignment: .topTrailing) {
                        // Crisp four-point specular crystal sparkle (zero neon)
                        PrismSparkle()
                            .fill(.white)
                            .frame(width: 7, height: 7)
                            .scaleEffect(sparkleScale)
                            .opacity(sparkleOpacity)
                            .offset(x: -3, y: 4)
                            .allowsHitTesting(false)
                    }
            }
            .scaleEffect((isHovered ? 1.05 : 1.0) * bounceScale)
            .rotationEffect(.degrees(tiltAngle))
            .contentShape(Rectangle())
        }
        .buttonStyle(LogoPressStyle())
        .onHover { hovering in
            withAnimation(.spring(response: 0.24, dampingFraction: 0.72)) {
                isHovered = hovering
            }
        }
        .help(tooltip)
        .accessibilityLabel("Fiche logo")
    }

    private func triggerGlint() {
        glintGeneration &+= 1
        let gen = glintGeneration
        tiltSign *= -1
        glintProgress = -0.9
        sparkleOpacity = 0
        sparkleScale = 0.4

        withAnimation(.spring(response: 0.28, dampingFraction: 0.48)) {
            bounceScale = 1.12
            tiltAngle = 8.0 * tiltSign
        }
        withAnimation(.easeOut(duration: 0.42)) {
            glintProgress = 1.15
        }
        withAnimation(.spring(response: 0.24, dampingFraction: 0.62)) {
            sparkleOpacity = 0.95
            sparkleScale = 1.15
        }

        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(160))
            guard glintGeneration == gen else { return }
            withAnimation(.spring(response: 0.36, dampingFraction: 0.65)) {
                bounceScale = 1.0
                tiltAngle = 0
            }
            try? await Task.sleep(for: .milliseconds(140))
            guard glintGeneration == gen else { return }
            withAnimation(.easeOut(duration: 0.22)) {
                sparkleOpacity = 0
                sparkleScale = 0.5
            }
        }
    }

    private var logoCanvas: some View {
        Canvas { context, size in
            let side = min(size.width, size.height)
            guard side > 0 else { return }

            let unit = side / 256.0
            let ox = (size.width - side) * 0.5
            let oy = (size.height - side) * 0.5

            // Outer obsidian squircle tile: rect(8, 8, 240, 240, rx=52)
            let tileRect = CGRect(
                x: ox + 8.0 * unit,
                y: oy + 8.0 * unit,
                width: 240.0 * unit,
                height: 240.0 * unit
            )
            let tileRadius = 52.0 * unit
            let tilePath = Path(roundedRect: tileRect, cornerRadius: tileRadius, style: .continuous)
            context.fill(tilePath, with: .color(hex(0x0B0D14)))
            context.stroke(tilePath, with: .color(hex(0x1E293B)), lineWidth: max(0.75, 3.0 * unit))

            // Inner artwork group: translate(22, 22) scale(0.828)
            var inner = context
            inner.translateBy(x: ox + 22.0 * unit, y: oy + 22.0 * unit)
            inner.scaleBy(x: 0.828 * unit, y: 0.828 * unit)

            // 1. Top S-curve ribbon (warm coral -> orange -> amber)
            let topRibbon = Path { p in
                p.move(to: CGPoint(x: 14, y: 74))
                p.addLine(to: CGPoint(x: 62, y: 74))
                p.addCurve(to: CGPoint(x: 127, y: 109), control1: CGPoint(x: 88, y: 74), control2: CGPoint(x: 96, y: 109))
                p.addLine(to: CGPoint(x: 127, y: 119))
                p.addCurve(to: CGPoint(x: 62, y: 102), control1: CGPoint(x: 90, y: 119), control2: CGPoint(x: 82, y: 102))
                p.addLine(to: CGPoint(x: 14, y: 102))
                p.closeSubpath()
            }
            inner.fill(
                topRibbon,
                with: .linearGradient(
                    Gradient(stops: [
                        .init(color: hex(0xFF4D5A), location: 0.0),
                        .init(color: hex(0xFF6B2B), location: 0.52),
                        .init(color: hex(0xFFB020), location: 1.0),
                    ]),
                    startPoint: CGPoint(x: 14, y: 96),
                    endPoint: CGPoint(x: 127, y: 96)
                )
            )

            // 2. Middle S-curve ribbon (purple -> magenta -> rose)
            let midRibbon = Path { p in
                p.move(to: CGPoint(x: 14, y: 114))
                p.addLine(to: CGPoint(x: 62, y: 114))
                p.addCurve(to: CGPoint(x: 127, y: 123), control1: CGPoint(x: 88, y: 114), control2: CGPoint(x: 96, y: 123))
                p.addLine(to: CGPoint(x: 127, y: 133))
                p.addCurve(to: CGPoint(x: 62, y: 142), control1: CGPoint(x: 96, y: 133), control2: CGPoint(x: 88, y: 142))
                p.addLine(to: CGPoint(x: 14, y: 142))
                p.closeSubpath()
            }
            inner.fill(
                midRibbon,
                with: .linearGradient(
                    Gradient(stops: [
                        .init(color: hex(0x9333EA), location: 0.0),
                        .init(color: hex(0xC026D3), location: 0.52),
                        .init(color: hex(0xF43F8E), location: 1.0),
                    ]),
                    startPoint: CGPoint(x: 14, y: 128),
                    endPoint: CGPoint(x: 127, y: 128)
                )
            )

            // 3. Bottom S-curve ribbon (cyan -> sky -> cobalt)
            let botRibbon = Path { p in
                p.move(to: CGPoint(x: 14, y: 154))
                p.addLine(to: CGPoint(x: 62, y: 154))
                p.addCurve(to: CGPoint(x: 127, y: 137), control1: CGPoint(x: 82, y: 154), control2: CGPoint(x: 90, y: 137))
                p.addLine(to: CGPoint(x: 127, y: 147))
                p.addCurve(to: CGPoint(x: 62, y: 182), control1: CGPoint(x: 96, y: 147), control2: CGPoint(x: 88, y: 182))
                p.addLine(to: CGPoint(x: 14, y: 182))
                p.closeSubpath()
            }
            inner.fill(
                botRibbon,
                with: .linearGradient(
                    Gradient(stops: [
                        .init(color: hex(0x06E3F5), location: 0.0),
                        .init(color: hex(0x0EA5E9), location: 0.52),
                        .init(color: hex(0x3B82F6), location: 1.0),
                    ]),
                    startPoint: CGPoint(x: 14, y: 160),
                    endPoint: CGPoint(x: 127, y: 160)
                )
            )

            // 4. Crisp white square microfiche frame with open optical aperture slit
            let framePath = Path { p in
                p.move(to: CGPoint(x: 129, y: 104))
                p.addLine(to: CGPoint(x: 129, y: 79))
                p.addLine(to: CGPoint(x: 227, y: 79))
                p.addLine(to: CGPoint(x: 227, y: 177))
                p.addLine(to: CGPoint(x: 129, y: 177))
                p.addLine(to: CGPoint(x: 129, y: 152))
                p.addLine(to: CGPoint(x: 114, y: 152))
                p.addLine(to: CGPoint(x: 114, y: 192))
                p.addLine(to: CGPoint(x: 242, y: 192))
                p.addLine(to: CGPoint(x: 242, y: 64))
                p.addLine(to: CGPoint(x: 114, y: 64))
                p.addLine(to: CGPoint(x: 114, y: 104))
                p.closeSubpath()
            }
            inner.fill(framePath, with: .color(.white))

            // 5. 6-facet prismatic crystal core
            inner.fill(triangle((178, 102), (165, 128), (152, 128)), with: .color(hex(0xFF5447)))
            inner.fill(
                triangle((178, 102), (191, 128), (165, 128)),
                with: .linearGradient(
                    Gradient(colors: [hex(0xFFD166), hex(0xFF70A6)]),
                    startPoint: CGPoint(x: 165, y: 102),
                    endPoint: CGPoint(x: 191, y: 128)
                )
            )
            inner.fill(triangle((178, 102), (204, 128), (191, 128)), with: .color(hex(0x22D3EE)))
            inner.fill(triangle((152, 128), (165, 128), (178, 154)), with: .color(hex(0xF43F5E)))
            inner.fill(
                triangle((165, 128), (191, 128), (178, 154)),
                with: .linearGradient(
                    Gradient(colors: [hex(0xC084FC), hex(0x9333EA)]),
                    startPoint: CGPoint(x: 165, y: 128),
                    endPoint: CGPoint(x: 191, y: 154)
                )
            )
            inner.fill(triangle((191, 128), (204, 128), (178, 154)), with: .color(hex(0x3B82F6)))
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }

    private func triangle(_ a: (CGFloat, CGFloat), _ b: (CGFloat, CGFloat), _ c: (CGFloat, CGFloat)) -> Path {
        Path { p in
            p.move(to: CGPoint(x: a.0, y: a.1))
            p.addLine(to: CGPoint(x: b.0, y: b.1))
            p.addLine(to: CGPoint(x: c.0, y: c.1))
            p.closeSubpath()
        }
    }
}

private struct LogoPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.90 : 1.0)
            .animation(.spring(response: 0.20, dampingFraction: 0.65), value: configuration.isPressed)
    }
}

/// Crisp 4-point specular glint star for the faceted crystal core.
private struct PrismSparkle: Shape {
    func path(in rect: CGRect) -> Path {
        let cx = rect.midX
        let cy = rect.midY
        let rx = rect.width * 0.5
        let ry = rect.height * 0.5
        let inner = min(rx, ry) * 0.24
        return Path { p in
            p.move(to: CGPoint(x: cx, y: cy - ry))
            p.addQuadCurve(to: CGPoint(x: cx + rx, y: cy), control: CGPoint(x: cx + inner, y: cy - inner))
            p.addQuadCurve(to: CGPoint(x: cx, y: cy + ry), control: CGPoint(x: cx + inner, y: cy + inner))
            p.addQuadCurve(to: CGPoint(x: cx - rx, y: cy), control: CGPoint(x: cx - inner, y: cy + inner))
            p.addQuadCurve(to: CGPoint(x: cx, y: cy - ry), control: CGPoint(x: cx - inner, y: cy - inner))
            p.closeSubpath()
        }
    }
}

// MARK: - Monochrome Template Menu Bar Icon (AppKit NSImage)

@MainActor
enum FicheMenuBarIcon {
    private static var cache: [DaemonPhase: NSImage] = [:]

    /// Returns a crisp 18×18 monochrome template `NSImage` (`isTemplate = true`) matching the
    /// Concept A silhouette (3 optical compression ribbons feeding into the square microfiche
    /// aperture frame with a faceted crystal diamond). macOS tints it automatically in light
    /// and dark menu bars.
    static func makeTemplateImage(phase: DaemonPhase) -> NSImage {
        if let cached = cache[phase] {
            return cached
        }

        let size = NSSize(width: 18, height: 18)
        let img = NSImage(size: size, flipped: true) { _ in
            let baseAlpha: CGFloat
            switch phase {
            case .live: baseAlpha = 1.0
            case .paused: baseAlpha = 0.88
            case .starting: baseAlpha = 0.72
            case .stopped: baseAlpha = 0.44
            }

            let ink = { (alpha: CGFloat) in
                NSColor.black.withAlphaComponent(baseAlpha * alpha).setFill()
            }

            // Three sleek curved aperture ribbons feeding into the microfiche slit
            let topRibbon = NSBezierPath()
            topRibbon.move(to: NSPoint(x: 1.0, y: 4.3))
            topRibbon.line(to: NSPoint(x: 3.6, y: 4.3))
            topRibbon.curve(
                to: NSPoint(x: 7.6, y: 6.7),
                controlPoint1: NSPoint(x: 5.3, y: 4.3),
                controlPoint2: NSPoint(x: 5.9, y: 6.7)
            )
            topRibbon.line(to: NSPoint(x: 7.6, y: 7.65))
            topRibbon.curve(
                to: NSPoint(x: 3.6, y: 6.0),
                controlPoint1: NSPoint(x: 5.6, y: 7.65),
                controlPoint2: NSPoint(x: 4.9, y: 6.0)
            )
            topRibbon.line(to: NSPoint(x: 1.0, y: 6.0))
            topRibbon.close()
            ink(1.0)
            topRibbon.fill()

            let midRibbon = NSBezierPath()
            midRibbon.move(to: NSPoint(x: 1.0, y: 8.15))
            midRibbon.line(to: NSPoint(x: 3.6, y: 8.15))
            midRibbon.curve(
                to: NSPoint(x: 7.6, y: 8.52),
                controlPoint1: NSPoint(x: 5.3, y: 8.15),
                controlPoint2: NSPoint(x: 5.9, y: 8.52)
            )
            midRibbon.line(to: NSPoint(x: 7.6, y: 9.48))
            midRibbon.curve(
                to: NSPoint(x: 3.6, y: 9.85),
                controlPoint1: NSPoint(x: 5.9, y: 9.48),
                controlPoint2: NSPoint(x: 5.3, y: 9.85)
            )
            midRibbon.line(to: NSPoint(x: 1.0, y: 9.85))
            midRibbon.close()
            ink(0.86)
            midRibbon.fill()

            let botRibbon = NSBezierPath()
            botRibbon.move(to: NSPoint(x: 1.0, y: 12.0))
            botRibbon.line(to: NSPoint(x: 3.6, y: 12.0))
            botRibbon.curve(
                to: NSPoint(x: 7.6, y: 10.35),
                controlPoint1: NSPoint(x: 4.9, y: 12.0),
                controlPoint2: NSPoint(x: 5.6, y: 10.35)
            )
            botRibbon.line(to: NSPoint(x: 7.6, y: 11.3))
            botRibbon.curve(
                to: NSPoint(x: 3.6, y: 13.7),
                controlPoint1: NSPoint(x: 5.9, y: 11.3),
                controlPoint2: NSPoint(x: 5.3, y: 13.7)
            )
            botRibbon.line(to: NSPoint(x: 1.0, y: 13.7))
            botRibbon.close()
            ink(1.0)
            botRibbon.fill()

            // Square microfiche frame with open optical aperture slit
            let frame = NSBezierPath()
            frame.move(to: NSPoint(x: 8.7, y: 6.6))
            frame.line(to: NSPoint(x: 8.7, y: 5.5))
            frame.line(to: NSPoint(x: 15.7, y: 5.5))
            frame.line(to: NSPoint(x: 15.7, y: 12.5))
            frame.line(to: NSPoint(x: 8.7, y: 12.5))
            frame.line(to: NSPoint(x: 8.7, y: 11.4))
            frame.line(to: NSPoint(x: 7.4, y: 11.4))
            frame.line(to: NSPoint(x: 7.4, y: 13.8))
            frame.line(to: NSPoint(x: 17.0, y: 13.8))
            frame.line(to: NSPoint(x: 17.0, y: 4.2))
            frame.line(to: NSPoint(x: 7.4, y: 4.2))
            frame.line(to: NSPoint(x: 7.4, y: 6.6))
            frame.close()
            ink(1.0)
            frame.fill()

            // Inner aperture glyph: 6-facet crystal (live/starting/stopped) or twin pause bars (paused)
            if phase == .paused {
                ink(1.0)
                let leftBar = NSBezierPath(roundedRect: NSRect(x: 10.6, y: 6.9, width: 1.2, height: 4.2), xRadius: 0.45, yRadius: 0.45)
                let rightBar = NSBezierPath(roundedRect: NSRect(x: 12.6, y: 6.9, width: 1.2, height: 4.2), xRadius: 0.45, yRadius: 0.45)
                leftBar.fill()
                rightBar.fill()
            } else {
                drawFacet((12.2, 6.6), (11.1, 9.0), (9.9, 9.0), alpha: baseAlpha * 0.80)
                drawFacet((12.2, 6.6), (13.3, 9.0), (11.1, 9.0), alpha: baseAlpha * 0.52)
                drawFacet((12.2, 6.6), (14.5, 9.0), (13.3, 9.0), alpha: baseAlpha * 0.96)
                drawFacet((9.9, 9.0), (11.1, 9.0), (12.2, 11.4), alpha: baseAlpha * 0.64)
                drawFacet((11.1, 9.0), (13.3, 9.0), (12.2, 11.4), alpha: baseAlpha * 0.90)
                drawFacet((13.3, 9.0), (14.5, 9.0), (12.2, 11.4), alpha: baseAlpha * 0.56)
            }

            // Stopped state: crisp diagonal slash with knockout halo
            if phase == .stopped {
                let slash = NSBezierPath()
                slash.move(to: NSPoint(x: 2.2, y: 15.2))
                slash.line(to: NSPoint(x: 15.8, y: 2.8))
                slash.lineCapStyle = .round

                if let ctx = NSGraphicsContext.current {
                    ctx.saveGraphicsState()
                    ctx.compositingOperation = .clear
                    slash.lineWidth = 2.6
                    NSColor.black.setStroke()
                    slash.stroke()
                    ctx.restoreGraphicsState()
                }

                slash.lineWidth = 1.35
                NSColor.black.withAlphaComponent(0.88).setStroke()
                slash.stroke()
            }

            return true
        }

        img.isTemplate = true
        cache[phase] = img
        return img
    }

    private static func drawFacet(
        _ a: (CGFloat, CGFloat),
        _ b: (CGFloat, CGFloat),
        _ c: (CGFloat, CGFloat),
        alpha: CGFloat
    ) {
        let path = NSBezierPath()
        path.move(to: NSPoint(x: a.0, y: a.1))
        path.line(to: NSPoint(x: b.0, y: b.1))
        path.line(to: NSPoint(x: c.0, y: c.1))
        path.close()
        NSColor.black.withAlphaComponent(alpha).setFill()
        path.fill()
    }
}
