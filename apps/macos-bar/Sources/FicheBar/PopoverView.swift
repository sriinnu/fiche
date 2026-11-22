import AppKit
import SwiftUI

// MARK: - Tabs & Classifications

enum PopoverTab: String, CaseIterable, Identifiable {
    case activity = "Activity"
    case models = "Models"
    case stages = "Stages"
    case control = "Control"

    var id: String { rawValue }
}

private enum EngineMode: String {
    case optical = "OPTICAL"
    case text = "TEXT"
}

private enum ProviderFamily: String, CaseIterable, Identifiable {
    case anthropic = "Anthropic"
    case google = "Google Gemini"
    case openai = "OpenAI / Codex"
    case compat = "OpenAI-Compat"

    var id: String { rawValue }

    static func classify(_ item: ModelCatalogItem) -> ProviderFamily {
        let fam = item.family.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let id = item.id.lowercased()
        if fam == "anthropic" || id.hasPrefix("claude") {
            return .anthropic
        }
        if fam.contains("google") || fam.contains("gemini") || id.contains("gemini") {
            return .google
        }
        if fam.contains("openai") || fam.contains("codex") || id.hasPrefix("gpt") || id.hasPrefix("o1") || id.hasPrefix("o3") || id.hasPrefix("o4") {
            return .openai
        }
        return .compat
    }
}

private enum ModelClassification {
    private static let builtInStageIDs: Set<String> = [
        "optical-microfiche",
        "tscg-schema",
        "toon-structured",
        "acdc-epochs",
        "casi-delta",
    ]

    /// Validated or explicitly measured Gemini IDs matching `src/core/gemini-model-profiles.ts`.
    private static let measuredGeminiIDs: Set<String> = [
        "gemini-3.6-flash",
        "gemini-3.7-flash",
        "gemini-3.8-flash",
        "gemini-3.8-flash-high",
        "gemini-3.8-flash-medium",
        "gemini-3.8-flash-low",
        "gemini-3.1-flash",
        "gemini-3.1-flash-lite",
        "gemini-4",
        "gemini-4-flash",
        "gemini-4-pro",
        "gemini-4-argon",
        "gemini-4-argon-high",
        "gemini-4-argon-medium",
        "gemini-4-argon-low",
        "gemini-pro",
        "gemini-flash",
        "gemini",
    ]

    static let fallbackBuiltInStages: [PluginDescriptor] = [
        PluginDescriptor(
            id: "optical-microfiche",
            name: "Optical Microfiche",
            description: "Renders bulky stale context into dense lossless PNG pages for strong page readers.",
            kind: .stage,
            source: "optical",
            enabled: true,
            mutable: false
        ),
        PluginDescriptor(
            id: "tscg-schema",
            name: "TSCG Schema Compiler",
            description: "Deterministic prefix-safe tool schema and static system-prompt compaction.",
            kind: .stage,
            source: "pre-hygiene",
            enabled: true,
            mutable: false
        ),
        PluginDescriptor(
            id: "toon-structured",
            name: "TOON Structured Encoder",
            description: "Lossless tabular TOON encoding for repetitive JSON array payloads in tool outputs.",
            kind: .stage,
            source: "hygiene",
            enabled: true,
            mutable: false
        ),
        PluginDescriptor(
            id: "acdc-epochs",
            name: "ACDC Epoch Collapse",
            description: "Amortized cache-safe deterministic collapsing of older text history turns.",
            kind: .stage,
            source: "history",
            enabled: true,
            mutable: false
        ),
        PluginDescriptor(
            id: "casi-delta",
            name: "CASI Delta Deduplicator",
            description: "Content-addressed duplicate and delta referencing across live tool outputs.",
            kind: .stage,
            source: "hygiene",
            enabled: true,
            mutable: false
        ),
    ]

    static func isBuiltInStage(_ plugin: PluginDescriptor) -> Bool {
        plugin.kind == .stage || builtInStageIDs.contains(plugin.id)
    }

