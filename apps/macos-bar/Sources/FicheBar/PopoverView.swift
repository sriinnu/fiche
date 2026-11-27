import AppKit
import SwiftUI

// MARK: - Tabs & Classifications

enum PopoverTab: String, CaseIterable, Identifiable {
    case activity = "Activity"
    case agents = "Agents"
    case models = "Models"
    case stages = "Stages"
    case control = "Control"

    var id: String { rawValue }
}

enum HeroScope: String, CaseIterable, Identifiable {
    case lifetime = "Lifetime"
    case today = "Today"

    var id: String { rawValue }
}

enum DailyChartMetric: String, CaseIterable, Identifiable {
    case tokens = "Tokens"
    case usd = "USD"

    var id: String { rawValue }
}

private enum EngineMode: String {
    case optical = "OPTICAL"
    case hybrid = "HYBRID"
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
        "lsm-context",
        "context-mmu",
        "skill-linker",
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
        PluginDescriptor(
            id: "lsm-context",
            name: "LSM-Context Hierarchy",
            description: "Multi-level LSM history compaction tiers for long-running sessions.",
            kind: .stage,
            source: "history",
            enabled: true,
            mutable: false
        ),
        PluginDescriptor(
            id: "context-mmu",
            name: "Context-MMU Virtual Memory",
            description: "Virtual context paging, Markovian causal episode folding, and live-tail hydration.",
            kind: .stage,
            source: "history",
            enabled: true,
            mutable: false
        ),
        PluginDescriptor(
            id: "skill-linker",
            name: "Session Skill Linker",
            description: "Turn-1 pinned skill catalog stubbing with speculative Turn-N auto-hydration.",
            kind: .stage,
            source: "pre-hygiene",
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
            || base.range(of: #"claude-(?:[\d.-]+)?haiku(?:[-@.:]|$)"#, options: .regularExpression) != nil
            || stripped.range(of: #"(?:^|[/.])grok(?:-|$)"#, options: .regularExpression) != nil
            || base.range(of: #"gpt-(?:[6-9]|\d{2,})(?:\.\d+)?-astra(?:-|$)"#, options: .regularExpression) != nil
            || base.contains("gemini-4-hydrogen")
            || base.contains("gemini-4-carbon")
            || base.contains("gemini-4-neon")
            || base.contains("deepseek")
            || base.contains("kimi")
            || base.contains("moonshot")
            || stripped.range(of: #"(?:^|[/._-])glm(?:-|$)"#, options: .regularExpression) != nil
            || base.contains("minimax")
            || base.contains("qwen")
            || base.contains("llama")
            || base.hasPrefix("mistral")
            || base.hasPrefix("mixtral")
            || base.hasPrefix("codestral")
            || base.hasPrefix("devstral")
            || base.hasPrefix("ministral")
            || base.hasPrefix("magistral")
            || base.hasPrefix("pixtral")
            || base.hasPrefix("command-")
            || base.hasPrefix("c4ai-aya")
            || base.hasPrefix("gemma")
            || base.hasPrefix("gpt-oss")
            || base.hasPrefix("sonar")
            || base.hasPrefix("nova")
            || base.hasPrefix("jamba")
            || base.hasPrefix("mercury")
            || base.hasPrefix("solar")
            || base.range(of: #"^step-\d"#, options: .regularExpression) != nil
        {
            return .text
        }

        // 2. Gemini optical gating (`hasGeminiMeasuredProfile` in gemini-model-profiles.ts)
        if base == "gemini" || base.hasPrefix("gemini-") {
            return hasGeminiMeasuredProfile(base) ? .optical : .text
        }

        // 3. Validated non-Gemini optical page readers (`IMAGE_READER` in reader-tier.ts)
        if base.contains("claude-fable-5")
            || base.range(of: #"gpt-(?:5\.6|(?:[6-9]|\d{2,})(?:\.\d+)?)-sol(?:-|$)"#, options: .regularExpression) != nil
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
    @State private var showAllCLIs: Bool = false
    @State private var showMoreProviders: Bool = false
    @State private var koshaSyncAllProviders: Bool = false
    @State private var expandedModelFamilies: Set<ProviderFamily> = []
    @State private var expandedFAQ: Set<String> = []
    @State private var portDraft: String = ""
    @State private var logoWhisper: String? = nil
    @State private var whisperGeneration: Int = 0
    @State private var hasAppliedInitialTab: Bool = false
    @State private var livePulseActive: Bool = false
    @FocusState private var portFieldFocused: Bool
    @Namespace private var tabNamespace

    private let popoverWidth: CGFloat = 360
    private let initialTab: PopoverTab?

    init(controller: DaemonController, initialTab: PopoverTab? = nil) {
        self.controller = controller
        self.initialTab = initialTab
    }

    private func lossColor(theme: Theme) -> Color {
        theme.layout == .editorial ? theme.danger : theme.warn
    }

    private var maxScrollHeight: CGFloat {
        let screenHeight = NSApp.keyWindow?.screen?.visibleFrame.height
            ?? NSScreen.main?.visibleFrame.height
            ?? 900
        return min(540, max(240, screenHeight - 310))
    }

    var body: some View {
        let theme = Theme.of(controller.themeID)

        VStack(alignment: .leading, spacing: 0) {
            headerRow(theme: theme)

            if let notice = controller.transientNotice {
                transientNoticeBanner(notice, theme: theme)
            }

            if let actionErr = controller.actionError, !actionErr.isEmpty {
                actionErrorBanner(actionErr, theme: theme)
                Spacer().frame(height: theme.usesInsetCards ? 8 : 6)
            }

            if controller.phase == .stopped || (controller.daemonError?.isEmpty == false) {
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
                    switch controller.selectedTab {
                    case .activity:
                        activityTab(theme: theme)
                    case .agents:
                        agentsTab(theme: theme)
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
            .frame(minHeight: min(280, maxScrollHeight), maxHeight: maxScrollHeight)

            Hairline()

            footerRow(theme: theme)
        }
        .frame(width: popoverWidth)
        .themed(theme)
        .onAppear {
            if let initialTab, !hasAppliedInitialTab {
                hasAppliedInitialTab = true
                controller.selectedTab = initialTab
            }
            portDraft = String(controller.daemonPort)
            controller.refreshNow()
            controller.refreshAgentDiscovery()
            controller.refreshKoshaStatus()
            if !controller.isPreviewMode {
                withAnimation(.easeInOut(duration: 2.0).repeatForever(autoreverses: true)) {
                    livePulseActive = true
                }
            }
        }
        .onDisappear {
            commitPortDraftIfValid()
        }
        .onChange(of: controller.daemonPort) { _, newPort in
            if !portFieldFocused {
                portDraft = String(newPort)
            }
        }
    }

    private func actionErrorBanner(_ message: String, theme: Theme) -> some View {
        Band {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.circle.fill")
                    .font(.subheadline)
                    .foregroundStyle(theme.danger)
                    .padding(.top, 1)

                Text(message)
                    .font(.footnote)
                    .foregroundStyle(theme.primaryText)
                    .fixedSize(horizontal: false, vertical: true)

                Spacer(minLength: 4)

                Button {
                    controller.dismissActionError()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(theme.secondaryText)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Dismiss error")
                .accessibilityLabel("Dismiss error")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
    }

    private func transientNoticeBanner(_ notice: String, theme: Theme) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark.circle.fill")
                .font(.caption)
                .foregroundStyle(theme.live)
            Text(notice)
                .font(.caption.weight(.medium))
                .foregroundStyle(theme.primaryText)
                .lineLimit(2)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(theme.live.opacity(0.11))
        .overlay(alignment: .bottom) { Hairline() }
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

            Text("v\(controller.health?.version ?? "0.20.1")")
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
        whisperGeneration &+= 1
        let gen = whisperGeneration
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
            guard whisperGeneration == gen else { return }
            withAnimation(.easeOut(duration: 0.25)) {
                logoWhisper = nil
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
        let detail = controller.daemonError ?? "Start the proxy on 127.0.0.1:\(controller.daemonPort) to capture turns."

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
        let today = stats?.today
        let isToday = controller.heroScope == .today
        let savedTokens = isToday ? (today?.savedTokens ?? 0) : (stats?.savedInputTokens ?? 0)
        let rawSaved = isToday ? (today?.rawSavedTokens ?? 0) : (stats?.rawSavedTokens ?? 0)
        let savedPct = isToday ? (today?.savedPct ?? 0) : (stats?.savedPct ?? 0)
        let baseTokens = isToday ? (today?.baselineInputWeighted ?? 0) : (stats?.baselineInputWeighted ?? 0)
        let actualTokens = isToday ? (today?.actualInputWeighted ?? 0) : (stats?.actualInputWeighted ?? 0)
        let savedUsd = isToday ? (today?.savedUsd ?? 0) : (stats?.savedUsd ?? 0)
        let cliffUsd = isToday ? (today?.cliffSavedUsd ?? 0) : (stats?.cliffSavedUsd ?? 0)
        let scopeRequests = isToday ? (today?.requests ?? 0) : (stats?.requests ?? 0)
        let unpricedReqCount = stats?.pricingAssumptions?.usdUnpricedRequests ?? 0
        let allUnpriced = (stats?.allRequestsUnpriced ?? false)
            && (!isToday || (abs(savedUsd) < 1e-9 && abs(savedTokens) >= 0.5))
        let isTokenOverhead = savedTokens < -0.5
        let isUsdCost = !allUnpriced && savedUsd < 0
        let negColor = lossColor(theme: theme)
        let pctColor = savedPct >= 0.5 ? theme.live : (savedPct <= -0.5 ? negColor : theme.secondaryText)
        let sessionSavedRaw = controller.lastTurn?.session?.savedTokens ?? 0
        let weightedRatio: Double = {
            if baseTokens > 0 {
                return min(max(savedTokens / baseTokens, 0), 1)
            }
            return min(max(savedPct / 100.0, 0), 1)
        }()

        let weightedTooltip: String = {
            if rawSaved > 0 {
                return "Cache-weighted bill-equivalent tokens saved (\(controller.heroScope.rawValue)). Raw uncached + cached prompt tokens stripped: \(Fmt.tokens(rawSaved))."
            }
            if !isToday && sessionSavedRaw > 0 {
                return "Cache-weighted bill-equivalent tokens (cache reads weighted ~0.10×–0.25×). Raw prompt tokens stripped this session: \(Fmt.tokens(sessionSavedRaw))."
            }
            return "Cache-weighted bill-equivalent tokens (cache reads weighted ~0.10×–0.25×)."
        }()

        let usdTooltip: String = cliffUsd > 0
            ? "Estimated USD saved (\(controller.heroScope.rawValue)) using \(controller.priceMode) pricing (includes \(Fmt.usd(cliffUsd)) context-cliff avoidance)."
            : "Estimated USD saved (\(controller.heroScope.rawValue)) across weighted input & cache pricing (\(controller.priceMode) snapshot)."

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
            if savedPct <= -0.5 {
                return "Net overhead: \(Fmt.signedPctDelta(savedPct)) weighted change (\(Fmt.tokens(actualTokens)) sent vs \(Fmt.tokens(baseTokens)) baseline)."
            }
            return isToday ? "No compressed traffic recorded today yet." : "Awaiting compressible multi-turn traffic."
        }()

        return Band(isHero: true) {
            if theme.layout == .instrumentation {
                // Terminal live prompt metrics header bar
                HStack(spacing: 4) {
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
                    Spacer(minLength: 2)
                    heroScopeToggle(theme: theme)
                }
                .lineLimit(1)
                .minimumScaleFactor(0.85)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)

                Hairline()
            } else {
                HStack(spacing: 8) {
                    heroScopeToggle(theme: theme)
                    Spacer()
                    Text(scopeRequests > 0 ? "\(scopeRequests) req" : "ready")
                        .font(.system(size: 10, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(theme.tertiaryText)
                }
                .padding(.horizontal, theme.usesInsetCards ? 12 : 16)
                .padding(.top, 7)
                .padding(.bottom, 1)
            }

            HStack(alignment: .top, spacing: 0) {
                // Left: Tokens Saved (Weighted + Raw subtitle)
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(isTokenOverhead ? "NET OVERHEAD" : "TOKENS SAVED")
                            .font(.system(size: 10, weight: .semibold))
                            .tracking(0.6)
                            .foregroundStyle(isTokenOverhead ? negColor : theme.secondaryText)
                        if theme.layout == .hardware {
                            Spacer()
                            Text("CH·01")
                                .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                                .foregroundStyle(theme.tertiaryText)
                        }
                    }

                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(isTokenOverhead ? Fmt.signedTokenDelta(savedTokens) : Fmt.tokens(savedTokens))
                            .font(.system(size: 22, weight: theme.bigNumberWeight, design: theme.fontDesign))
                            .fontWidth(theme.fontWidth)
                            .foregroundStyle(isTokenOverhead ? negColor : theme.primaryText)
                            .monospacedDigit()
                            .contentTransition(.numericText())

                        if abs(savedPct) >= 0.5 || abs(savedTokens) >= 0.5 {
                            Text(
                                abs(savedPct) >= 0.5
                                    ? (savedPct <= -0.5 ? "\(Fmt.signedPctDelta(savedPct)) cost" : Fmt.signedPctDelta(savedPct))
                                    : (isTokenOverhead ? "overhead" : Fmt.signedTokenDelta(savedTokens))
                            )
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
                        rawSaved > 0
                            ? "\(Fmt.tokens(rawSaved)) raw · \(Fmt.tokens(actualTokens))/\(Fmt.tokens(baseTokens)) wtd"
                            : (baseTokens > 0
                                ? "\(Fmt.tokens(actualTokens)) / \(Fmt.tokens(baseTokens)) wtd"
                                : (isToday ? "no traffic today" : "awaiting traffic"))
                    )
                    .font(.system(size: theme.layout == .instrumentation ? 9.5 : 10.5))
                    .foregroundStyle(theme.secondaryText)
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.80)
                }
                .padding(.horizontal, theme.usesInsetCards ? 14 : 16)
                .padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .help(weightedTooltip)

                VerticalHairline()

                // Right: Real USD Saved
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(isUsdCost ? "NET COST" : "REAL USD SAVED")
                            .font(.system(size: 10, weight: .semibold))
                            .tracking(0.6)
                            .foregroundStyle(isUsdCost ? negColor : theme.secondaryText)
                        if theme.layout == .hardware {
                            Spacer()
                            Text("CH·02")
                                .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                                .foregroundStyle(theme.tertiaryText)
                        }
                    }

                    if allUnpriced {
                        Text("unpriced")
                            .font(.system(size: 20, weight: theme.bigNumberWeight, design: theme.fontDesign))
                            .fontWidth(theme.fontWidth)
                            .foregroundStyle(theme.secondaryText)
                            .contentTransition(.numericText())
                    } else {
                        Text(isUsdCost ? Fmt.usd(abs(savedUsd)) : Fmt.usd(savedUsd))
                            .font(.system(size: 22, weight: theme.bigNumberWeight, design: theme.fontDesign))
                            .fontWidth(theme.fontWidth)
                            .foregroundStyle(isUsdCost ? negColor : theme.primaryText)
                            .monospacedDigit()
                            .contentTransition(.numericText())
                    }

                    Text(
                        allUnpriced
                            ? "\(unpricedReqCount) unpriced req"
                            : (cliffUsd > 0
                                ? "\(controller.priceMode) · cliff +\(Fmt.usd(cliffUsd))"
                                : (!isToday && unpricedReqCount > 0
                                    ? "\(controller.priceMode) · \(unpricedReqCount) unpriced"
                                    : (isUsdCost ? "\(controller.priceMode) · overhead" : "\(controller.priceMode) pricing")))
                    )
                    .font(.system(size: theme.layout == .instrumentation ? 9.5 : 10.5))
                    .foregroundStyle(theme.secondaryText)
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.86)
                }
                .padding(.horizontal, theme.usesInsetCards ? 14 : 16)
                .padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .help(usdTooltip)
            }
            .fixedSize(horizontal: false, vertical: true)

            HeroCompressionRatioBar(
                savedRatio: weightedRatio,
                savedPct: savedPct,
                hasTraffic: baseTokens > 0 || savedTokens != 0
            )
            .padding(.horizontal, theme.usesInsetCards ? 14 : 16)
            .padding(.bottom, 9)
            .help(ratioTooltip)

            Hairline()

            latestTurnStrip(theme: theme)
        }
    }

    private func heroScopeToggle(theme: Theme) -> some View {
        HStack(spacing: 2) {
            ForEach(HeroScope.allCases) { scope in
                let active = controller.heroScope == scope
                Button {
                    withAnimation(.spring(response: 0.24, dampingFraction: 0.8)) {
                        controller.heroScope = scope
                    }
                } label: {
                    Text(scope.rawValue)
                        .font(.system(size: 9.5, weight: active ? .semibold : .medium, design: theme.fontDesign))
                        .foregroundStyle(active ? theme.primaryText : theme.secondaryText)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2.5)
                        .background {
                            if active {
                                RoundedRectangle(cornerRadius: max(3, theme.badgeRadius), style: .continuous)
                                    .fill(theme.controlPill)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: max(3, theme.badgeRadius), style: .continuous)
                                            .strokeBorder(theme.hairline, lineWidth: 0.5)
                                    )
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(active ? [.isSelected] : [])
            }
        }
        .padding(2)
        .background(
            theme.controlRail,
            in: RoundedRectangle(cornerRadius: max(4, theme.badgeRadius + 2), style: .continuous)
        )
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
                let negColor = lossColor(theme: theme)
                HStack(spacing: 3) {
                    Text(Fmt.compactModelName(turn.model))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .minimumScaleFactor(0.90)

                    if abs(turn.savedTokens) >= 0.5 {
                        Text(turn.savedTokens < -0.5 ? "· \(Fmt.signedTokenDelta(turn.savedTokens)) overhead" : "· \(Fmt.signedTokenDelta(turn.savedTokens))")
                            .foregroundStyle(
                                turn.savedTokens < -0.5
                                    ? negColor
                                    : (theme.layout == .editorial ? theme.secondaryText : theme.primaryText)
                            )
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

                if abs(turn.savedUsd) > 0 {
                    Text(turn.savedUsd < 0 ? "\(Fmt.usd(abs(turn.savedUsd))) cost" : Fmt.usd(turn.savedUsd))
                        .font(.system(size: stripFontSize, weight: .medium))
                        .foregroundStyle(turn.savedUsd < 0 ? negColor : theme.secondaryText)
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
            HStack(alignment: .firstTextBaseline, spacing: 11) {
                ForEach(Array(PopoverTab.allCases.enumerated()), id: \.element) { index, tab in
                    let active = tab == controller.selectedTab
                    Button {
                        selectTab(tab)
                    } label: {
                        Text(tab.rawValue)
                            .font(.system(size: 12.5, weight: active ? .heavy : .medium))
                            .fontWidth(theme.fontWidth)
                            .foregroundStyle(active ? theme.primaryText : theme.secondaryText)
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
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
                    .accessibilityAddTraits(active ? [.isSelected] : [])
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)

        case .pillRail:
            HStack(spacing: 2) {
                ForEach(Array(PopoverTab.allCases.enumerated()), id: \.element) { index, tab in
                    let active = tab == controller.selectedTab
                    Button {
                        selectTab(tab)
                    } label: {
                        Text(tab.rawValue)
                            .font(.system(size: 11, weight: active ? .semibold : .medium))
                            .foregroundStyle(active ? theme.primaryText : theme.secondaryText)
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
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
                    .accessibilityAddTraits(active ? [.isSelected] : [])
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
                    let active = tab == controller.selectedTab
                    Button {
                        selectTab(tab)
                    } label: {
                        VStack(spacing: 3) {
                            Text(tab.rawValue.uppercased())
                                .font(.system(size: 8.8, weight: active ? .bold : .medium))
                                .tracking(0.3)
                                .foregroundStyle(active ? theme.primaryText : theme.secondaryText)
                                .lineLimit(1)
                                .minimumScaleFactor(0.85)

                            RoundedRectangle(cornerRadius: 1, style: .continuous)
                                .fill(active ? theme.accent : Color.white.opacity(0.08))
                                .frame(width: active ? 20 : 10, height: 2)
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
                    .accessibilityAddTraits(active ? [.isSelected] : [])
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
            HStack(spacing: 2) {
                ForEach(Array(PopoverTab.allCases.enumerated()), id: \.element) { index, tab in
                    let active = tab == controller.selectedTab
                    Button {
                        selectTab(tab)
                    } label: {
                        HStack(spacing: 1) {
                            Text("\(index + 1):")
                                .foregroundStyle(active ? theme.accent : theme.tertiaryText)
                            Text(tab.rawValue.lowercased())
                                .fontWeight(active ? .bold : .regular)
                                .foregroundStyle(active ? theme.primaryText : theme.secondaryText)
                        }
                        .font(.system(size: 9, design: .monospaced))
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
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
                    .accessibilityAddTraits(active ? [.isSelected] : [])
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
            HStack(spacing: 2) {
                ForEach(Array(PopoverTab.allCases.enumerated()), id: \.element) { index, tab in
                    let active = tab == controller.selectedTab
                    Button {
                        selectTab(tab)
                    } label: {
                        Text(tab.rawValue)
                            .font(.system(size: 11, weight: active ? .semibold : .medium, design: .rounded))
                            .foregroundStyle(active ? theme.primaryText : theme.secondaryText)
                            .lineLimit(1)
                            .minimumScaleFactor(0.85)
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
                    .accessibilityAddTraits(active ? [.isSelected] : [])
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
            controller.selectedTab = tab
        }
        if tab == .agents {
            controller.refreshAgentDiscovery()
        }
    }

    // MARK: - Tab 1: Activity

    private func activityTab(theme: Theme) -> some View {
        let modelRows = controller.sortedByModelStats
        let maxModelSaved = max(modelRows.map { $0.stats.savedInputTokens }.max() ?? 0, 1)
        let stats = controller.stats
        let dailyPoints = stats?.daily ?? []

        return VStack(alignment: .leading, spacing: 0) {
            SectionHeader(
                title: "Daily (14d)",
                trailing: dailyPoints.last(where: { $0.isToday }) != nil ? "Today live" : nil
            )

            Band {
                DailySavingsChartView(
                    points: dailyPoints,
                    metric: $controller.dailyMetric,
                    theme: theme
                )
            }

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
                        activityModelRow(
                            model: row.model,
                            stats: row.stats,
                            maxSavedTokens: maxModelSaved,
                            theme: theme
                        )
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
                            Text("\(Fmt.signedTokenDelta(Double(session.savedTokens))) raw")
                                .font(.subheadline.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(
                                    session.savedTokens > 0
                                        ? theme.live
                                        : (session.savedTokens < 0 ? lossColor(theme: theme) : theme.secondaryText)
                                )
                            Text(session.savedUsd < 0 ? "\(Fmt.usd(abs(session.savedUsd))) cost" : Fmt.usd(session.savedUsd))
                                .font(.caption)
                                .foregroundStyle(session.savedUsd < 0 ? lossColor(theme: theme) : theme.secondaryText)
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
                VStack(spacing: 0) {
                    HStack(spacing: 0) {
                        lifetimeStatCell(
                            label: "Lifetime Raw",
                            value: Fmt.tokens(stats?.rawSavedTokens ?? 0),
                            theme: theme
                        )
                        VerticalHairline()
                        lifetimeStatCell(
                            label: "Requests",
                            value: "\(stats?.requests ?? 0)",
                            theme: theme
                        )
                    }
                    Hairline()
                    HStack(spacing: 0) {
                        lifetimeStatCell(
                            label: "Optical / Text",
                            value: "\(stats?.imagedRequests ?? 0) / \(stats?.textCompressedRequests ?? 0)",
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

            if controller.phase != .stopped, let mmu = controller.mmuStats {
                SectionHeader(
                    title: "Context-MMU",
                    trailing: mmu.limits?.persisted == true ? "0600 file" : "RAM-only"
                )
                Band {
                    VStack(spacing: 0) {
                        HStack(spacing: 0) {
                            lifetimeStatCell(
                                label: "Virtual Pages",
                                value: "\(mmu.stats.activePages)/\(mmu.limits?.maxPages ?? 512)",
                                theme: theme
                            )
                            .help(
                                "Resident Context-MMU pages: \(Fmt.compactBytes(mmu.stats.activeBytes)) / \(Fmt.compactBytes(mmu.limits?.maxBytes ?? Int64(16 * 1024 * 1024))) · \(mmu.stats.pagesStored) stored, \(mmu.stats.pagesEvicted) evicted."
                            )
                            VerticalHairline()
                            lifetimeStatCell(
                                label: "Prefix Tape",
                                value: prefixTapeLabel(mmu.prefixTape),
                                theme: theme
                            )
                            .help(prefixTapeTooltip(mmu.prefixTape))
                        }
                        Hairline()
                        HStack(spacing: 0) {
                            lifetimeStatCell(
                                label: "Tail Recalls",
                                value: "\(mmu.stats.tailHydrations)",
                                theme: theme
                            )
                            .help(
                                "Speculative ±15-line Context-TLB hydrations injected into the uncached live tail (\(Fmt.tokens(mmu.stats.tailHydrationTokens)) tokens)."
                            )
                            VerticalHairline()
                            lifetimeStatCell(
                                label: "Folds · Prunes",
                                value: "\(mmu.stats.markovFolds) · \(mmu.stats.densityPrunedBlocks)",
                                theme: theme
                            )
                            .help(
                                "Markovian FAIL→PASS episode folds (\(mmu.stats.markovFolds)), Minoux IDF density prunes (\(mmu.stats.densityPrunedBlocks)), and Turn-1 skill stubs (\(mmu.stats.skillsStubbed))."
                            )
                        }
                    }
                }
            }
        }
    }

    private func activityModelRow(
        model: String,
        stats: ModelStats,
        maxSavedTokens: Double,
        theme: Theme
    ) -> some View {
        let engine: EngineMode = {
            if stats.imagedRequests > 0 && stats.textCompressedRequests > 0 { return .hybrid }
            if stats.imagedRequests > 0 { return .optical }
            if stats.textCompressedRequests > 0 { return .text }
            return ModelClassification.engineMode(for: model)
        }()
        let ratio = stats.savedInputTokens > 0
            ? min(max(stats.savedInputTokens / max(maxSavedTokens, 1), 0), 1)
            : 0

        return VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
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

                    Text(
                        stats.rawSavedTokens > 0
                            ? "\(stats.compressedRequests)/\(stats.requests) req · \(Fmt.tokens(stats.rawSavedTokens)) raw"
                            : "\(stats.compressedRequests)/\(stats.requests) requests"
                    )
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
                        } else if stats.savedPct <= -0.5 {
                            Text(Fmt.signedPctDelta(stats.savedPct))
                                .font(.subheadline.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(lossColor(theme: theme))
                        } else if abs(stats.savedInputTokens) >= 0.5 {
                            Text(Fmt.signedTokenDelta(stats.savedInputTokens))
                                .font(.subheadline.weight(.semibold))
                                .monospacedDigit()
                                .foregroundStyle(stats.savedInputTokens > 0 ? theme.live : lossColor(theme: theme))
                        } else {
                            Text("0%")
                                .font(.subheadline)
                                .monospacedDigit()
                                .foregroundStyle(theme.secondaryText)
                        }
                    }

                    let unpricedModel = stats.isUnpriced
                    let modelUsdText: String = {
                        if unpricedModel {
                            if let unpricedReq = stats.usdUnpricedRequests, unpricedReq > 0 {
                                return "\(unpricedReq) unpriced req"
                            }
                            return "unpriced"
                        }
                        if stats.savedUsd < 0 {
                            return "\(Fmt.usd(abs(stats.savedUsd))) cost"
                        }
                        return Fmt.usd(stats.savedUsd)
                    }()
                    Text(
                        abs(stats.savedInputTokens) >= 0.5
                            ? "\(Fmt.signedTokenDelta(stats.savedInputTokens)) wtd · \(modelUsdText)"
                            : modelUsdText
                    )
                    .font(.caption)
                    .foregroundStyle(stats.savedUsd < 0 && !unpricedModel ? lossColor(theme: theme) : theme.secondaryText)
                    .monospacedDigit()
                }
            }

            if ratio > 0 {
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill(theme.controlRail)
                        RoundedRectangle(cornerRadius: 2, style: .continuous)
                            .fill((engine == .optical || engine == .hybrid) ? theme.accent : theme.live)
                            .frame(width: max(4, geo.size.width * ratio))
                    }
                }
                .frame(height: 3.5)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
    }

    // MARK: - Tab 2: Agents (Universal Launcher + CLI FAQ)

    private func shellQuotedAppCommand(_ appName: String) -> String {
        let needsQuotes = appName.unicodeScalars.contains {
            CharacterSet.whitespacesAndNewlines.contains($0) || "\"'$`\\!&|;<>()*?[]{}".unicodeScalars.contains($0)
        }
        if !needsQuotes {
            return "fiche warp --app \(appName)"
        }
        let escaped = appName
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "$", with: "\\$")
            .replacingOccurrences(of: "`", with: "\\`")
        return "fiche warp --app \"\(escaped)\""
    }

    @ViewBuilder
    private func attachmentPill(_ text: String, color: Color, theme: Theme) -> some View {
        Text(text)
            .font(.system(size: 8.5, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(color.opacity(0.13), in: Capsule())
            .overlay(Capsule().strokeBorder(color.opacity(0.28), lineWidth: 0.5))
    }

    private func agentsTab(theme: Theme) -> some View {
        let isOnline = controller.isOnline
        let apps = controller.discoveredDesktopApps
        let clis = controller.discoveredCLIAgents
        let installedCLIs = clis.filter(\.installed)
        let otherCLIs = clis.filter { !$0.installed }
        let attachedAppsCount = apps.filter { $0.attachmentState == .attached }.count

        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                SectionHeader(
                    title: "Desktop Apps",
                    trailing: !controller.hasCompletedAgentDiscovery
                        ? "scanning…"
                        : (apps.isEmpty ? nil : "\(attachedAppsCount)/\(apps.count) attached")
                )
                Spacer(minLength: 0)
                Button {
                    controller.refreshAgentDiscovery()
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(theme.secondaryText)
                }
                .buttonStyle(.borderless)
                .padding(.trailing, 14)
                .padding(.top, 10)
                .help("Re-scan running apps and CLIs")
                .accessibilityLabel("Refresh desktop apps and CLIs")
            }

            Band {
                if !controller.hasCompletedAgentDiscovery && apps.isEmpty {
                    Text("Scanning installed desktop apps & processes…")
                        .font(.caption)
                        .foregroundStyle(theme.secondaryText)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                } else if apps.isEmpty {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("No supported IDE / desktop apps found")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(theme.primaryText)
                            Text("Launch any Electron/Chromium app via CLI:")
                                .font(.caption)
                                .foregroundStyle(theme.secondaryText)
                            Text("fiche warp --app Antigravity")
                                .font(.caption.monospaced())
                                .foregroundStyle(theme.accent)
                        }
                        Spacer()
                        Button {
                            controller.copyToClipboard("fiche warp --app Antigravity", label: "Copied command")
                        } label: {
                            Image(systemName: "doc.on.doc")
                                .font(.caption)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .help("Copy fiche warp --app Antigravity")
                        .accessibilityLabel("Copy fiche warp command")
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                } else {
                    ForEach(Array(apps.enumerated()), id: \.element.id) { idx, app in
                        if idx > 0 { Hairline(inset: 14) }
                        let cmd = shellQuotedAppCommand(app.name)
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(app.displayName)
                                        .font(.subheadline.weight(.medium))
                                        .foregroundStyle(theme.primaryText)
                                        .lineLimit(1)
                                    switch app.attachmentState {
                                    case .attached:
                                        attachmentPill("Attached", color: theme.live, theme: theme)
                                    case .launchedWithoutProxyFlag:
                                        attachmentPill("No proxy flag", color: theme.warn, theme: theme)
                                    case .runningDirect:
                                        attachmentPill("Running direct", color: theme.warn, theme: theme)
                                    case .stopped:
                                        attachmentPill("Stopped", color: theme.tertiaryText, theme: theme)
                                    }
                                }
                                Text(
                                    app.attachmentState == .runningDirect
                                        ? "Quit app (⌘Q) first, then Relaunch via Fiche"
                                        : cmd
                                )
                                .font(app.attachmentState == .runningDirect ? .caption : .caption.monospaced())
                                .foregroundStyle(app.attachmentState == .runningDirect ? theme.warn : theme.secondaryText)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            }
                            Spacer(minLength: 6)
                            Button {
                                controller.copyToClipboard(cmd, label: "Copied: \(cmd)")
                            } label: {
                                Image(systemName: "doc.on.doc")
                                    .font(.caption)
                            }
                            .buttonStyle(.borderless)
                            .foregroundStyle(theme.secondaryText)
                            .help("Copy \(cmd)")
                            .accessibilityLabel("Copy launch command for \(app.displayName)")

                            if app.attachmentState == .runningDirect || app.attachmentState == .launchedWithoutProxyFlag {
                                Button("Relaunch") {
                                    controller.launchDesktopAppViaFiche(app.name)
                                }
                                .buttonStyle(.bordered)
                                .tint(theme.warn)
                                .controlSize(.small)
                                .disabled(!isOnline || controller.isBusy)
                                .help("Quit \(app.displayName) (⌘Q) first so Fiche can attach, then relaunch")
                            } else if app.attachmentState == .attached {
                                Button("Open") {
                                    controller.launchDesktopAppViaFiche(app.name)
                                }
                                .buttonStyle(.bordered)
                                .controlSize(.small)
                                .disabled(!isOnline || controller.isBusy)
                            } else {
                                Button("Open") {
                                    controller.launchDesktopAppViaFiche(app.name)
                                }
                                .buttonStyle(.borderedProminent)
                                .tint(theme.accent)
                                .controlSize(.small)
                                .disabled(!isOnline || controller.isBusy)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                    }
                }
            }

            SectionHeader(
                title: "Coding CLIs",
                trailing: "\(installedCLIs.count) installed"
            )

            Band {
                // Auto-Wrap Status Card
                HStack(spacing: 8) {
                    if let unsupported = controller.unsupportedShellName {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 5) {
                                Circle()
                                    .fill(theme.warn)
                                    .frame(width: 6, height: 6)
                                Text("Auto-wrap unsupported for \(unsupported)")
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(theme.primaryText)
                            }
                            Text("Shell-init supports zsh and bash. Use `fiche warp -- <cli>` or Launch below.")
                                .font(.caption)
                                .foregroundStyle(theme.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 6)
                        Button {
                            let portPrefix = controller.daemonPort != 47_821 ? "FICHE_PORT=\(controller.daemonPort) " : ""
                            controller.copyToClipboard("\(portPrefix)fiche warp -- claude", label: "Copied warp command")
                        } label: {
                            Image(systemName: "doc.on.doc")
                                .font(.caption)
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(theme.secondaryText)
                        .help("Copy fiche warp command")
                        .accessibilityLabel("Copy fiche warp command")
                    } else {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 5) {
                                Circle()
                                    .fill(controller.isShellAutoWrapInstalled ? theme.live : theme.warn)
                                    .frame(width: 6, height: 6)
                                Text(
                                    controller.isShellAutoWrapInstalled
                                        ? "Auto-wrap active in \(controller.shellRCDisplayName)"
                                        : "Auto-wrap not in \(controller.shellRCDisplayName)"
                                )
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(theme.primaryText)
                            }
                            Text(
                                controller.isShellAutoWrapInstalled
                                    ? "New terminal sessions auto-route claude, codex, agy, gemini, opencode…"
                                    : "Route all coding CLIs automatically in every terminal tab."
                            )
                            .font(.caption)
                            .foregroundStyle(theme.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 6)
                        Button {
                            let portPrefix = controller.daemonPort != 47_821 ? "export FICHE_PORT=\(controller.daemonPort) && " : ""
                            controller.copyToClipboard(#"\#(portPrefix)eval "$(fiche shell-init --wrap)""#, label: "Copied shell-init snippet")
                        } label: {
                            Image(systemName: "doc.on.doc")
                                .font(.caption)
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(theme.secondaryText)
                        .help("Copy shell-init line")
                        .accessibilityLabel("Copy shell-init snippet")

                        if controller.isShellAutoWrapInstalled {
                            Button("Remove") {
                                controller.uninstallShellAutoWrap()
                            }
                            .buttonStyle(.bordered)
                            .tint(theme.danger)
                            .controlSize(.small)
                            .help("Remove the managed `# >>> fiche auto-wrap >>>` block from \(controller.shellRCDisplayName)")
                        } else {
                            Button("Enable") {
                                controller.installShellAutoWrap()
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(theme.accent)
                            .controlSize(.small)
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)

                if !installedCLIs.isEmpty {
                    ForEach(installedCLIs) { agent in
                        Hairline(inset: 14)
                        cliAgentRow(agent: agent, isOnline: isOnline, theme: theme)
                    }
                }

                if !otherCLIs.isEmpty {
                    Hairline(inset: 14)
                    Button {
                        withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
                            showAllCLIs.toggle()
                        }
                    } label: {
                        HStack {
                            Text("Other supported CLIs (\(otherCLIs.count))")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(theme.secondaryText)
                            Spacer()
                            Image(systemName: showAllCLIs ? "chevron.up" : "chevron.down")
                                .font(.caption2)
                                .foregroundStyle(theme.tertiaryText)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if showAllCLIs {
                        ForEach(otherCLIs) { agent in
                            Hairline(inset: 14)
                            cliAgentRow(agent: agent, isOnline: isOnline, theme: theme)
                        }
                    }
                }
            }

            SectionHeader(title: "CLI Help & FAQ")

            Band {
                let faqs: [(id: String, q: String, a: String, copyCmd: String?)] = [
                    (
                        "verify",
                        "How do I verify Fiche is attached & working?",
                        "Check **Agents** above for green `Attached` / `N attached` badges. In any shell, run `type claude codex agy` to confirm wrapper functions are active (`source \(controller.shellRCDisplayName)` in older terminals), or watch `tail -f ~/.fiche/events.jsonl` and `By Model` as turns stream.",
                        "tail -f ~/.fiche/events.jsonl"
                    ),
                    (
                        "route",
                        "How do I route any CLI or custom agent?",
                        "Run `fiche warp -- <command>` to route HTTPS + API traffic automatically, or pass `--route HOST=http://127.0.0.1:\(controller.daemonPort)` before `--` (`fiche warp --route HOST=http://127.0.0.1:\(controller.daemonPort) -- <command>`). For direct env routing set `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, or `GOOGLE_GEMINI_BASE_URL`.",
                        "fiche warp -- claude"
                    ),
                    (
                        "restart",
                        "Why isn't an already-running app or CLI attached?",
                        "Apps and shells started before Fiche keep their old env and TLS store, and Electron apps (`Cursor`, `Antigravity`, `Claude`, `ChatGPT`) forward launches into the already-open instance. Quit the app (`Cmd+Q`) first then click **Open**, or open a fresh terminal tab after enabling Auto-Wrap.",
                        nil
                    ),
                    (
                        "bypass",
                        "How do I temporarily bypass Fiche?",
                        "Prefix any single command with `FICHE_BYPASS=1` or click Pause in the top bar for instant passthrough with zero transformation.",
                        "FICHE_BYPASS=1 claude"
                    ),
                    (
                        "touched",
                        "What does Fiche change vs keep untouched?",
                        "Older history and heavy tool outputs are compacted (optical pages for vision readers; 4-layer deterministic text hygiene for text-tier models). Latest messages, file-read edits, model output, and `@fiche pin` instructions stay verbatim.",
                        nil
                    ),
                ]

                ForEach(Array(faqs.enumerated()), id: \.element.id) { idx, item in
                    if idx > 0 { Hairline(inset: 14) }
                    let isOpen = expandedFAQ.contains(item.id)
                    VStack(alignment: .leading, spacing: 5) {
                        Button {
                            withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
                                if isOpen {
                                    expandedFAQ.remove(item.id)
                                } else {
                                    expandedFAQ.insert(item.id)
                                }
                            }
                        } label: {
                            HStack(spacing: 8) {
                                Text(item.q)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(theme.primaryText)
                                    .multilineTextAlignment(.leading)
                                Spacer()
                                Image(systemName: isOpen ? "chevron.up" : "chevron.down")
                                    .font(.caption2)
                                    .foregroundStyle(theme.tertiaryText)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)

                        if isOpen {
                            Text(LocalizedStringKey(item.a))
                                .font(.caption)
                                .foregroundStyle(theme.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)

                            if let copyCmd = item.copyCmd {
                                HStack(spacing: 6) {
                                    Text(copyCmd)
                                        .font(.caption.monospaced())
                                        .foregroundStyle(theme.primaryText)
                                        .padding(.horizontal, 7)
                                        .padding(.vertical, 3)
                                        .background(theme.controlRail, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                                    Button("Copy") {
                                        controller.copyToClipboard(copyCmd, label: "Copied: \(copyCmd)")
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.mini)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                }
            }
        }
    }

    private func cliAgentRow(agent: DiscoveredCLIAgent, isOnline: Bool, theme: Theme) -> some View {
        let cmdSnippet = "fiche warp -- \(agent.command)"
        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(agent.name)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(agent.installed ? theme.primaryText : theme.secondaryText)
                        .lineLimit(1)
                    if !agent.installed {
                        Text("not in PATH")
                            .font(.system(size: 8.5, weight: .medium))
                            .foregroundStyle(theme.tertiaryText)
                    } else {
                        if agent.attachedCount > 0 {
                            attachmentPill("\(agent.attachedCount) attached", color: theme.live, theme: theme)
                        }
                        if agent.directCount > 0 {
                            attachmentPill("\(agent.directCount) direct", color: theme.warn, theme: theme)
                        }
                        if agent.attachedCount == 0 && agent.directCount == 0 && controller.isShellAutoWrapInstalled {
                            attachmentPill("Wrapped", color: theme.secondaryText, theme: theme)
                        }
                    }
                }
                Text("\(agent.command) · \(agent.provider)")
                    .font(.caption.monospaced())
                    .foregroundStyle(theme.secondaryText)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            Button {
                controller.copyToClipboard(cmdSnippet, label: "Copied: \(cmdSnippet)")
            } label: {
                Image(systemName: "doc.on.doc")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
            .foregroundStyle(theme.secondaryText)
            .help("Copy \(cmdSnippet)")
            .accessibilityLabel("Copy launch command for \(agent.name)")

            if agent.installed {
                Button("Launch") {
                    controller.launchCLIAgentInTerminal(agent.command)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(!isOnline || controller.isBusy)
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
        let isOnline = controller.isOnline
        let allProviders = controller.providers
        let primaryProviders = allProviders.filter { $0.isFirstParty || $0.enabled }
        let optionalProviders = allProviders.filter { !$0.isFirstParty && !$0.enabled }
        let enabledProvidersCount = allProviders.filter(\.enabled).count
        let thirdPartyProviders = allProviders.filter { !$0.isFirstParty }
        let thirdPartyEnabledCount = thirdPartyProviders.filter(\.enabled).count

        let grouped: [(family: ProviderFamily, items: [ModelCatalogItem])] = ProviderFamily.allCases.compactMap { family in
            let items = catalog.filter { ProviderFamily.classify($0) == family }
            return items.isEmpty ? nil : (family, items)
        }

        return VStack(alignment: .leading, spacing: 0) {
            SectionHeader(
                title: "My Providers",
                trailing: "\(enabledProvidersCount)/\(allProviders.count)"
            )

            Band {
                ForEach(Array(primaryProviders.enumerated()), id: \.element.id) { idx, provider in
                    if idx > 0 { Hairline(inset: 14) }
                    providerToggleRow(provider: provider, isOnline: isOnline, theme: theme)
                }

                if !optionalProviders.isEmpty {
                    Hairline(inset: 14)
                    Button {
                        withAnimation(.easeInOut(duration: 0.16)) {
                            showMoreProviders.toggle()
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: showMoreProviders ? "chevron.down" : "chevron.right")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(theme.secondaryText)
                                .frame(width: 12)
                            Text("More providers (\(thirdPartyEnabledCount)/\(thirdPartyProviders.count) on)")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(theme.secondaryText)
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)

                    if showMoreProviders {
                        ForEach(optionalProviders) { provider in
                            Hairline(inset: 14)
                            providerToggleRow(provider: provider, isOnline: isOnline, theme: theme)
                        }
                    }
                }
            }

            Text("Only enabled providers are routed by `fiche warp` and accepted by the proxy.")
                .font(.caption2)
                .foregroundStyle(theme.tertiaryText)
                .padding(.horizontal, 16)
                .padding(.top, 5)
                .padding(.bottom, 2)

            koshaSyncSection(theme: theme)

            if !controller.calibratedProfiles.isEmpty {
                calibratedVisionSection(theme: theme)
            }

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
                let isExpanded = expandedModelFamilies.contains(group.family)
                let visibleItems = (group.items.count > 8 && !isExpanded)
                    ? Array(group.items.prefix(8))
                    : group.items

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
                    ForEach(Array(visibleItems.enumerated()), id: \.element.id) { idx, item in
                        if idx > 0 { Hairline(inset: 14) }
                        modelToggleRow(
                            item: item,
                            isOn: activeSet.contains(item.id),
                            isOnline: isOnline,
                            theme: theme
                        )
                    }

                    if group.items.count > 8 {
                        Hairline(inset: 14)
                        Button {
                            withAnimation(.easeInOut(duration: 0.16)) {
                                if isExpanded {
                                    expandedModelFamilies.remove(group.family)
                                } else {
                                    expandedModelFamilies.insert(group.family)
                                }
                            }
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(theme.secondaryText)
                                    .frame(width: 12)
                                Text(
                                    isExpanded
                                        ? "Show fewer"
                                        : "Show \(group.items.count - 8) more (\(group.items.count) total)"
                                )
                                .font(.caption.weight(.medium))
                                .foregroundStyle(theme.secondaryText)
                                Spacer()
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 7)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func relativeAgeLabel(from date: Date?) -> String {
        guard let date else { return "No local cache" }
        let seconds = max(0, Int(Date().timeIntervalSince(date)))
        if seconds < 60 { return "Just now" }
        if seconds < 3_600 { return "\(seconds / 60)m ago" }
        if seconds < 86_400 { return "\(seconds / 3_600)h ago" }
        return "\(seconds / 86_400)d ago"
    }

    private func koshaSyncSection(theme: Theme) -> some View {
        let subtitle = controller.koshaSyncStage
            ?? controller.lastKoshaSyncSummary
            ?? (koshaSyncAllProviders
                ? "All 21 built-in providers"
                : "Enabled providers in ~/.kosha/registry.json")

        return VStack(alignment: .leading, spacing: 0) {
            SectionHeader(
                title: "Kosha Registry",
                trailing: relativeAgeLabel(from: controller.koshaRegistryUpdatedAt)
            )

            Band {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Sync models from Kosha")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(theme.primaryText)
                            .lineLimit(1)
                        Text(subtitle)
                            .font(.caption2)
                            .foregroundStyle(theme.secondaryText)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }

                    Spacer(minLength: 8)

                    if controller.isSyncingKosha {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        let canSyncKosha = controller.hasKoshaRegistry || controller.hasKoshaCLI
                        HStack(spacing: 6) {
                            Button("Dry-run") {
                                Task {
                                    await controller.syncModelsFromKosha(
                                        updateFirst: false,
                                        allProviders: koshaSyncAllProviders,
                                        dryRun: true
                                    )
                                }
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(!canSyncKosha || controller.isBusy || controller.isSyncingKosha)
                            .help("Preview `fiche models sync-kosha --json` without modifying config or daemon state.")

                            Button("Sync") {
                                Task {
                                    await controller.syncModelsFromKosha(
                                        updateFirst: false,
                                        allProviders: koshaSyncAllProviders
                                    )
                                }
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .tint(theme.accent)
                            .disabled(!canSyncKosha || controller.isBusy || controller.isSyncingKosha)
                            .help("Run `fiche models sync-kosha --apply` to merge active chat model bases from Kosha.")
                        }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)

                Hairline(inset: 14)

                HStack(spacing: 8) {
                    HStack(spacing: 6) {
                        Text("All 21 providers")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(theme.secondaryText)
                        Toggle("Sync all 21 Kosha providers", isOn: $koshaSyncAllProviders)
                            .labelsHidden()
                            .toggleStyle(FicheSwitchToggleStyle())
                            .accessibilityLabel("Sync all 21 Kosha providers")
                            .disabled(controller.isSyncingKosha || controller.isBusy)
                    }

                    Spacer(minLength: 8)

                    if controller.hasKoshaCLI {
                        Button("Update & Sync") {
                            Task {
                                await controller.syncModelsFromKosha(
                                    updateFirst: true,
                                    allProviders: koshaSyncAllProviders
                                )
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(controller.isSyncingKosha || controller.isBusy)
                        .help("Run `kosha update` then `fiche models sync-kosha --apply`.")
                    } else {
                        Text("kosha CLI not found")
                            .font(.caption2)
                            .foregroundStyle(theme.tertiaryText)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
            }
        }
    }

    private func calibratedVisionSection(theme: Theme) -> some View {
        let profiles = controller.calibratedProfiles
        return VStack(alignment: .leading, spacing: 0) {
            SectionHeader(
                title: "Calibrated Vision",
                trailing: "\(profiles.filter(\.passed).count)/\(profiles.count) passed"
            )

            Band {
                ForEach(Array(profiles.enumerated()), id: \.element.id) { idx, profile in
                    if idx > 0 { Hairline(inset: 14) }
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            HStack(spacing: 6) {
                                Text(profile.model)
                                    .font(.subheadline.weight(.medium))
                                    .foregroundStyle(theme.primaryText)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                calibratedBandBadge(profile, theme: theme)
                            }
                            Text("\(profile.cols) cols · \(profile.maxHeightPx)px max · score \(Int((profile.overallScore * 100).rounded()))%")
                                .font(.caption2.monospaced())
                                .foregroundStyle(theme.secondaryText)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        Text(profile.passed ? "PASS" : "FAIL")
                            .font(.system(size: 9, weight: .semibold, design: .monospaced))
                            .foregroundStyle(profile.passed ? theme.live : theme.danger)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 6)
                }
            }
        }
    }

    private func calibratedBandBadge(_ profile: CalibratedModelProfile, theme: Theme) -> some View {
        let color: Color = profile.passed ? theme.accent : theme.warn
        return Text(profile.shortBandLabel)
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
            .help("Calibrated via `fiche calibrate`: band=\(profile.band), \(profile.cols) cols × \(profile.maxHeightPx)px, score=\(Int((profile.overallScore * 100).rounded()))%.")
    }

    private func providerToggleRow(
        provider: ProviderDescriptor,
        isOnline: Bool,
        theme: Theme
    ) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(provider.label)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(theme.primaryText)
                        .lineLimit(1)
                    if provider.isFirstParty {
                        Text("CORE")
                            .font(.system(size: 8.5, weight: .bold))
                            .foregroundStyle(theme.accent)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(theme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 3))
                    }
                }
                Text(provider.hostsSubtitle)
                    .font(.caption2.monospaced())
                    .foregroundStyle(theme.secondaryText)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 8)

            Toggle(
                "Enable \(provider.label) provider",
                isOn: Binding(
                    get: { provider.enabled },
                    set: { next in controller.toggleProvider(id: provider.id, on: next) }
                )
            )
            .labelsHidden()
            .toggleStyle(FicheSwitchToggleStyle())
            .accessibilityLabel("Enable \(provider.label) provider")
            .disabled(!isOnline)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }

    private func modelToggleRow(
        item: ModelCatalogItem,
        isOn: Bool,
        isOnline: Bool,
        theme: Theme
    ) -> some View {
        let calProfile = controller.calibratedProfile(for: item.id)
        let engine: EngineMode = {
            if let rawMode = item.engineMode?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
                switch rawMode {
                case "optical": return .optical
                case "hybrid": return .hybrid
                case "text": return .text
                default: break
                }
            }
            let baseEngine = ModelClassification.engineMode(for: item.id, hint: item.hint)
            let lower = item.id.lowercased()
            if let calProfile, calProfile.passed {
                if calProfile.band == "text-only" { return .text }
                if controller.priceMode == "kosha",
                   lower.contains("gemini-4-argon") || lower.contains("gemini-3.8-flash")
                {
                    return .hybrid
                }
                return .optical
            }
            if baseEngine == .optical, controller.priceMode == "kosha", lower.contains("gemini-4-argon") {
                return .hybrid
            }
            return baseEngine
        }()

        return HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(item.label)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(theme.primaryText)
                        .lineLimit(1)
                    engineBadge(engine, theme: theme)
                    if let calProfile, calProfile.passed, calProfile.band != "text-only" {
                        calibratedBandBadge(calProfile, theme: theme)
                    }
                }

                Text(item.id)
                    .font(.caption.monospaced())
                    .foregroundStyle(theme.secondaryText)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            Toggle(
                "Enable \(item.label) model",
                isOn: Binding(
                    get: { isOn },
                    set: { next in controller.toggleModel(model: item.id, on: next) }
                )
            )
            .labelsHidden()
            .toggleStyle(FicheSwitchToggleStyle())
            .accessibilityLabel("Enable \(item.label) model")
            .disabled(!isOnline)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
    }

    // MARK: - Tab 3: Stages

    private func stagesTab(theme: Theme) -> some View {
        let isOnline = controller.isOnline
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
                    "Enable \(plugin.name)",
                    isOn: Binding(
                        get: { plugin.enabled },
                        set: { next in controller.togglePlugin(id: plugin.id, enabled: next) }
                    )
                )
                .labelsHidden()
                .toggleStyle(FicheSwitchToggleStyle())
                .accessibilityLabel("Enable \(plugin.name)")
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
        let isOnline = controller.isOnline

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
                        "Enable compression",
                        isOn: Binding(
                            get: { controller.compressionEnabled },
                            set: { next in
                                Task { await controller.setCompression(enabled: next) }
                            }
                        )
                    )
                    .labelsHidden()
                    .toggleStyle(FicheSwitchToggleStyle())
                    .accessibilityLabel("Enable compression")
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
                        "Enable 3rd-party plugins and skills",
                        isOn: Binding(
                            get: { controller.hasEnabledThirdPartyPlugins },
                            set: { next in controller.setAllThirdPartyPlugins(enabled: next) }
                        )
                    )
                    .labelsHidden()
                    .toggleStyle(FicheSwitchToggleStyle())
                    .accessibilityLabel("Enable 3rd-party plugins and skills")
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
                    Toggle("Auto-start daemon", isOn: $controller.autoStartDaemon)
                        .labelsHidden()
                        .toggleStyle(FicheSwitchToggleStyle())
                        .accessibilityLabel("Auto-start daemon")
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
                        "Start at login",
                        isOn: Binding(
                            get: { controller.isLoginAgentInstalled },
                            set: { enabled in controller.setLoginAgent(enabled: enabled) }
                        )
                    )
                    .labelsHidden()
                    .toggleStyle(FicheSwitchToggleStyle())
                    .accessibilityLabel("Start at login")
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
                        .disabled(controller.isBusy)
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

                let installedApps = controller.discoveredDesktopApps
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
                            ForEach(installedApps) { app in
                                Button("Open \(app.displayName)") {
                                    controller.launchDesktopAppViaFiche(app.name)
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

    private func commitPortDraftIfValid() {
        let trimmed = portDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        if let parsed = Int(trimmed), (1024...65_535).contains(parsed), parsed != controller.daemonPort {
            controller.daemonPort = parsed
        }
    }

    // MARK: - Footer Row

    private func footerRow(theme: Theme) -> some View {
        HStack(spacing: 2) {
            Text(footerMetrics(theme: theme))
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

    private func footerMetrics(theme: Theme) -> String {
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

    private func prefixTapeLabel(_ tape: PrefixTapeSnapshot?) -> String {
        guard let tape else { return "—" }
        if let pct = tape.hitPct {
            return "\(Int(pct.rounded()))% hit"
        }
        return "\(tape.totalSeals) seals"
    }

    private func prefixTapeTooltip(_ tape: PrefixTapeSnapshot?) -> String {
        guard let tape else { return "PrefixMemoTape warm-turn reuse ledger." }
        return "PrefixMemoTape: \(tape.stage2Hits) Stage-2 hits (\(tape.stage2Entries) cached), \(tape.sealHits) prefix seal hits (\(tape.totalSeals) seals / \(tape.sealSessions) sessions), \(tape.casiHits) Merkle CASI hits."
    }

    private func engineBadge(_ mode: EngineMode, theme: Theme) -> some View {
        let color: Color = {
            switch mode {
            case .optical: return theme.accent
            case .hybrid: return theme.live
            case .text: return theme.secondaryText
            }
        }()
        let tooltip: String = {
            switch mode {
            case .optical:
                return "Optical Microfiche + 4-layer text hygiene active for this validated reader."
            case .hybrid:
                return "Hybrid Slab-Optical (Turn-1 static PNG slab) + Text-MMU dynamic history."
            case .text:
                return "4-layer prefix-safe text hygiene only (no rasterized images sent)."
            }
        }()

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
        let hasPositiveFill = clamped > 0
        let negColor = theme.layout == .editorial ? theme.danger : theme.warn
        let pctLabelColor: Color = hasPositiveFill ? theme.live : (savedPct <= -0.5 ? negColor : theme.secondaryText)

        HStack(spacing: 8) {
            switch theme.layout {
            case .editorial:
                // Razor-thin Swiss ink rule with split tick
                GeometryReader { geo in
                    let w = geo.size.width
                    let fillW = hasPositiveFill ? max(2, w * clamped) : 0
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

                Text(hasTraffic ? (savedPct <= -0.5 ? "\(Fmt.signedPctDelta(savedPct)) cost" : (savedPct < 0 ? Fmt.signedPctDelta(savedPct) : "\(Fmt.pct(savedPct)) pruned")) : "0% pruned")
                    .font(.system(size: 9.5, weight: .medium, design: theme.fontDesign))
                    .foregroundStyle(savedPct <= -0.5 ? negColor : theme.secondaryText)
                    .monospacedDigit()
                    .lineLimit(1)

            case .controlCenter:
                // Apple smooth capsule meter
                GeometryReader { geo in
                    let w = geo.size.width
                    let fillW = hasPositiveFill ? max(8, w * clamped) : 0
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

                Text(hasTraffic ? (savedPct <= -0.5 ? "\(Fmt.signedPctDelta(savedPct)) cost" : (savedPct < 0 ? Fmt.signedPctDelta(savedPct) : "\(Fmt.pct(savedPct)) saved")) : "0%")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(savedPct <= -0.5 ? negColor : theme.secondaryText)
                    .monospacedDigit()
                    .lineLimit(1)

            case .hardware:
                // Braun / TE 20-segment LED instrument meter
                Text("RATIO")
                    .font(.system(size: 8.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(theme.tertiaryText)

                HStack(spacing: 2) {
                    let count = 20
                    let litCount = hasPositiveFill ? max(1, Int((clamped * Double(count)).rounded())) : 0
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

                Text(hasTraffic ? (savedPct < 0 ? Fmt.signedPctDelta(savedPct) : Fmt.pct(savedPct)) : "0%")
                    .font(.system(size: 9.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(hasPositiveFill ? theme.accent : (savedPct <= -0.5 ? negColor : theme.tertiaryText))
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
                        let litCount = hasPositiveFill ? max(1, Int((clamped * Double(count)).rounded())) : 0
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

                Text(hasTraffic ? (savedPct <= -0.5 ? "\(Fmt.signedPctDelta(savedPct)) cost" : (savedPct < 0 ? Fmt.signedPctDelta(savedPct) : "\(Fmt.pct(savedPct)) saved")) : "0%")
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(hasPositiveFill ? pctLabelColor : (savedPct <= -0.5 ? negColor : theme.tertiaryText))
                    .monospacedDigit()
                    .lineLimit(1)

            case .celestial:
                // Apple Weather aurora twilight capsule gauge
                GeometryReader { geo in
                    let w = geo.size.width
                    let fillW = hasPositiveFill ? max(8, w * clamped) : 0
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

                Text(hasTraffic ? (savedPct <= -0.5 ? "\(Fmt.signedPctDelta(savedPct)) cost" : (savedPct < 0 ? Fmt.signedPctDelta(savedPct) : "\(Fmt.pct(savedPct)) saved")) : "0%")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundStyle(savedPct <= -0.5 ? negColor : theme.secondaryText)
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
        .accessibilityLabel("\(id.label) theme")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
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

        case .celestial:
            Circle()
                .fill(isOn ? theme.ground : theme.primaryText)
                .frame(width: 12, height: 12)
                .shadow(color: .black.opacity(0.24), radius: 1.2, y: 0.6)

        case .editorial, .controlCenter:
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

private struct DailySavingsChartView: View {
    let points: [DailySavingsPoint]
    @Binding var metric: DailyChartMetric
    let theme: Theme
    @State private var hoveredDate: String? = nil

    var body: some View {
        let rawValues: [Double] = points.map { metric == .usd ? $0.savedUsd : $0.savedTokens }
        let minFloor = metric == .usd ? 0.001 : 1.0
        let maxPos = max(0, rawValues.max() ?? 0)
        let maxNeg = max(0, -(rawValues.min() ?? 0))
        let hasNegative = maxNeg > 0
        let maxValue = max(minFloor, maxPos)
        let totalWtd = points.reduce(0.0) { $0 + $1.savedTokens }
        let totalRaw = points.reduce(0.0) { $0 + $1.rawSavedTokens }
        let totalUsd = points.reduce(0.0) { $0 + $1.savedUsd }
        let hasAnyData = points.contains {
            $0.compressed > 0 || $0.savedTokens != 0 || $0.savedUsd != 0 || $0.rawSavedTokens != 0
        }
        let hoveredPoint = hoveredDate.flatMap { d in points.first(where: { $0.date == d }) }
        let negColor = theme.layout == .editorial ? theme.danger : theme.warn
        let chartAccessibilitySummary: String = {
            guard hasAnyData else { return "14-day daily \(metric.rawValue) chart: awaiting compressible traffic" }
            let usdSummary = totalUsd < 0 ? "\(Fmt.usd(abs(totalUsd))) cost" : "\(Fmt.usd(totalUsd)) saved"
            return "14-day daily \(metric.rawValue) chart: \(Fmt.tokens(totalWtd)) weighted tokens, \(usdSummary)"
        }()

        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 6) {
                if let pt = hoveredPoint {
                    let ptNeg = (metric == .usd ? pt.savedUsd : pt.savedTokens) < 0
                    let ptUsd = pt.savedUsd < 0 ? "\(Fmt.usd(abs(pt.savedUsd))) cost" : Fmt.usd(pt.savedUsd)
                    Text("\(pt.shortDateLabel) · \(Fmt.signedTokenDelta(pt.savedTokens)) wtd (\(Fmt.tokens(pt.rawSavedTokens)) raw) · \(ptUsd)")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(ptNeg ? negColor : theme.primaryText)
                        .monospacedDigit()
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                } else if hasAnyData {
                    let totalNeg = (metric == .usd ? totalUsd : totalWtd) < 0
                    let usdText = totalUsd < 0 ? "\(Fmt.usd(abs(totalUsd))) cost" : Fmt.usd(totalUsd)
                    Text(
                        totalRaw > 0
                            ? "14d: \(Fmt.tokens(totalWtd)) wtd · \(Fmt.tokens(totalRaw)) raw · \(usdText)"
                            : "14d: \(Fmt.tokens(totalWtd)) wtd · \(usdText)"
                    )
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(totalNeg ? negColor : theme.secondaryText)
                    .monospacedDigit()
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                } else {
                    Text("Awaiting compressible traffic")
                        .font(.system(size: 10))
                        .foregroundStyle(theme.secondaryText)
                }

                Spacer(minLength: 4)

                HStack(spacing: 2) {
                    ForEach(DailyChartMetric.allCases) { m in
                        let active = metric == m
                        Button {
                            withAnimation(.spring(response: 0.22, dampingFraction: 0.8)) {
                                metric = m
                            }
                        } label: {
                            Text(m.rawValue)
                                .font(.system(size: 9, weight: active ? .semibold : .medium))
                                .foregroundStyle(active ? theme.primaryText : theme.secondaryText)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background {
                                    if active {
                                        RoundedRectangle(cornerRadius: max(2.5, theme.badgeRadius), style: .continuous)
                                            .fill(theme.controlPill)
                                            .overlay(
                                                RoundedRectangle(cornerRadius: max(2.5, theme.badgeRadius), style: .continuous)
                                                    .strokeBorder(theme.hairline, lineWidth: 0.5)
                                            )
                                    }
                                }
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(active ? [.isSelected] : [])
                    }
                }
                .padding(1.5)
                .background(
                    theme.controlRail,
                    in: RoundedRectangle(cornerRadius: max(3.5, theme.badgeRadius + 1), style: .continuous)
                )
            }

            if points.isEmpty || !hasAnyData {
                VStack(alignment: .leading, spacing: 4) {
                    ZStack(alignment: .bottom) {
                        Rectangle()
                            .fill(theme.hairline)
                            .frame(height: 1)
                        HStack(spacing: 4) {
                            ForEach(0..<14, id: \.self) { idx in
                                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                                    .fill(idx == 13 ? theme.live.opacity(0.35) : theme.hairline)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 3)
                            }
                        }
                    }
                    .frame(height: 22)

                    Text("No compressed savings in the past 14 days yet.")
                        .font(.caption)
                        .foregroundStyle(theme.tertiaryText)
                }
            } else if hasNegative {
                let plotH: CGFloat = 64
                let scalePos = maxPos
                let scaleNeg = max(minFloor, maxNeg)
                let posZoneH: CGFloat = scalePos > 0
                    ? max(18, min(plotH - 18, floor(plotH * CGFloat(scalePos / (scalePos + scaleNeg)))))
                    : 4
                let negZoneH: CGFloat = max(14, plotH - posZoneH)

                HStack(alignment: .bottom, spacing: 6) {
                    ZStack(alignment: .top) {
                        VStack(spacing: 0) {
                            if scalePos > 0 {
                                DashedHorizontalRule(color: theme.hairline)
                                Spacer().frame(height: max(0, posZoneH - 1))
                            } else {
                                Spacer().frame(height: posZoneH)
                            }
                            Rectangle().fill(theme.secondaryText.opacity(0.35)).frame(height: 0.9)
                            Spacer(minLength: 0)
                            DashedHorizontalRule(color: negColor.opacity(0.28))
                        }
                        .frame(height: plotH)

                        HStack(alignment: .top, spacing: 3) {
                            ForEach(Array(points.enumerated()), id: \.offset) { idx, pt in
                                let v = rawValues[idx]
                                let barCorner: CGFloat = theme.layout == .instrumentation ? 1 : 2.5
                                let isHovered = hoveredDate == pt.date
                                let barShape = RoundedRectangle(cornerRadius: barCorner, style: .continuous)

                                VStack(spacing: 0) {
                                    // Positive zone above zero baseline
                                    VStack(spacing: 0) {
                                        Spacer(minLength: 0)
                                        if v > 0, scalePos > 0 {
                                            let barH = max(3, CGFloat(v / scalePos) * (posZoneH - 2))
                                            if pt.isToday {
                                                barShape
                                                    .fill(isHovered ? theme.accent.opacity(0.65) : theme.live.opacity(0.55))
                                                    .overlay(
                                                        barShape.strokeBorder(
                                                            isHovered ? theme.accent : theme.live,
                                                            style: StrokeStyle(lineWidth: 1, dash: [2.5, 2])
                                                        )
                                                    )
                                                    .frame(height: barH)
                                            } else {
                                                barShape
                                                    .fill(isHovered ? theme.accent : theme.live)
                                                    .frame(height: barH)
                                            }
                                        } else if v == 0 {
                                            barShape
                                                .fill(pt.isToday && isHovered ? theme.accent.opacity(0.25) : theme.hairline)
                                                .frame(height: pt.isToday ? 3 : 2)
                                        }
                                    }
                                    .frame(height: posZoneH)

                                    // Negative zone below zero baseline
                                    VStack(spacing: 0) {
                                        if v < 0 {
                                            let barH = max(3, CGFloat(abs(v) / scaleNeg) * (negZoneH - 2))
                                            if pt.isToday {
                                                barShape
                                                    .fill(isHovered ? theme.danger.opacity(0.65) : negColor.opacity(0.55))
                                                    .overlay(
                                                        barShape.strokeBorder(
                                                            isHovered ? theme.danger : negColor,
                                                            style: StrokeStyle(lineWidth: 1, dash: [2.5, 2])
                                                        )
                                                    )
                                                    .frame(height: barH)
                                            } else {
                                                barShape
                                                    .fill(isHovered ? theme.danger : negColor)
                                                    .frame(height: barH)
                                            }
                                        }
                                        Spacer(minLength: 0)
                                    }
                                    .frame(height: negZoneH)
                                }
                                .frame(maxWidth: .infinity)
                                .frame(height: plotH)
                                .contentShape(Rectangle())
                                .onHover { entering in
                                    if entering {
                                        hoveredDate = pt.date
                                    } else if hoveredDate == pt.date {
                                        hoveredDate = nil
                                    }
                                }
                            }
                        }
                    }

                    let zeroLabelY = max(scalePos > 0 ? 11 : 0, min(plotH - 18, posZoneH - 5.5))
                    ZStack(alignment: .topTrailing) {
                        if scalePos > 0 {
                            Text(metric == .usd ? Fmt.usd(scalePos) : Fmt.tokens(scalePos))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        Text(metric == .usd ? "$0" : "0")
                            .offset(y: zeroLabelY)
                        VStack {
                            Spacer(minLength: 0)
                            Text(metric == .usd ? Fmt.usd(-scaleNeg) : Fmt.tokens(-scaleNeg))
                                .foregroundStyle(negColor)
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                        }
                        .frame(height: plotH, alignment: .bottomTrailing)
                    }
                    .font(.system(size: 8.5, design: .monospaced))
                    .foregroundStyle(theme.tertiaryText)
                    .monospacedDigit()
                    .frame(width: 44, height: plotH, alignment: .topTrailing)
                }

                HStack {
                    Text(points.first?.shortDateLabel ?? "")
                    Spacer()
                    HStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 1, style: .continuous)
                            .strokeBorder(theme.live, style: StrokeStyle(lineWidth: 1, dash: [2, 1.5]))
                            .background(theme.live.opacity(0.45))
                            .frame(width: 7, height: 7)
                        Text("Today (live)")
                    }
                }
                .font(.system(size: 9))
                .foregroundStyle(theme.tertiaryText)
            } else {
                let plotH: CGFloat = 58
                HStack(alignment: .bottom, spacing: 6) {
                    ZStack(alignment: .bottom) {
                        VStack(spacing: 0) {
                            DashedHorizontalRule(color: theme.hairline)
                            Spacer()
                            DashedHorizontalRule(color: theme.hairline.opacity(0.75))
                            Spacer()
                            Rectangle().fill(theme.hairline).frame(height: 0.75)
                        }
                        .frame(height: plotH)

                        HStack(alignment: .bottom, spacing: 3) {
                            ForEach(Array(points.enumerated()), id: \.offset) { idx, pt in
                                let v = rawValues[idx]
                                let barH: CGFloat = v > 0
                                    ? max(3, CGFloat(v / maxValue) * (plotH - 2))
                                    : (pt.isToday ? 3 : 2)
                                let barCorner: CGFloat = theme.layout == .instrumentation ? 1 : 2.5
                                let isHovered = hoveredDate == pt.date
                                let barShape = RoundedRectangle(cornerRadius: barCorner, style: .continuous)

                                VStack(spacing: 0) {
                                    Spacer(minLength: 0)
                                    if pt.isToday {
                                        barShape
                                            .fill(
                                                v > 0
                                                    ? (isHovered ? theme.accent.opacity(0.65) : theme.live.opacity(0.55))
                                                    : (isHovered ? theme.accent.opacity(0.25) : theme.hairline)
                                            )
                                            .overlay(
                                                barShape.strokeBorder(
                                                    v > 0 ? (isHovered ? theme.accent : theme.live) : theme.secondaryText.opacity(0.45),
                                                    style: StrokeStyle(lineWidth: v > 0 ? 1 : 0.75, dash: [2.5, 2])
                                                )
                                            )
                                            .frame(height: barH)
                                    } else {
                                        barShape
                                            .fill(v > 0 ? (isHovered ? theme.accent : theme.live) : theme.hairline)
                                            .frame(height: barH)
                                    }
                                }
                                .frame(maxWidth: .infinity)
                                .frame(height: plotH)
                                .contentShape(Rectangle())
                                .onHover { entering in
                                    if entering {
                                        hoveredDate = pt.date
                                    } else if hoveredDate == pt.date {
                                        hoveredDate = nil
                                    }
                                }
                            }
                        }
                    }

                    VStack(alignment: .trailing) {
                        Text(metric == .usd ? Fmt.usd(maxValue) : Fmt.tokens(maxValue))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                        Spacer()
                        Text(metric == .usd ? Fmt.usd(maxValue * 0.5) : Fmt.tokens(maxValue * 0.5))
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                        Spacer()
                        Text(metric == .usd ? "$0" : "0")
                    }
                    .font(.system(size: 8.5, design: .monospaced))
                    .foregroundStyle(theme.tertiaryText)
                    .monospacedDigit()
                    .frame(width: 44, height: plotH, alignment: .trailing)
                }

                HStack {
                    Text(points.first?.shortDateLabel ?? "")
                    Spacer()
                    HStack(spacing: 4) {
                        RoundedRectangle(cornerRadius: 1, style: .continuous)
                            .strokeBorder(theme.live, style: StrokeStyle(lineWidth: 1, dash: [2, 1.5]))
                            .background(theme.live.opacity(0.45))
                            .frame(width: 7, height: 7)
                        Text("Today (live)")
                    }
                }
                .font(.system(size: 9))
                .foregroundStyle(theme.tertiaryText)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(chartAccessibilitySummary)
        .onDisappear {
            hoveredDate = nil
        }
    }
}

private struct DashedHorizontalRule: View {
    let color: Color

    var body: some View {
        GeometryReader { geo in
            Path { path in
                path.move(to: .zero)
                path.addLine(to: CGPoint(x: geo.size.width, y: 0))
            }
            .stroke(color, style: StrokeStyle(lineWidth: 0.6, dash: [3, 3]))
        }
        .frame(height: 1)
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