    /// Mirrors `src/core/reader-tier.ts` and `src/core/gemini-model-profiles.ts` so UI engine badges
    /// match runtime optical vs 4-layer text routing (e.g., `gemini-3.5-flash-lite` -> `TEXT`).
    static func engineMode(for model: String, hint: String? = nil) -> EngineMode {
        let stripped = model
            .lowercased()
            .replacingOccurrences(of: #"\[[^\]]*\]"#, with: "", options: .regularExpression)
        let base = stripped.split(separator: "/").last.map(String.init) ?? stripped

        // 1. Explicit text-only readers (`TEXT_ONLY` in reader-tier.ts)
        if base.range(of: #"claude-(?:opus|sonnet|haiku)-5[-.]5(?:[-@.:]|$)"#, options: .regularExpression) != nil
            || base.range(of: #"claude-haiku(?:[-@.:]|$)"#, options: .regularExpression) != nil
            || stripped.range(of: #"(?:^|[/.])grok(?:-|$)"#, options: .regularExpression) != nil
            || base.range(of: #"gpt-6(?:\.\d+)?-astra(?:-|$)"#, options: .regularExpression) != nil
            || base.contains("gemini-4-hydrogen")
            || base.contains("gemini-4-carbon")
            || base.contains("gemini-4-neon")
            || base.contains("deepseek")
            || base.contains("kimi")
            || base.contains("moonshot")
            || base == "glm"
            || base.hasPrefix("glm-")
            || base.contains("minimax")
        {
            return .text
        }

        // 2. Gemini optical gating (`hasGeminiMeasuredProfile` in gemini-model-profiles.ts)
        if base == "gemini" || base.hasPrefix("gemini-") {
            return hasGeminiMeasuredProfile(base) ? .optical : .text
        }

        // 3. Validated non-Gemini optical page readers (`IMAGE_READER` in reader-tier.ts)
        if base.contains("claude-fable-5")
            || base.range(of: #"gpt-(?:5\.6|6\.[12])-sol(?:-|$)"#, options: .regularExpression) != nil
        {
            return .optical
        }

        if let hint, hint.lowercased().contains("optical") {
            return .optical
        }
        return .text
    }

    private static func hasGeminiMeasuredProfile(_ id: String) -> Bool {
        if measuredGeminiIDs.contains(id) {
            return true
        }
        guard let regex = try? NSRegularExpression(pattern: #"^gemini-(\d+)(?:\.(\d+))?"#),
              let match = regex.firstMatch(in: id, range: NSRange(id.startIndex..., in: id)),
              let majorRange = Range(match.range(at: 1), in: id),
              let major = Int(id[majorRange])
        else {
            return false
        }
        let minor: Int
        if let minorRange = Range(match.range(at: 2), in: id), let parsedMinor = Int(id[minorRange]) {
            minor = parsedMinor
        } else {
            minor = 0
        }
        if major == 3 {
            return minor >= 8
        }
        return major > 3
    }
}

// MARK: - PopoverView

struct PopoverView: View {
    @ObservedObject var controller: DaemonController
    @State private var selectedTab: PopoverTab
    @State private var portDraft: String = ""
    @State private var logoWhisper: String? = nil
    @State private var livePulseActive: Bool = false
    @FocusState private var portFieldFocused: Bool
    @Namespace private var tabNamespace

    private let popoverWidth: CGFloat = 360

    init(controller: DaemonController, initialTab: PopoverTab = .activity) {
        self.controller = controller
        self._selectedTab = State(initialValue: initialTab)
    }

    var body: some View {
        let theme = Theme.of(controller.themeID)

        VStack(alignment: .leading, spacing: 0) {
            headerRow(theme: theme)

            if controller.phase == .stopped || (controller.lastError?.isEmpty == false) {
                offlineOrErrorBand(theme: theme)
                Spacer().frame(height: theme.usesInsetCards ? 8 : 6)
            }

            heroSavingsBand(theme: theme)

            tabBar(theme: theme)

            if !theme.usesInsetCards {
                Hairline()
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    switch selectedTab {
                    case .activity:
                        activityTab(theme: theme)
                    case .models:
                        modelsTab(theme: theme)
                    case .stages:
                        stagesTab(theme: theme)
                    case .control:
                        controlTab(theme: theme)
                    }
                }
                .padding(.bottom, theme.usesInsetCards ? 10 : 8)
            }
            .frame(minHeight: 280, maxHeight: 540)

            Hairline()

            footerRow(theme: theme)
        }
        .frame(width: popoverWidth)
        .themed(theme)
        .onAppear {
            portDraft = String(controller.daemonPort)
            controller.refreshNow()
            if !controller.isPreviewMode {
                withAnimation(.easeInOut(duration: 2.0).repeatForever(autoreverses: true)) {
                    livePulseActive = true
                }
            }
        }
        .onChange(of: controller.daemonPort) { _, newPort in
            if !portFieldFocused {
                portDraft = String(newPort)
            }
        }
    }

    // MARK: - Header Row

    private func headerRow(theme: Theme) -> some View {
        let status = phasePresentation(theme: theme)
        let savedPct = controller.stats?.savedPct ?? 0
        let savedTok = controller.stats?.savedInputTokens ?? 0
        let logoTooltip = savedTok > 0
            ? "Fiche optical aperture · \(Fmt.tokens(savedTok)) weighted saved (-\(Fmt.pct(savedPct))) — click to glint"
            : "Fiche optical aperture — click to glint"

        return HStack(spacing: 8) {
            FicheLogoMark(tooltip: logoTooltip) {
                triggerLogoWhisper(savedTokens: savedTok, savedPct: savedPct)
            }
            .frame(width: 22, height: 22)

            Text("fiche")
                .font(.headline)
                .fontWidth(theme.fontWidth)
                .foregroundStyle(theme.primaryText)

            Text("v\(controller.health?.version ?? "0.17.0")")
                .font(.footnote)
                .foregroundStyle(theme.tertiaryText)

            HStack(spacing: 4) {
                Circle()
                    .fill(status.color)
                    .frame(width: 6, height: 6)
                    .opacity(controller.phase == .live && livePulseActive ? 0.52 : 1.0)
                Text(status.label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(status.color)
            }

            if let logoWhisper {
                Text(logoWhisper)
                    .font(.system(size: 9.5, weight: .medium, design: theme.fontDesign))
                    .foregroundStyle(theme.accent)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1.5)
                    .background(theme.accent.opacity(0.11), in: Capsule())
                    .transition(.opacity.combined(with: .scale(scale: 0.92)))
                    .lineLimit(1)
            }

            Spacer(minLength: 4)

            if controller.phase == .stopped {
                HeaderIconButton(
                    symbol: "play.fill",
                    tint: theme.live,
                    help: "Start Daemon"
                ) {
                    Task { await controller.startDaemon() }
                }
                .disabled(controller.isBusy)
            } else if controller.phase == .starting {
                ProgressView()
                    .controlSize(.mini)
                    .frame(width: 24, height: 22)
            } else {
                let isPaused = controller.phase == .paused
                HeaderIconButton(
                    symbol: isPaused ? "play.fill" : "pause.fill",
                    tint: isPaused ? theme.live : theme.warn,
                    help: isPaused ? "Resume compression" : "Pause compression"
                ) {
                    controller.toggleCompression()
                }
            }

            HeaderIconButton(symbol: "arrow.clockwise", help: "Refresh (⌘R)") {
                controller.refreshNow()
            }
            .keyboardShortcut("r", modifiers: .command)

            HeaderIconButton(
                symbol: "macwindow",
                help: "Open Dashboard (http://127.0.0.1:\(controller.daemonPort)/)"
            ) {
                controller.openDashboard()
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func triggerLogoWhisper(savedTokens: Double, savedPct: Double) {
        let message: String
        if savedTokens > 0 {
            message = "-\(Fmt.pct(savedPct)) pruned"
        } else {
            message = "aperture primed"
        }
        withAnimation(.spring(response: 0.28, dampingFraction: 0.78)) {
            logoWhisper = message
        }
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1_700))
            withAnimation(.easeOut(duration: 0.25)) {
                if logoWhisper == message {
                    logoWhisper = nil
                }
            }
        }
    }

    private func phasePresentation(theme: Theme) -> (label: String, color: Color) {
        switch controller.phase {
        case .live: return ("Live", theme.live)
        case .paused: return ("Paused", theme.warn)
        case .starting: return ("Starting", theme.ready)
        case .stopped: return ("Off", theme.danger)
        }
    }

    // MARK: - Offline / Error Band

    private func offlineOrErrorBand(theme: Theme) -> some View {
        let isStopped = controller.phase == .stopped
        let symbol = isStopped ? "exclamationmark.triangle.fill" : "exclamationmark.circle.fill"
        let color = isStopped ? theme.warn : theme.danger
        let headline = isStopped ? "Daemon is offline" : "Daemon notice"
        let detail = controller.lastError ?? "Start the proxy on 127.0.0.1:\(controller.daemonPort) to capture turns."

        return Band {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: symbol)
                        .font(.subheadline)
                        .foregroundStyle(color)
                        .padding(.top, 1)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(headline)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(theme.primaryText)
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                HStack(spacing: 8) {
                    if isStopped {
                        Button("Start Daemon") {
                            Task { await controller.startDaemon() }
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(theme.accent)
                        .controlSize(.small)
                        .disabled(controller.isBusy)

                        if !controller.isLoginAgentInstalled {
                            Button("Install Login Agent") {
                                controller.installLoginAgent()
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(controller.isBusy)
                        }
                    }

                    Spacer()

                    Button("Log") {
                        controller.openErrLog()
                    }
                    .buttonStyle(.borderless)
                    .font(.footnote)
                    .foregroundStyle(theme.secondaryText)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
    }

    // MARK: - Hero Savings Band

    private func heroSavingsBand(theme: Theme) -> some View {
        let stats = controller.stats
        let savedTokens = stats?.savedInputTokens ?? 0
        let savedPct = stats?.savedPct ?? 0
        let baseTokens = stats?.baselineInputWeighted ?? 0
        let actualTokens = stats?.actualInputWeighted ?? 0
        let savedUsd = stats?.savedUsd ?? 0
        let cliffUsd = stats?.cliffSavedUsd ?? 0
        let pctColor = savedPct >= 1 ? theme.live : theme.secondaryText
        let sessionSavedRaw = controller.lastTurn?.session?.savedTokens ?? 0
        let weightedRatio: Double = {
            if baseTokens > 0 {
                return min(max(savedTokens / baseTokens, 0), 1)
            }
            return min(max(savedPct / 100.0, 0), 1)
        }()

        let weightedTooltip: String = {
            if sessionSavedRaw > 0 {
                return "Cache-weighted bill-equivalent tokens (cache reads weighted ~0.05×). Raw prompt tokens stripped this session: \(Fmt.tokens(sessionSavedRaw))."
            }
            return "Cache-weighted bill-equivalent tokens (cache reads weighted ~0.05×)."
        }()

        let usdTooltip: String = cliffUsd > 0
            ? "Estimated USD saved using \(controller.priceMode) pricing (includes \(Fmt.usd(cliffUsd)) context-cliff avoidance)."
            : "Estimated USD saved across weighted input & cache pricing (\(controller.priceMode) snapshot)."

        let ratioTooltip: String = {
            if savedPct >= 55 {
                return "Deep compaction: \(Fmt.pct(savedPct)) of weighted context stripped before upstream billing."
            }
            if savedPct >= 25 {
                return "Healthy compaction: \(Fmt.pct(savedPct)) weighted reduction (\(Fmt.tokens(actualTokens)) sent vs \(Fmt.tokens(baseTokens)) baseline)."
            }
            if savedPct > 0 {
                return "Active compaction: \(Fmt.pct(savedPct)) weighted reduction."
            }
            return "Awaiting compressible multi-turn traffic."
        }()

        return Band(isHero: true) {
            if theme.layout == .instrumentation {
                // Terminal live prompt telemetry header bar
                HStack(spacing: 6) {
                    Text("fiche@\(String(controller.daemonPort))")
                        .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                        .foregroundStyle(theme.accent)
                    Text("·")
                        .foregroundStyle(theme.tertiaryText)
                    Text(controller.phase == .live ? "live" : controller.phase.rawValue)
                        .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(phasePresentation(theme: theme).color)
                    Text("·")
                        .foregroundStyle(theme.tertiaryText)
                    Text(controller.priceMode)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(theme.secondaryText)
                    Spacer()
                    if let pid = controller.daemonPid {
                        Text("pid:\(String(pid))")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(theme.tertiaryText)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)

                Hairline()
            }

            HStack(alignment: .top, spacing: 0) {
                // Left: Tokens Saved (Weighted)
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text("TOKENS SAVED")
                            .font(.system(size: 10, weight: .semibold))
                            .tracking(0.6)
                            .foregroundStyle(theme.secondaryText)
                        if theme.layout == .hardware {
                            Spacer()
                            Text("CH·01")
                                .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                                .foregroundStyle(theme.tertiaryText)
                        }
                    }

                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(Fmt.tokens(savedTokens))
                            .font(.system(size: 22, weight: theme.bigNumberWeight, design: theme.fontDesign))
                            .fontWidth(theme.fontWidth)
                            .foregroundStyle(theme.primaryText)
                            .monospacedDigit()
                            .contentTransition(.numericText())

                        if savedPct > 0 || savedTokens > 0 {
                            Text("-\(Fmt.pct(savedPct))")
                                .font(.system(size: 10.5, weight: .semibold))
                                .monospacedDigit()
                                .foregroundStyle(pctColor)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1.5)
                                .background(
                                    pctColor.opacity(0.12),
                                    in: RoundedRectangle(cornerRadius: theme.badgeRadius, style: .continuous)
                                )
                                .overlay(
                                    RoundedRectangle(cornerRadius: theme.badgeRadius, style: .continuous)
                                        .strokeBorder(pctColor.opacity(0.30), lineWidth: 0.5)
                                )
                        }
                    }

                    Text(
                        baseTokens > 0
                            ? "\(Fmt.tokens(actualTokens)) / \(Fmt.tokens(baseTokens)) weighted"
                            : "awaiting traffic"
                    )
                    .font(.system(size: theme.layout == .instrumentation ? 10 : 11))
                    .foregroundStyle(theme.secondaryText)
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.84)
                }
                .padding(.horizontal, theme.usesInsetCards ? 14 : 16)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .help(weightedTooltip)

                VerticalHairline()

                // Right: Real USD Saved
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text("REAL USD SAVED")
                            .font(.system(size: 10, weight: .semibold))
                            .tracking(0.6)
                            .foregroundStyle(theme.secondaryText)
                        if theme.layout == .hardware {
                            Spacer()
                            Text("CH·02")
                                .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                                .foregroundStyle(theme.tertiaryText)
                        }
                    }

                    Text(Fmt.usd(savedUsd))
                        .font(.system(size: 22, weight: theme.bigNumberWeight, design: theme.fontDesign))
                        .fontWidth(theme.fontWidth)
                        .foregroundStyle(theme.primaryText)
                        .monospacedDigit()
                        .contentTransition(.numericText())

                    Text(
                        cliffUsd > 0
                            ? "\(controller.priceMode) · cliff +\(Fmt.usd(cliffUsd))"
                            : "\(controller.priceMode) pricing"
                    )
                    .font(.system(size: theme.layout == .instrumentation ? 10 : 11))
                    .foregroundStyle(theme.secondaryText)
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.88)
                }
                .padding(.horizontal, theme.usesInsetCards ? 14 : 16)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .help(usdTooltip)
            }
            .fixedSize(horizontal: false, vertical: true)

            HeroCompressionRatioBar(
                savedRatio: weightedRatio,
                savedPct: savedPct,
                hasTraffic: baseTokens > 0 || savedTokens > 0
            )
            .padding(.horizontal, theme.usesInsetCards ? 14 : 16)
            .padding(.bottom, 9)
            .help(ratioTooltip)

            Hairline()

            latestTurnStrip(theme: theme)
        }
    }

    private func latestTurnStrip(theme: Theme) -> some View {
        let turn = controller.lastTurn?.lastTurn
        let stripFontSize: CGFloat = theme.layout == .instrumentation ? 10 : (theme.usesInsetCards ? 11 : 11.5)

        return HStack(spacing: 5) {
            Circle()
                .fill(
                    controller.phase == .live
                        ? theme.live
                        : (controller.phase == .paused ? theme.warn : theme.tertiaryText.opacity(0.55))
                )
                .frame(width: 5, height: 5)
                .opacity(controller.phase == .live && livePulseActive ? 0.52 : 1.0)

            if let turn {
                HStack(spacing: 3) {
                    Text(Fmt.compactModelName(turn.model))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .minimumScaleFactor(0.90)

                    if turn.savedTokens > 0 {
                        Text("· -\(Fmt.tokens(turn.savedTokens))")
                            .foregroundStyle(theme.layout == .editorial ? theme.secondaryText : theme.primaryText)
                            .layoutPriority(1)
                    }

                    let stageText: String = {
                        if !turn.stages.isEmpty {
                            return turn.stages.prefix(4).map { Fmt.stageLabel($0) }.joined(separator: ", ")
                        }
                        return turn.compressed ? "compressed" : "passthrough"
                    }()

                    Text("· \(stageText)")
                        .lineLimit(1)
                        .layoutPriority(0.8)
                }
                .font(.system(size: stripFontSize))
                .foregroundStyle(theme.secondaryText)
                .monospacedDigit()

                Spacer(minLength: 4)

                if turn.savedUsd > 0 {
                    Text(Fmt.usd(turn.savedUsd))
                        .font(.system(size: stripFontSize, weight: .medium))
                        .foregroundStyle(theme.secondaryText)
                        .monospacedDigit()
                        .layoutPriority(1)
                }
            } else {
                let message: String = {
                    switch controller.phase {
                    case .live: return "Listening on :\(controller.daemonPort) · ready"
                    case .paused: return "Compression paused on :\(controller.daemonPort)"
                    case .starting: return "Starting proxy on :\(controller.daemonPort)…"
                    case .stopped: return "Proxy offline · :\(controller.daemonPort)"
                    }
                }()
                Text(message)
                    .font(.system(size: stripFontSize))
                    .foregroundStyle(theme.secondaryText)
                    .monospacedDigit()
                    .lineLimit(1)
                Spacer()
            }
        }
        .padding(.horizontal, theme.usesInsetCards ? 12 : 16)
        .padding(.vertical, 7)
        .help("Most recent request turn processed by the Fiche proxy.")
    }

    // MARK: - Segmented / Typographic / Hardware Tab Bar

    @ViewBuilder
    private func tabBar(theme: Theme) -> some View {
        switch theme.tabStyle {
        case .editorial:
            HStack(alignment: .firstTextBaseline, spacing: 14) {
                ForEach(Array(PopoverTab.allCases.enumerated()), id: \.element) { index, tab in
                    let active = tab == selectedTab
                    Button {
                        selectTab(tab)
                    } label: {
                        Text(tab.rawValue)
                            .font(.system(size: 13.5, weight: active ? .heavy : .medium))
                            .fontWidth(theme.fontWidth)
                            .foregroundStyle(active ? theme.primaryText : theme.secondaryText)
                            .padding(.vertical, 8)
                            .overlay(alignment: .bottom) {
                                if active {
                                    Rectangle()
                                        .fill(theme.accent)
                                        .frame(height: 2)
                                        .matchedGeometryEffect(id: "activeTabIndicator", in: tabNamespace)
                                }
                            }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
                Spacer()
            }
            .padding(.horizontal, 16)

        case .pillRail:
            HStack(spacing: 2) {
                ForEach(Array(PopoverTab.allCases.enumerated()), id: \.element) { index, tab in
                    let active = tab == selectedTab
                    Button {
                        selectTab(tab)
                    } label: {
                        Text(tab.rawValue)
                            .font(.system(size: 12, weight: active ? .semibold : .medium))
                            .foregroundStyle(active ? theme.primaryText : theme.secondaryText)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 5.5)
                            .background {
                                if active {
                                    RoundedRectangle(cornerRadius: 6.5, style: .continuous)
                                        .fill(theme.controlPill)
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 6.5, style: .continuous)
                                                .strokeBorder(theme.hairline, lineWidth: 0.5)
                                        )
                                        .shadow(color: .black.opacity(0.08), radius: 1.5, y: 0.5)
                                        .matchedGeometryEffect(id: "activeTabIndicator", in: tabNamespace)
                                }
                            }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
            }
            .padding(3)
            .background(
                theme.controlRail,
                in: RoundedRectangle(cornerRadius: 9, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .strokeBorder(theme.cardBorder, lineWidth: 0.5)
            )
            .padding(.horizontal, 12)
            .padding(.top, 9)
            .padding(.bottom, 3)

        case .hardwareKeys:
            // Braun / TE machined keycap selector channel with International Orange LED strip
            HStack(spacing: 3) {
                ForEach(Array(PopoverTab.allCases.enumerated()), id: \.element) { index, tab in
                    let active = tab == selectedTab
                    Button {
                        selectTab(tab)
                    } label: {
                        VStack(spacing: 3) {
                            Text(tab.rawValue.uppercased())
                                .font(.system(size: 10, weight: active ? .bold : .medium))
                                .tracking(0.5)
                                .foregroundStyle(active ? theme.primaryText : theme.secondaryText)

                            RoundedRectangle(cornerRadius: 1, style: .continuous)
                                .fill(active ? theme.accent : Color.white.opacity(0.08))
                                .frame(width: active ? 22 : 10, height: 2)
                                .matchedGeometryEffect(
                                    id: active ? "activeTabIndicator" : "inactive-\(tab.rawValue)",
                                    in: tabNamespace
                                )
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                        .background {
                            RoundedRectangle(cornerRadius: 4, style: .continuous)
                                .fill(active ? theme.controlPill : Color.white.opacity(0.02))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 4, style: .continuous)
                                        .strokeBorder(
                                            active ? Color.white.opacity(0.14) : Color.white.opacity(0.05),
                                            lineWidth: 0.75
                                        )
                                )
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
            }
            .padding(3)
            .background(
                theme.controlRail,
                in: RoundedRectangle(cornerRadius: 6, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.09), lineWidth: 1)
            )
            .padding(.horizontal, 12)
            .padding(.top, 9)
            .padding(.bottom, 3)

        case .terminal:
            // tmux-inspired crisp indexed tab strip
            HStack(spacing: 6) {
                ForEach(Array(PopoverTab.allCases.enumerated()), id: \.element) { index, tab in
                    let active = tab == selectedTab
                    Button {
                        selectTab(tab)
                    } label: {
                        HStack(spacing: 3) {
                            Text("\(index + 1):")
                                .foregroundStyle(active ? theme.accent : theme.tertiaryText)
                            Text(tab.rawValue.lowercased())
                                .fontWeight(active ? .bold : .regular)
                                .foregroundStyle(active ? theme.primaryText : theme.secondaryText)
                        }
                        .font(.system(size: 11, design: .monospaced))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 5.5)
                        .background {
                            if active {
                                RoundedRectangle(cornerRadius: 2, style: .continuous)
                                    .fill(theme.controlPill)
                                    .overlay(alignment: .bottom) {
                                        Rectangle()
                                            .fill(theme.accent)
                                            .frame(height: 1.5)
                                    }
                                    .matchedGeometryEffect(id: "activeTabIndicator", in: tabNamespace)
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
            }
            .padding(3)
            .background(
                theme.surface,
                in: RoundedRectangle(cornerRadius: 2, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .strokeBorder(theme.cardBorder, lineWidth: 1)
            )
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 2)

        case .celestialPills:
            // Apple Weather translucent twilight capsules
            HStack(spacing: 4) {
                ForEach(Array(PopoverTab.allCases.enumerated()), id: \.element) { index, tab in
                    let active = tab == selectedTab
                    Button {
                        selectTab(tab)
                    } label: {
                        Text(tab.rawValue)
                            .font(.system(size: 12, weight: active ? .semibold : .medium, design: .rounded))
                            .foregroundStyle(active ? theme.primaryText : theme.secondaryText)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 5.5)
                            .background {
                                if active {
                                    Capsule()
                                        .fill(theme.controlPill)
                                        .overlay(
                                            Capsule()
                                                .strokeBorder(theme.accent.opacity(0.32), lineWidth: 0.75)
                                        )
                                        .matchedGeometryEffect(id: "activeTabIndicator", in: tabNamespace)
                                }
                            }
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
            }
            .padding(3)
            .background(theme.controlRail.opacity(0.85), in: Capsule())
            .overlay(Capsule().strokeBorder(theme.cardBorder, lineWidth: 0.5))
            .padding(.horizontal, 12)
            .padding(.top, 9)
            .padding(.bottom, 3)
        }
    }

    private func selectTab(_ tab: PopoverTab) {
        withAnimation(.spring(response: 0.28, dampingFraction: 0.82)) {
            selectedTab = tab
        }
    }

    // MARK: - Tab 1: Activity

    private func activityTab(theme: Theme) -> some View {
        let modelRows = controller.sortedByModelStats
        let stats = controller.stats

        return VStack(alignment: .leading, spacing: 0) {
            SectionHeader(
                title: "By Model",
                trailing: modelRows.isEmpty ? nil : "\(modelRows.count)"
            )

            Band {
                if modelRows.isEmpty {
                    Text(
                        controller.phase == .stopped
                            ? "Start the daemon to inspect live model savings."
                            : "No per-model traffic recorded yet."
                    )
                    .font(.subheadline)
                    .foregroundStyle(theme.secondaryText)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                } else {
                    ForEach(Array(modelRows.enumerated()), id: \.element.model) { idx, row in
                        if idx > 0 { Hairline(inset: 14) }
                        activityModelRow(model: row.model, stats: row.stats, theme: theme)
                    }
                }
            }

            if let session = controller.lastTurn?.session, session.turns > 0 {
                SectionHeader(title: "Active Session")
                Band {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("\(session.turns) turns · \(session.compressedTurns) compressed")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(theme.primaryText)
                                .monospacedDigit()
                            if let hit = session.avgCacheHitPct {
                                Text("Avg cache hit \(Int(hit.rounded()))%")
                                    .font(.caption)
                                    .foregroundStyle(theme.secondaryText)
                                    .monospacedDigit()
                            }
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 1) {
                            Text("-\(Fmt.tokens(session.savedTokens)) raw")
                                .font(.subheadline.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(theme.live)
                            Text(Fmt.usd(session.savedUsd))
                                .font(.caption)
                                .foregroundStyle(theme.secondaryText)
                                .monospacedDigit()
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .help("Raw uncached + cached prompt tokens stripped across \(session.turns) turns in the active session (top KPI shows cache-weighted bill-equivalent tokens).")
                }
            }

            SectionHeader(title: "Lifetime")
            Band {
                HStack(spacing: 0) {
                    lifetimeStatCell(
                        label: "Requests",
                        value: "\(stats?.requests ?? 0)",
                        theme: theme
                    )
                    VerticalHairline()
                    lifetimeStatCell(
                        label: "Compressed",
                        value: "\(stats?.compressedRequests ?? 0)",
                        theme: theme
                    )
                    VerticalHairline()
                    lifetimeStatCell(
                        label: "Render Cache",
                        value: renderCacheLabel(stats?.renderCache),
                        theme: theme
                    )
                    .help(renderCacheTooltip(stats?.renderCache))
                }
            }
        }
    }

    private func activityModelRow(model: String, stats: ModelStats, theme: Theme) -> some View {
        let engine = ModelClassification.engineMode(for: model)

        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(model)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(theme.primaryText)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(model)

                    engineBadge(engine, theme: theme)
                }

                Text("\(stats.compressedRequests)/\(stats.requests) requests")
                    .font(.caption)
                    .foregroundStyle(theme.secondaryText)
                    .monospacedDigit()
            }

            Spacer(minLength: 6)

            VStack(alignment: .trailing, spacing: 2) {
                HStack(spacing: 4) {
                    if stats.savedPct >= 0.5 {
                        Text("-\(Fmt.pct(stats.savedPct))")
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(theme.live)
                    } else if stats.savedInputTokens > 0 {
                        Text("-\(Fmt.tokens(stats.savedInputTokens))")
                            .font(.subheadline.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(theme.live)
                    } else {
                        Text("0%")
                            .font(.subheadline)
                            .monospacedDigit()
                            .foregroundStyle(theme.secondaryText)
                    }
                }

                Text(Fmt.usd(stats.savedUsd))
                    .font(.caption)
                    .foregroundStyle(theme.secondaryText)
                    .monospacedDigit()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
    }

    private func lifetimeStatCell(label: String, value: String, theme: Theme) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(theme.secondaryText)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(theme.primaryText)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.85)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func renderCacheLabel(_ cache: RenderCacheStats?) -> String {
        guard let cache else { return "—" }
        if let hit = cache.hitRatePct {
            return "\(Int(hit.rounded()))% · \(Fmt.megabytes(cache.bytes))M"
        }
        if cache.bytes > 0 {
            return "\(Fmt.megabytes(cache.bytes)) MB"
        }
        return "\(cache.entries) pg"
    }

    private func renderCacheTooltip(_ cache: RenderCacheStats?) -> String {
        guard let cache else { return "Rendered microfiche PNG cache." }
        return "Rendered microfiche PNG cache: \(cache.entries) pages (\(Fmt.megabytes(cache.bytes)) MB), \(cache.hits) hits / \(cache.misses) misses."
    }

    // MARK: - Tab 2: Models

    private func modelsTab(theme: Theme) -> some View {
        let activeSet = Set(controller.allowedModels)
        let catalog = controller.mergedModelsCatalog
        let isOnline = controller.phase != .stopped

        let grouped: [(family: ProviderFamily, items: [ModelCatalogItem])] = ProviderFamily.allCases.compactMap { family in
            let items = catalog.filter { ProviderFamily.classify($0) == family }
            return items.isEmpty ? nil : (family, items)
        }

        return VStack(alignment: .leading, spacing: 0) {
            if !controller.compressionEnabled && isOnline {
                Text("Compression is paused — scope changes take effect on resume.")
                    .font(.caption)
                    .foregroundStyle(theme.warn)
                    .padding(.horizontal, 16)
                    .padding(.top, 6)
                    .padding(.bottom, 2)
            }

            ForEach(grouped, id: \.family) { group in
                let activeCount = group.items.filter { activeSet.contains($0.id) }.count

                if group.family == .compat {
                    SectionHeader(
                        title: group.family.rawValue,
                        trailing: "\(activeCount)/\(group.items.count)",
                        actionLabel: activeCount > 0 ? "Disable all" : "Enable all",
                        actionTint: activeCount > 0 ? theme.danger : theme.accent,
                        actionDisabled: !isOnline || controller.isBusy
                    ) {
                        if activeCount > 0 {
                            controller.disableAllThirdPartyModels()
                        } else {
                            controller.enableAllThirdPartyModels()
                        }
                    }
                } else {
                    SectionHeader(
                        title: group.family.rawValue,
                        trailing: "\(activeCount)/\(group.items.count)"
                    )
                }

                Band {
                    ForEach(Array(group.items.enumerated()), id: \.element.id) { idx, item in
                        if idx > 0 { Hairline(inset: 14) }
                        modelToggleRow(
                            item: item,
                            isOn: activeSet.contains(item.id),
                            isOnline: isOnline,
                            theme: theme
                        )
                    }
                }
            }
        }
    }

    private func modelToggleRow(
        item: ModelCatalogItem,
        isOn: Bool,
        isOnline: Bool,
        theme: Theme
    ) -> some View {
        let engine = ModelClassification.engineMode(for: item.id, hint: item.hint)

        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(item.label)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(theme.primaryText)
                        .lineLimit(1)
                    engineBadge(engine, theme: theme)
                }

                Text(item.id)
                    .font(.caption.monospaced())
                    .foregroundStyle(theme.secondaryText)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Toggle(
                "",
                isOn: Binding(
                    get: { isOn },
                    set: { next in controller.toggleModel(model: item.id, on: next) }
                )
            )
            .labelsHidden()
            .toggleStyle(FicheSwitchToggleStyle())
            .disabled(!isOnline)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }

    // MARK: - Tab 3: Stages

    private func stagesTab(theme: Theme) -> some View {
        let isOnline = controller.phase != .stopped
        let hasLivePlugins = !controller.plugins.isEmpty
        let builtInStages = hasLivePlugins
            ? controller.plugins.filter { ModelClassification.isBuiltInStage($0) }
            : ModelClassification.fallbackBuiltInStages
        let discoveredItems = hasLivePlugins
            ? controller.plugins.filter { !ModelClassification.isBuiltInStage($0) }
            : []
        let thirdPartyItems = controller.thirdPartyPlugins
        let hasEnabledThirdParty = controller.hasEnabledThirdPartyPlugins

        return VStack(alignment: .leading, spacing: 0) {
            SectionHeader(
                title: "Compiler Stages",
                trailing: "\(builtInStages.filter(\.enabled).count)/\(builtInStages.count)"
            )

            Band {
                ForEach(Array(builtInStages.enumerated()), id: \.element.id) { idx, stage in
                    if idx > 0 { Hairline(inset: 14) }
                    pluginRow(stage, isOnline: isOnline && hasLivePlugins, kindOverride: .stage, theme: theme)
                }
            }

            if thirdPartyItems.isEmpty {
                SectionHeader(
                    title: "Plugins & Skills",
                    trailing: discoveredItems.isEmpty ? nil : "\(discoveredItems.count)"
                )
            } else {
                SectionHeader(
                    title: "Plugins & Skills",
                    trailing: "\(controller.enabledThirdPartyPluginsCount)/\(thirdPartyItems.count)",
                    actionLabel: hasEnabledThirdParty ? "Disable 3rd-party" : "Enable 3rd-party",
                    actionTint: hasEnabledThirdParty ? theme.danger : theme.accent,
                    actionDisabled: !isOnline || controller.isBusy
                ) {
                    controller.setAllThirdPartyPlugins(enabled: !hasEnabledThirdParty)
                }
            }

            Band {
                if discoveredItems.isEmpty {
                    let message: String = {
                        if !isOnline {
                            return "Start daemon to inspect ~/.fiche/plugins & ~/.agents/skills."
                        }
                        if !controller.pluginsEndpointSupported {
                            return "Connected daemon does not expose /api/plugins."
                        }
                        return "No custom plugins or skills found in ~/.fiche/plugins or ~/.agents/skills."
                    }()

                    Text(message)
                        .font(.subheadline)
                        .foregroundStyle(theme.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                } else {
                    ForEach(Array(discoveredItems.enumerated()), id: \.element.id) { idx, plugin in
                        if idx > 0 { Hairline(inset: 14) }
                        pluginRow(plugin, isOnline: isOnline, kindOverride: nil, theme: theme)
                    }
                }
            }

            HStack {
                Text("~/.fiche/plugins · ~/.agents/skills")
                    .font(.caption)
                    .foregroundStyle(theme.secondaryText)
                    .lineLimit(1)
                Spacer()
                Button {
                    controller.openPluginsFolder()
                } label: {
                    Label("Open ~/.fiche/plugins", systemImage: "folder")
                        .font(.footnote)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 4)
        }
    }

    private func pluginRow(
        _ plugin: PluginDescriptor,
        isOnline: Bool,
        kindOverride: PluginKind?,
        theme: Theme
    ) -> some View {
        let displayKind = kindOverride ?? plugin.kind
        let badgeColor = displayKind == .stage ? theme.accent : theme.secondaryText

        return HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(plugin.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(theme.primaryText)
                        .lineLimit(1)

                    Text(displayKind.badgeTitle)
                        .font(.system(size: 9, weight: .semibold, design: .monospaced))
                        .foregroundStyle(badgeColor)
                        .padding(.horizontal, 4.5)
                        .padding(.vertical, 1)
                        .background(
                            badgeColor.opacity(0.11),
                            in: RoundedRectangle(cornerRadius: theme.badgeRadius, style: .continuous)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: theme.badgeRadius, style: .continuous)
                                .strokeBorder(badgeColor.opacity(0.28), lineWidth: 0.5)
                        )
                }

                if let desc = plugin.description, !desc.isEmpty {
                    Text(desc)
                        .font(.caption)
                        .foregroundStyle(theme.secondaryText)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 8)

            if plugin.mutable {
                Toggle(
                    "",
                    isOn: Binding(
                        get: { plugin.enabled },
                        set: { next in controller.togglePlugin(id: plugin.id, enabled: next) }
                    )
                )
                .labelsHidden()
                .toggleStyle(FicheSwitchToggleStyle())
                .disabled(!isOnline)
            } else {
                Text("Built-in")
                    .font(.caption)
                    .foregroundStyle(theme.tertiaryText)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
    }

    // MARK: - Tab 4: Control

    private func controlTab(theme: Theme) -> some View {
        let isOnline = controller.phase != .stopped

        return VStack(alignment: .leading, spacing: 0) {
            SectionHeader(title: "Appearance & Proxy")

            Band {
                // 1-click 5-theme visual swatch grid
                VStack(alignment: .leading, spacing: 8) {
                    Text("Theme")
                        .font(.subheadline)
                        .foregroundStyle(theme.primaryText)

                    HStack(spacing: 6) {
                        ForEach(ThemeID.allCases) { id in
                            ThemeSwatchButton(
                                id: id,
                                isSelected: controller.themeID == id,
                                hostAccent: theme.accent
                            ) {
                                withAnimation(.spring(response: 0.28, dampingFraction: 0.8)) {
                                    controller.themeID = id
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)

                Hairline(inset: 14)

                // Compression Live vs Paused
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Compression")
                            .font(.subheadline)
                            .foregroundStyle(theme.primaryText)
                        Text(
                            !isOnline
                                ? "Daemon offline"
                                : (controller.compressionEnabled ? "Live — active pipeline" : "Paused — passthrough")
                        )
                        .font(.caption)
                        .foregroundStyle(theme.secondaryText)
                    }
                    Spacer()
                    Toggle(
                        "",
                        isOn: Binding(
                            get: { controller.compressionEnabled },
                            set: { next in
                                Task { await controller.setCompression(enabled: next) }
                            }
                        )
                    )
                    .labelsHidden()
                    .toggleStyle(FicheSwitchToggleStyle())
                    .disabled(!isOnline || controller.isBusy)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)

                Hairline(inset: 14)

                // 1-click Disable/Enable all third-party models
                let thirdParty = controller.enabledThirdPartyModels
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Third-party models")
                            .font(.subheadline)
                            .foregroundStyle(theme.primaryText)
                        Text(
                            thirdParty.isEmpty
                                ? "Off · Claude, Gemini & OpenAI only"
                                : "\(thirdParty.count) enabled · \(thirdParty.joined(separator: ", "))"
                        )
                        .font(.caption)
                        .foregroundStyle(theme.secondaryText)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    }
                    Spacer(minLength: 6)
                    if thirdParty.isEmpty {
                        Button("Enable") {
                            controller.enableAllThirdPartyModels()
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(!isOnline || controller.isBusy)
                    } else {
                        Button("Disable all") {
                            controller.disableAllThirdPartyModels()
                        }
                        .buttonStyle(.bordered)
                        .tint(theme.danger)
                        .controlSize(.small)
                        .disabled(!isOnline || controller.isBusy)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .help("Toggle all third-party model families (DeepSeek, Kimi, GLM, Grok) with one click.")

                Hairline(inset: 14)

                // 1-click toggle for all 3rd-party plugins & extensions
                let thirdPartyExt = controller.thirdPartyPlugins
                let activeExtCount = controller.enabledThirdPartyPluginsCount
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("3rd-party plugins & skills")
                            .font(.subheadline)
                            .foregroundStyle(theme.primaryText)
                        Text(
                            thirdPartyExt.isEmpty
                                ? "None discovered"
                                : (activeExtCount > 0
                                    ? "\(activeExtCount)/\(thirdPartyExt.count) active · plugins & skills"
                                    : "All disabled (\(thirdPartyExt.count) installed)")
                        )
                        .font(.caption)
                        .foregroundStyle(theme.secondaryText)
                        .lineLimit(1)
                    }
                    Spacer()
                    Toggle(
                        "",
                        isOn: Binding(
                            get: { controller.hasEnabledThirdPartyPlugins },
                            set: { next in controller.setAllThirdPartyPlugins(enabled: next) }
                        )
                    )
                    .labelsHidden()
                    .toggleStyle(FicheSwitchToggleStyle())
                    .disabled(!isOnline || controller.isBusy || thirdPartyExt.isEmpty)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .help("Toggle all external ~/.fiche/plugins & ~/.agents/skills entries while keeping built-in stages and fiche active.")

                Hairline(inset: 14)

                // Auto-start daemon
                HStack {
                    Text("Auto-start daemon")
                        .font(.subheadline)
                        .foregroundStyle(theme.primaryText)
                    Spacer()
                    Toggle("", isOn: $controller.autoStartDaemon)
                        .labelsHidden()
                        .toggleStyle(FicheSwitchToggleStyle())
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)

                Hairline(inset: 14)

                // Start at login (launchd)
                HStack {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Start at login (launchd)")
                            .font(.subheadline)
                            .foregroundStyle(theme.primaryText)
                        Text("com.sriinnu.fiche.plist")
                            .font(.caption.monospaced())
                            .foregroundStyle(theme.secondaryText)
                    }
                    Spacer()
                    Toggle(
                        "",
                        isOn: Binding(
                            get: { controller.isLoginAgentInstalled },
                            set: { enabled in controller.setLoginAgent(enabled: enabled) }
                        )
                    )
                    .labelsHidden()
                    .toggleStyle(FicheSwitchToggleStyle())
                    .disabled(controller.isBusy)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)

                Hairline(inset: 14)

                // Port & Poll Interval
                HStack(spacing: 8) {
                    Text("Port")
                        .font(.subheadline)
                        .foregroundStyle(theme.primaryText)

                    TextField("47821", text: $portDraft)
                        .textFieldStyle(.roundedBorder)
                        .font(.footnote.monospaced())
                        .frame(width: 68)
                        .focused($portFieldFocused)
                        .onSubmit { commitPortDraft() }
                        .onChange(of: portFieldFocused) { _, focused in
                            if !focused { commitPortDraft() }
                        }

                    Spacer()

                    Text("Poll")
                        .font(.subheadline)
                        .foregroundStyle(theme.secondaryText)

                    Picker("", selection: $controller.pollIntervalSeconds) {
                        Text("2s").tag(2.0)
                        Text("3s").tag(3.0)
                        Text("5s").tag(5.0)
                        Text("10s").tag(10.0)
                    }
                    .labelsHidden()
                    .pickerStyle(.menu)
                    .controlSize(.small)
                    .frame(width: 62)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)

                let installedApps = DaemonController.discoverInstalledDesktopApps()
                if !installedApps.isEmpty {
                    Hairline(inset: 14)

                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Desktop app proxy")
                                .font(.subheadline)
                                .foregroundStyle(theme.primaryText)
                            Text("Warp provider apps via Fiche")
                                .font(.caption)
                                .foregroundStyle(theme.secondaryText)
                                .lineLimit(1)
                        }
                        Spacer()
                        Menu {
                            ForEach(installedApps, id: \.self) { appName in
                                Button("Open \(appName)") {
                                    controller.launchDesktopAppViaFiche(appName)
                                }
                            }
                        } label: {
                            Label("Launch", systemImage: "arrow.up.forward.app")
                                .font(.caption.weight(.medium))
                        }
                        .menuStyle(.borderedButton)
                        .controlSize(.small)
                        .disabled(!isOnline || controller.isBusy)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 7)
                }
            }

            HStack(spacing: 8) {
                if !isOnline {
                    Button("Start Daemon") {
                        Task { await controller.startDaemon() }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(controller.isBusy)
                }

                Button("Restart Daemon") {
                    Task { await controller.restartDaemon() }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(controller.isBusy)

                Button("Stop Daemon") {
                    Task { await controller.stopDaemon() }
                }
                .buttonStyle(.bordered)
                .tint(theme.danger)
                .controlSize(.small)
                .disabled(!isOnline || controller.isBusy)

                Spacer()

                Button("Log") {
                    controller.openErrLog()
                }
                .buttonStyle(.borderless)
                .font(.footnote)
                .foregroundStyle(theme.secondaryText)
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 4)
        }
    }

    private func commitPortDraft() {
        let trimmed = portDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if let parsed = Int(trimmed), (1024...65_535).contains(parsed) {
            controller.daemonPort = parsed
        } else {
            portDraft = String(controller.daemonPort)
        }
    }

    // MARK: - Footer Row

    private func footerRow(theme: Theme) -> some View {
        HStack(spacing: 2) {
            Text(footerTelemetry(theme: theme))
                .font(.footnote)
                .foregroundStyle(theme.secondaryText)
                .monospacedDigit()
                .lineLimit(1)

            Spacer(minLength: 4)

            FooterIconButton(
                symbol: "heart.fill",
                help: "Sponsor Fiche on GitHub",
                tint: Color(nsColor: .systemPink)
            ) {
                controller.openSponsor()
            }

            FooterIconButton(symbol: "info.circle", help: "About FicheBar") {
                AboutWindowController.shared.show(
                    theme: theme,
                    daemonVersion: controller.daemonVersion
                )
            }

            FooterIconButton(symbol: "folder", help: "Open ~/.fiche") {
                controller.openFicheHomeFolder()
            }

            FooterIconButton(symbol: "safari", help: "Open Dashboard (:\(controller.daemonPort))") {
                controller.openDashboard()
            }

            Menu {
                Button("Quit Menubar Only") {
                    controller.quitMenubarOnly()
                }
                Button("Stop Daemon & Quit", role: .destructive) {
                    controller.stopDaemonAndQuit()
                }
                .disabled(controller.phase == .stopped)
            } label: {
                Image(systemName: "power")
                    .font(.subheadline)
                    .foregroundStyle(theme.secondaryText)
                    .frame(width: 24, height: 22)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .tint(theme.secondaryText)
            .fixedSize()
            .help("Quit FicheBar")
            .accessibilityLabel("Quit")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private func footerTelemetry(theme: Theme) -> String {
        var parts = [":\(controller.daemonPort)"]
        if controller.phase == .stopped {
            parts.append("offline")
        } else {
            if let pid = controller.daemonPid {
                parts.append(theme.layout == .hardware ? "PID \(pid)" : "pid \(pid)")
            }
            if let up = controller.uptimeSec {
                parts.append(theme.layout == .hardware ? "UP \(Fmt.uptime(up))" : "up \(Fmt.uptime(up))")
            }
        }
        return parts.joined(separator: theme.layout == .instrumentation ? " | " : " · ")
    }

    // MARK: - Shared Helpers

    private func engineBadge(_ mode: EngineMode, theme: Theme) -> some View {
        let color: Color = mode == .optical ? theme.accent : theme.secondaryText
        let tooltip = mode == .optical
            ? "Optical Microfiche + 4-layer text hygiene active for this validated reader."
            : "4-layer prefix-safe text hygiene only (no rasterized images sent)."

        return Text(mode.rawValue)
            .font(.system(size: 8.5, weight: .semibold, design: .monospaced))
            .foregroundStyle(color)
            .padding(.horizontal, 4.5)
            .padding(.vertical, 1)
            .background(
                color.opacity(0.11),
                in: RoundedRectangle(cornerRadius: theme.badgeRadius, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: theme.badgeRadius, style: .continuous)
                    .strokeBorder(color.opacity(0.28), lineWidth: 0.5)
            )
            .help(tooltip)
    }
}

// MARK: - Theme-Native Hero Compression Ratio Bar

private struct HeroCompressionRatioBar: View {
    @Environment(\.theme) private var theme
    let savedRatio: Double
    let savedPct: Double
    let hasTraffic: Bool

    var body: some View {
        let clamped = min(max(savedRatio, 0), 1)

        HStack(spacing: 8) {
            switch theme.layout {
            case .editorial:
                // Razor-thin Swiss ink rule with split tick
                GeometryReader { geo in
                    let w = geo.size.width
                    let fillW = hasTraffic ? max(2, w * clamped) : 0
                    ZStack(alignment: .leading) {
                        Rectangle()
                            .fill(Color.black.opacity(0.09))
                            .frame(height: 2.5)

                        if fillW > 0 {
                            Rectangle()
                                .fill(theme.live)
                                .frame(width: fillW, height: 2.5)

                            Rectangle()
                                .fill(theme.primaryText)
                                .frame(width: 1, height: 6.5)
                                .offset(x: max(0, fillW - 0.5))
                        }
                    }
                    .frame(maxHeight: .infinity, alignment: .center)
                }
                .frame(height: 8)
                .animation(.spring(response: 0.45, dampingFraction: 0.78), value: clamped)

                Text(hasTraffic ? "\(Fmt.pct(savedPct)) pruned" : "0% pruned")
                    .font(.system(size: 9.5, weight: .medium, design: theme.fontDesign))
                    .foregroundStyle(theme.secondaryText)
                    .monospacedDigit()
                    .lineLimit(1)

            case .controlCenter:
                // Apple smooth capsule meter
                GeometryReader { geo in
                    let w = geo.size.width
                    let fillW = hasTraffic ? max(8, w * clamped) : 0
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(theme.controlRail)
                            .overlay(
                                Capsule().strokeBorder(theme.hairline, lineWidth: 0.5)
                            )
                        if fillW > 0 {
                            Capsule()
                                .fill(
                                    LinearGradient(
                                        colors: [theme.accent, theme.live],
                                        startPoint: .leading,
                                        endPoint: .trailing
                                    )
                                )
                                .frame(width: fillW)
                        }
                    }
                }
                .frame(height: 6)
                .animation(.spring(response: 0.45, dampingFraction: 0.78), value: clamped)

                Text(hasTraffic ? "\(Fmt.pct(savedPct)) saved" : "0%")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(theme.secondaryText)
                    .monospacedDigit()
                    .lineLimit(1)

            case .hardware:
                // Braun / TE 20-segment LED instrument meter
                Text("RATIO")
                    .font(.system(size: 8.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(theme.tertiaryText)

                HStack(spacing: 2) {
                    let count = 20
                    let litCount = hasTraffic ? max(1, Int((clamped * Double(count)).rounded())) : 0
                    ForEach(0..<count, id: \.self) { idx in
                        let isLit = idx < litCount
                        let isLead = idx == litCount - 1 && litCount > 0
                        RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                            .fill(
                                isLit
                                    ? (isLead ? hex(0xFF7D4D) : theme.accent)
                                    : Color.white.opacity(0.08)
                            )
                            .frame(maxWidth: .infinity)
                            .frame(height: 6)
                    }
                }
                .animation(.spring(response: 0.45, dampingFraction: 0.78), value: clamped)

                Text(hasTraffic ? Fmt.pct(savedPct) : "0%")
                    .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(hasTraffic ? theme.accent : theme.tertiaryText)
                    .monospacedDigit()
                    .lineLimit(1)

            case .instrumentation:
                // Terminal bracketed block meter `[▓▓▓▓▓▓▓░░░░░░░░]`
                HStack(spacing: 3) {
                    Text("[")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(theme.tertiaryText)

                    HStack(spacing: 1.5) {
                        let count = 16
                        let litCount = hasTraffic ? max(1, Int((clamped * Double(count)).rounded())) : 0
                        ForEach(0..<count, id: \.self) { idx in
                            Rectangle()
                                .fill(idx < litCount ? theme.live : Color.white.opacity(0.10))
                                .frame(maxWidth: .infinity)
                                .frame(height: 7)
                        }
                    }

                    Text("]")
                        .font(.system(size: 10, weight: .bold, design: .monospaced))
                        .foregroundStyle(theme.tertiaryText)
                }
                .animation(.spring(response: 0.45, dampingFraction: 0.78), value: clamped)

                Text(hasTraffic ? "\(Fmt.pct(savedPct)) saved" : "0%")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(hasTraffic ? theme.live : theme.tertiaryText)
                    .monospacedDigit()
                    .lineLimit(1)

            case .celestial:
                // Apple Weather aurora twilight capsule gauge
                GeometryReader { geo in
                    let w = geo.size.width
                    let fillW = hasTraffic ? max(8, w * clamped) : 0
                    ZStack(alignment: .leading) {
                        Capsule()
                            .fill(theme.controlRail)
                            .overlay(Capsule().strokeBorder(theme.cardBorder, lineWidth: 0.5))

                        if fillW > 0 {
                            Capsule()
                                .fill(
                                    LinearGradient(
                                        colors: [theme.accent, theme.accentSecondary],
                                        startPoint: .leading,
                                        endPoint: .trailing
                                    )
                                )
                                .frame(width: fillW)
                                .overlay(alignment: .trailing) {
                                    Circle()
                                        .fill(Color.white.opacity(0.92))
                                        .frame(width: 4, height: 4)
                                        .padding(.trailing, 1)
                                }
                        }
                    }
                }
                .frame(height: 6)
                .animation(.spring(response: 0.45, dampingFraction: 0.78), value: clamped)

                Text(hasTraffic ? "\(Fmt.pct(savedPct)) saved" : "0%")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(theme.secondaryText)
                    .monospacedDigit()
                    .lineLimit(1)
            }
        }
    }
}

// MARK: - Miniature Theme Swatches & Controls

private struct ThemeSwatchButton: View {
    @Environment(\.theme) private var theme
    let id: ThemeID
    let isSelected: Bool
    let hostAccent: Color
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        let preview = Theme.of(id)

        Button(action: action) {
            VStack(spacing: 4) {
                swatchMiniature(preview: preview)
                    .frame(height: 28)
                    .clipShape(RoundedRectangle(cornerRadius: previewCorner, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: previewCorner, style: .continuous)
                            .strokeBorder(
                                isSelected ? hostAccent : preview.hairline,
                                lineWidth: isSelected ? 1.6 : 0.75
                            )
                    )
                    .scaleEffect(isHovered && !isSelected ? 1.04 : 1.0)

                Text(id.label)
                    .font(.system(size: 9.5, weight: isSelected ? .semibold : .regular))
                    .foregroundStyle(isSelected ? theme.primaryText : theme.secondaryText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(TactileScaleButtonStyle())
        .onHover { hovering in
            withAnimation(.spring(response: 0.22, dampingFraction: 0.75)) {
                isHovered = hovering
            }
        }
        .help("Switch to \(id.label) theme")
    }

    private var previewCorner: CGFloat {
        switch id {
        case .editorial: return 3
        case .native: return 6
        case .slate: return 4
        case .terminal: return 2
        case .midnight: return 7
        }
    }

    @ViewBuilder
    private func swatchMiniature(preview: Theme) -> some View {
        switch id {
        case .editorial:
            ZStack(alignment: .topLeading) {
                preview.swatchGround
                VStack(alignment: .leading, spacing: 3) {
                    Rectangle()
                        .fill(preview.swatchAccent)
                        .frame(width: 18, height: 2.5)
                    Rectangle()
                        .fill(Color.black.opacity(0.14))
                        .frame(height: 0.75)
                    Spacer(minLength: 0)
                }
                .padding(.top, 5)
                .padding(.horizontal, 5)
                Text("Aa")
                    .font(.system(size: 9, weight: .heavy))
                    .fontWidth(.condensed)
                    .foregroundStyle(preview.primaryText)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(4)
            }

        case .native:
            ZStack(alignment: .topLeading) {
                preview.swatchGround
                RoundedRectangle(cornerRadius: 3.5, style: .continuous)
                    .fill(preview.surface)
                    .overlay(
                        RoundedRectangle(cornerRadius: 3.5, style: .continuous)
                            .strokeBorder(preview.cardBorder, lineWidth: 0.5)
                    )
                    .padding(3.5)
                Capsule()
                    .fill(preview.swatchAccent)
                    .frame(width: 14, height: 3.5)
                    .padding(.top, 7)
                    .padding(.leading, 7)
                Text("Aa")
                    .font(.system(size: 8.5, weight: .semibold))
                    .foregroundStyle(preview.primaryText)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(6)
            }

        case .slate:
            ZStack(alignment: .topLeading) {
                preview.swatchGround
                RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                    .fill(preview.heroSurface)
                    .padding(3.5)
                HStack(spacing: 2) {
                    RoundedRectangle(cornerRadius: 0.8).fill(preview.swatchAccent).frame(width: 4, height: 2.5)
                    RoundedRectangle(cornerRadius: 0.8).fill(preview.swatchAccent).frame(width: 4, height: 2.5)
                    RoundedRectangle(cornerRadius: 0.8).fill(Color.white.opacity(0.18)).frame(width: 4, height: 2.5)
                }
                .padding(.top, 7)
                .padding(.leading, 7)
                Text("Aa")
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(preview.primaryText)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(6)
            }

        case .terminal:
            ZStack(alignment: .topLeading) {
                preview.swatchGround
                HStack(spacing: 2) {
                    Text("//")
                        .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                        .foregroundStyle(preview.accent)
                    Rectangle()
                        .fill(preview.swatchAccent)
                        .frame(width: 10, height: 3)
                }
                .padding(.top, 5)
                .padding(.leading, 5)
                Text("Aa")
                    .font(.system(size: 8.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(preview.primaryText)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(4)
            }

        case .midnight:
            ZStack(alignment: .topLeading) {
                LinearGradient(
                    colors: [preview.groundTop ?? preview.ground, preview.ground],
                    startPoint: .top,
                    endPoint: .bottom
                )
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [preview.accent, preview.accentSecondary],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: 15, height: 3.5)
                    .padding(.top, 6)
                    .padding(.leading, 5)
                Text("Aa")
                    .font(.system(size: 8.5, weight: .bold, design: .rounded))
                    .foregroundStyle(preview.primaryText)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(4.5)
            }
        }
    }
}

private struct TactileScaleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.95 : 1.0)
            .animation(.spring(response: 0.20, dampingFraction: 0.72), value: configuration.isPressed)
    }
}

/// Custom theme-calibrated switch so every theme stays crisp and unmistakable even in unfocused popovers & snapshots.
private struct FicheSwitchToggleStyle: ToggleStyle {
    func makeBody(configuration: Configuration) -> some View {
        FicheSwitchBody(configuration: configuration)
    }
}

private struct FicheSwitchBody: View {
    @Environment(\.theme) private var theme
    @Environment(\.isEnabled) private var isEnabled
    let configuration: ToggleStyle.Configuration

    var body: some View {
        let isOn = configuration.isOn
        let width: CGFloat = theme.layout == .hardware ? 30 : 28
        let height: CGFloat = 16
        let corner: CGFloat = {
            switch theme.layout {
            case .hardware: return 4
            case .instrumentation: return 2
            case .editorial, .controlCenter, .celestial: return height / 2
            }
        }()

        Button {
            withAnimation(.spring(response: 0.24, dampingFraction: 0.74)) {
                configuration.isOn.toggle()
            }
        } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .fill(trackFill(isOn: isOn))
                    .overlay {
                        RoundedRectangle(cornerRadius: corner, style: .continuous)
                            .strokeBorder(trackBorder(isOn: isOn), lineWidth: 0.75)
                    }

                thumbView(isOn: isOn)
                    .padding(2)
            }
            .frame(width: width, height: height)
            .opacity(isEnabled ? 1.0 : 0.45)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(isOn ? "On" : "Off")
    }

    private func trackFill(isOn: Bool) -> AnyShapeStyle {
        if !isOn {
            if theme.layout == .editorial {
                return AnyShapeStyle(Color.black.opacity(0.09))
            }
            return AnyShapeStyle(theme.controlRail)
        }
        switch theme.layout {
        case .editorial, .controlCenter:
            return AnyShapeStyle(theme.accent)
        case .hardware:
            return AnyShapeStyle(theme.accent)
        case .instrumentation:
            return AnyShapeStyle(theme.live)
        case .celestial:
            return AnyShapeStyle(
                LinearGradient(
                    colors: [theme.accent, theme.accentSecondary],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
        }
    }

    private func trackBorder(isOn: Bool) -> Color {
        if isOn {
            return .clear
        }
        return theme.layout == .editorial ? Color.black.opacity(0.16) : theme.cardBorder
    }

    @ViewBuilder
    private func thumbView(isOn: Bool) -> some View {
        switch theme.layout {
        case .hardware:
            RoundedRectangle(cornerRadius: 2.5, style: .continuous)
                .fill(hex(0xF3F0EA))
                .frame(width: 12, height: 12)
                .overlay {
                    Rectangle()
                        .fill(Color.black.opacity(0.28))
                        .frame(width: 1, height: 6)
                }
                .shadow(color: .black.opacity(0.28), radius: 1, y: 0.5)

        case .instrumentation:
            RoundedRectangle(cornerRadius: 1, style: .continuous)
                .fill(isOn ? theme.primaryText : theme.secondaryText)
                .frame(width: 11, height: 12)

        case .editorial, .controlCenter, .celestial:
            Circle()
                .fill(.white)
                .frame(width: 12, height: 12)
                .shadow(color: .black.opacity(0.18), radius: 1.2, y: 0.6)
        }
    }
}

// MARK: - Native List Primitives

private struct SectionHeader: View {
    @Environment(\.theme) private var theme
    let title: String
    var trailing: String? = nil
    var actionLabel: String? = nil
    var actionTint: Color? = nil
    var actionDisabled: Bool = false
    var onAction: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 4) {
                if theme.layout == .instrumentation {
                    Text("//")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(theme.accent)
                }
                Text(title.uppercased())
                    .font(.system(size: theme.layout == .hardware ? 10 : 11, weight: .semibold))
                    .fontWidth(theme.fontWidth)
                    .tracking(theme.layout == .hardware ? 0.8 : 0.6)
                    .foregroundStyle(theme.secondaryText)
            }
            Spacer()
            if let actionLabel, let onAction {
                Button(actionLabel, action: onAction)
                    .buttonStyle(.plain)
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(actionDisabled ? theme.tertiaryText : (actionTint ?? theme.accent))
                    .disabled(actionDisabled)
            }
            if let trailing, !trailing.isEmpty {
                Text(trailing)
                    .font(.footnote)
                    .monospacedDigit()
                    .foregroundStyle(theme.secondaryText)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 4)
    }
}

private struct HeaderIconButton: View {
    @Environment(\.theme) private var theme
    @State private var isHovered = false
    let symbol: String
    var tint: Color? = nil
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.subheadline)
                .foregroundStyle(tint ?? theme.secondaryText)
                .frame(width: 24, height: 22)
                .background(
                    isHovered ? theme.controlRail : .clear,
                    in: RoundedRectangle(cornerRadius: theme.layout == .instrumentation ? 2 : 5, style: .continuous)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(TactileScaleButtonStyle())
        .onHover { isHovered = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}

private struct FooterIconButton: View {
    @Environment(\.theme) private var theme
    @State private var isHovered = false
    let symbol: String
    let help: String
    var tint: Color? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.subheadline)
                .foregroundStyle(tint ?? theme.secondaryText)
                .frame(width: 24, height: 22)
                .background(
                    isHovered ? theme.controlRail : .clear,
                    in: RoundedRectangle(cornerRadius: theme.layout == .instrumentation ? 2 : 5, style: .continuous)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(TactileScaleButtonStyle())
        .onHover { isHovered = $0 }
        .help(help)
        .accessibilityLabel(help)
    }
}
