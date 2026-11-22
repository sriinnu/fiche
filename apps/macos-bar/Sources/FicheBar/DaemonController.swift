import AppKit
import Darwin
import Foundation

// MARK: - Helper Types

private enum DefaultsKey {
    static let autoStartDaemon = "autoStartDaemon"
    static let daemonPort = "daemonPort"
    static let pollIntervalSeconds = "pollIntervalSeconds"
    static let theme = "ficheBarTheme"
}

private enum FicheExecutable: Sendable {
    case binary(String)
    case nodeScript(node: String, script: String)
}

private struct CommandOutput: Sendable {
    let exitCode: Int32
    let stdout: String
    let stderr: String
}

private enum HTTPResult<T: Sendable>: Sendable {
    case ok(T)
    case httpError(status: Int, body: String)
    case unreachable(String)
}

private final class TaskCancellationBox: @unchecked Sendable {
    private let lock = NSLock()
    private var task: Task<Void, Never>?

    func replace(with next: Task<Void, Never>?) {
        lock.lock()
        let previous = task
        task = next
        lock.unlock()
        previous?.cancel()
    }

    func cancel() {
        replace(with: nil)
    }

    deinit {
        task?.cancel()
    }
}

// MARK: - DaemonController

@MainActor
final class DaemonController: ObservableObject {
    // User-configurable defaults (AppStorage-compatible keys)
    @Published var autoStartDaemon: Bool {
        didSet {
            UserDefaults.standard.set(autoStartDaemon, forKey: DefaultsKey.autoStartDaemon)
        }
    }

    @Published var daemonPort: Int {
        didSet {
            let clamped = min(max(daemonPort, 1024), 65_535)
            if clamped != daemonPort {
                daemonPort = clamped
                return
            }
            UserDefaults.standard.set(clamped, forKey: DefaultsKey.daemonPort)
            Task { [weak self] in
                await self?.pollOnce()
            }
        }
    }

    @Published var pollIntervalSeconds: Double {
        didSet {
            let clamped = min(max(pollIntervalSeconds, 1.0), 60.0)
            if clamped != pollIntervalSeconds {
                pollIntervalSeconds = clamped
                return
            }
            UserDefaults.standard.set(clamped, forKey: DefaultsKey.pollIntervalSeconds)
        }
    }

    @Published var themeID: ThemeID {
        didSet {
            if !isPreview {
                UserDefaults.standard.set(themeID.rawValue, forKey: DefaultsKey.theme)
            }
        }
    }

    // Live daemon state
    @Published private(set) var phase: DaemonPhase = .stopped
    @Published private(set) var health: HealthResponse?
    @Published private(set) var stats: ProxyStatsResponse?
    @Published private(set) var lastTurn: LastTurnResponse?
    @Published private(set) var allowedModels: [String] = []
    @Published private(set) var modelCatalog: [ModelCatalogItem] = ModelCatalogItem.curatedDefaults
    @Published private(set) var plugins: [PluginDescriptor] = []
    @Published private(set) var pluginsDir: String?
    @Published private(set) var isLoginAgentInstalled: Bool = false
    @Published private(set) var isBusy: Bool = false
    @Published private(set) var lastError: String?
    @Published private(set) var lastUpdatedAt: Date?
    @Published private(set) var spawnedPid: Int32?
    @Published private(set) var pluginsEndpointSupported: Bool = true

    private let isPreview: Bool
    private let session: URLSession
    private let pollBox = TaskCancellationBox()
    private var hasPerformedStartupCheck = false

    var isPreviewMode: Bool { isPreview }

    nonisolated private static let launchAgentLabel = "com.sriinnu.fiche"

    init() {
        self.isPreview = false
        let defaults = UserDefaults.standard
        if defaults.object(forKey: DefaultsKey.autoStartDaemon) == nil {
            defaults.set(true, forKey: DefaultsKey.autoStartDaemon)
        }
        if defaults.object(forKey: DefaultsKey.daemonPort) == nil {
            defaults.set(47_821, forKey: DefaultsKey.daemonPort)
        }
        if defaults.object(forKey: DefaultsKey.pollIntervalSeconds) == nil {
            defaults.set(3.0, forKey: DefaultsKey.pollIntervalSeconds)
        }

        let storedPort = defaults.integer(forKey: DefaultsKey.daemonPort)
        let storedInterval = defaults.double(forKey: DefaultsKey.pollIntervalSeconds)

        self.autoStartDaemon = defaults.bool(forKey: DefaultsKey.autoStartDaemon)
        self.daemonPort = (1024...65_535).contains(storedPort) ? storedPort : 47_821
        self.pollIntervalSeconds = storedInterval >= 1.0 ? min(storedInterval, 60.0) : 3.0
        self.themeID = ThemeID(rawValue: defaults.string(forKey: DefaultsKey.theme) ?? "") ?? .editorial

        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 2.5
        config.timeoutIntervalForResource = 5.0
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: config)

        self.isLoginAgentInstalled = Self.checkLaunchAgentExists()
        startPolling()
    }

    private init(previewTheme: ThemeID) {
        self.isPreview = true
        self.autoStartDaemon = true
        self.daemonPort = 47_821
        self.pollIntervalSeconds = 3.0
        self.themeID = previewTheme
        self.session = URLSession(configuration: .ephemeral)
        self.phase = .live
        self.isLoginAgentInstalled = true
        self.allowedModels = ["gemini-4-argon-high", "claude-fable-5", "gpt-6.2-astra", "claude-opus-5-5", "deepseek", "kimi", "glm", "grok"]

        let decoder = JSONDecoder()
        let healthJSON = """
        {
          "ok": true,
          "name": "fiche",
          "version": "0.17.0",
          "pid": 17130,
          "host": "127.0.0.1",
          "port": 47821,
          "uptime_sec": 528,
          "compression_enabled": true,
          "price_mode": "kosha",
          "allowed_models": ["gemini-4-argon-high", "claude-fable-5", "gpt-6.2-astra", "claude-opus-5-5", "deepseek", "kimi", "glm", "grok"]
        }
        """
        let statsJSON = """
        {
          "requests": 11,
          "compressed_requests": 7,
          "passthrough": 4,
          "baseline_input_weighted": 47756,
          "actual_input_weighted": 26170,
          "saved_input_tokens": 21586,
          "saved_pct": 45.2,
          "saved_usd": 0.0432,
          "cliff_avoided_events": 0,
          "cliff_saved_usd": 0,
          "uptime_sec": 528,
          "compression_enabled": true,
          "render_cache": {
            "entries": 4,
            "bytes": 548743,
            "max_bytes": 67108864,
            "hits": 8,
            "misses": 4,
            "evictions": 0,
            "oversized": 0
          },
          "by_model": {
            "gemini-4-argon-high": {
              "requests": 7,
              "compressed_requests": 7,
              "baseline_input_weighted": 47756,
              "actual_input_weighted": 26170,
              "saved_input_tokens": 21586,
              "saved_pct": 45.2,
              "saved_usd": 0.0432,
              "cliff_avoided_events": 0,
              "cliff_saved_usd": 0
            },
            "gemini-4-neon-high": {
              "requests": 3,
              "compressed_requests": 0,
              "baseline_input_weighted": 0,
              "actual_input_weighted": 0,
              "saved_input_tokens": 0,
              "saved_pct": 0,
              "saved_usd": 0,
              "cliff_avoided_events": 0,
              "cliff_saved_usd": 0
            },
            "gemini-3.5-flash-lite": {
              "requests": 1,
              "compressed_requests": 0,
              "baseline_input_weighted": 0,
              "actual_input_weighted": 0,
              "saved_input_tokens": 0,
              "saved_pct": 0,
              "saved_usd": 0,
              "cliff_avoided_events": 0,
              "cliff_saved_usd": 0
            }
          }
        }
        """
        let lastTurnJSON = """
        {
          "has_new_turn": true,
          "lastTurn": {
            "model": "gemini-4-argon-high",
            "saved_tokens": 19706,
            "saved_pct": 45.2,
            "saved_usd": 0.0142,
            "stages": ["image", "ws"],
            "compressed": true,
            "cache_hit_pct": 72
          },
          "session": {
            "turns": 7,
            "compressed_turns": 7,
            "saved_tokens": 123500,
            "saved_usd": 0.0432,
            "avg_cache_hit_pct": 72
          }
        }
        """
        self.health = try? decoder.decode(HealthResponse.self, from: Data(healthJSON.utf8))
        self.stats = try? decoder.decode(ProxyStatsResponse.self, from: Data(statsJSON.utf8))
        self.lastTurn = try? decoder.decode(LastTurnResponse.self, from: Data(lastTurnJSON.utf8))
        self.plugins = [
            PluginDescriptor(id: "optical-microfiche", name: "Optical Microfiche", description: "Renders bulky stale context into dense lossless PNG pages.", kind: .stage, source: "builtin", enabled: true, mutable: false),
            PluginDescriptor(id: "tscg-schema", name: "TSCG Schema Compiler", description: "Prefix-safe tool schema and static system-prompt compaction.", kind: .stage, source: "builtin", enabled: true, mutable: false),
            PluginDescriptor(id: "toon-structured", name: "TOON Structured Encoder", description: "Lossless tabular TOON encoding for repetitive JSON payloads.", kind: .stage, source: "builtin", enabled: true, mutable: false),
            PluginDescriptor(id: "acdc-epochs", name: "ACDC Epoch Collapse", description: "Amortized cache-safe collapsing of older text history turns.", kind: .stage, source: "builtin", enabled: true, mutable: false),
            PluginDescriptor(id: "casi-delta", name: "CASI Delta Deduplicator", description: "Content-addressed duplicate and delta referencing.", kind: .stage, source: "builtin", enabled: true, mutable: false),
            PluginDescriptor(id: "skill:fiche", name: "fiche", description: "Inspect token & dollar savings from the fiche context compiler.", kind: .skill, source: "skill", enabled: true, mutable: true),
            PluginDescriptor(id: "skill:azure-ai", name: "azure-ai", description: "External Azure AI skill extension.", kind: .skill, source: "skill", enabled: true, mutable: true),
            PluginDescriptor(id: "skill:baton-handover", name: "baton-handover", description: "External session baton handover extension.", kind: .skill, source: "skill", enabled: true, mutable: true),
            PluginDescriptor(id: "skill:code-mode", name: "code-mode", description: "External code-mode workflow extension.", kind: .skill, source: "skill", enabled: true, mutable: true),
            PluginDescriptor(id: "skill:tokmeter", name: "tokmeter", description: "External token meter inspection extension.", kind: .skill, source: "skill", enabled: true, mutable: true),
        ]
    }

    static func previewSample(theme: ThemeID) -> DaemonController {
        DaemonController(previewTheme: theme)
    }

    deinit {
        pollBox.cancel()
    }

    // MARK: - Computed Properties

    var baseURL: URL {
        URL(string: "http://127.0.0.1:\(daemonPort)")!
    }

    var compressionEnabled: Bool {
        health?.compressionEnabled ?? stats?.compressionEnabled ?? true
    }

    var priceMode: String {
        health?.priceMode ?? stats?.pricingAssumptions?.priceMode ?? "kosha"
    }

    var daemonPid: Int? {
        health?.pid ?? spawnedPid.map { Int($0) }
    }

    var uptimeSec: Double? {
        health?.uptimeSec ?? stats?.uptimeSec
    }

    var daemonVersion: String? {
        health?.version
    }

    var mergedModelsCatalog: [ModelCatalogItem] {
        var result: [ModelCatalogItem] = []
        var seen = Set<String>()

        func append(_ item: ModelCatalogItem) {
            guard !item.id.isEmpty, !seen.contains(item.id) else { return }
            seen.insert(item.id)
            result.append(item)
        }

        for item in ModelCatalogItem.curatedDefaults {
            append(item)
        }
        for item in modelCatalog {
            append(item)
        }
        for id in allowedModels {
            append(ModelCatalogItem(id: id, label: id, family: ModelCatalogItem.inferFamily(for: id)))
        }
        return result
    }

    var sortedByModelStats: [(model: String, stats: ModelStats)] {
        stats?.byModel
            .map { (model: $0.key, stats: $0.value) }
            .sorted { lhs, rhs in
                if lhs.stats.savedInputTokens != rhs.stats.savedInputTokens {
                    return lhs.stats.savedInputTokens > rhs.stats.savedInputTokens
                }
                if lhs.stats.requests != rhs.stats.requests {
                    return lhs.stats.requests > rhs.stats.requests
                }
                return lhs.model < rhs.model
            } ?? []
    }

    // MARK: - Polling Lifecycle

    func startPolling() {
        guard !isPreview else { return }
        let task = Task { [weak self] in
            guard let self else { return }
            await self.performInitialBootCheck()
            while !Task.isCancelled {
                let interval = self.pollIntervalSeconds
                try? await Task.sleep(for: .seconds(interval))
                if Task.isCancelled { break }
                await self.pollOnce()
            }
        }
        pollBox.replace(with: task)
    }

    func refreshNow() {
        guard !isPreview else { return }
        Task { [weak self] in
            await self?.pollOnce()
        }
    }

    private func performInitialBootCheck() async {
        guard !hasPerformedStartupCheck else { return }
        hasPerformedStartupCheck = true

        let reachable = await pollOnce()
        if !reachable && autoStartDaemon {
            await startDaemon()
        }
    }

    @discardableResult
    func pollOnce() async -> Bool {
        isLoginAgentInstalled = Self.checkLaunchAgentExists()

        // Probe /api/health first; fall back to /proxy-stats if daemon predates /api/health
        let healthResult: HTTPResult<HealthResponse> = await getJSON(path: "/api/health")
        switch healthResult {
        case .ok(let h):
            health = h
            if let models = h.allowedModels {
                allowedModels = models
            }
            if phase == .starting {
                isBusy = false
            }
            lastError = nil
        case .httpError(let status, _) where status == 404:
            // Older daemon without /api/health — check /proxy-stats below
            health = nil
        case .httpError(let status, let body):
            health = nil
            if phase != .starting {
                phase = .stopped
            }
            lastError = "Daemon returned HTTP \(status): \(body)"
            return false
        case .unreachable:
            health = nil
            stats = nil
            if phase != .starting {
                phase = .stopped
            }
            return false
        }

        async let statsFetch: HTTPResult<ProxyStatsResponse> = getJSON(path: "/proxy-stats")
        async let turnFetch: HTTPResult<LastTurnResponse> = getJSON(path: "/api/last-turn.json")
        async let modelsFetch: HTTPResult<ModelsResponse> = getJSON(path: "/api/models")
        async let pluginsFetch: HTTPResult<PluginsResponse> = getJSON(path: "/api/plugins")

        let (statsRes, turnRes, modelsRes, pluginsRes) = await (statsFetch, turnFetch, modelsFetch, pluginsFetch)

        var anyReachable = health != nil

        switch statsRes {
        case .ok(let s):
            stats = s
            anyReachable = true
            if let models = s.allowedModels {
                allowedModels = models
            }
        case .httpError, .unreachable:
            break
        }

        if !anyReachable {
            if phase != .starting {
                phase = .stopped
            }
            return false
        }

        if case .ok(let t) = turnRes {
            lastTurn = t
        }

        if case .ok(let m) = modelsRes {
            allowedModels = m.allowedModels
            if !m.catalog.isEmpty {
                modelCatalog = m.catalog
            }
        }

        switch pluginsRes {
        case .ok(let p):
            pluginsEndpointSupported = true
            plugins = p.items
            pluginsDir = p.pluginsDir
        case .httpError(let status, _) where status == 404:
            pluginsEndpointSupported = false
        case .httpError, .unreachable:
            break
        }

        let enabled = health?.compressionEnabled ?? stats?.compressionEnabled ?? true
        phase = enabled ? .live : .paused
        lastUpdatedAt = Date()
        lastError = nil
        return true
    }

    // MARK: - Daemon Start / Stop / Restart

    func startDaemon() async {
        guard !isBusy else { return }
        isBusy = true
        phase = .starting
        lastError = nil

        defer { isBusy = false }

        if await isDaemonReachable() {
            await pollOnce()
            return
        }

        isLoginAgentInstalled = Self.checkLaunchAgentExists()
        if isLoginAgentInstalled {
            let launchErr = await Self.kickstartLaunchAgent()
            if let launchErr {
                lastError = launchErr
                phase = .stopped
                return
            }
        } else {
            let port = daemonPort
            let spawnResult = await Task.detached(priority: .userInitiated) {
                Self.spawnDetachedDaemon(port: port)
            }.value

            switch spawnResult {
            case .success(let pid):
                spawnedPid = pid
            case .failure(let err):
                lastError = err.message
                phase = .stopped
                return
            }
        }

        // Wait up to 4 seconds for /api/health or /proxy-stats to accept connections
        for _ in 0..<16 {
            try? await Task.sleep(for: .milliseconds(250))
            if await isDaemonReachable() {
                await pollOnce()
                return
            }
        }

        let tailErr = await Task.detached(priority: .utility) {
            Self.readErrLogTail()
        }.value
        if let tailErr, !tailErr.isEmpty {
            lastError = "Daemon failed to become ready on :\(daemonPort) — \(tailErr)"
        } else {
            lastError = "Timed out waiting for daemon on 127.0.0.1:\(daemonPort)."
        }
        phase = .stopped
    }

    func stopDaemon() async {
        guard !isBusy else { return }
        isBusy = true
        lastError = nil

        defer { isBusy = false }

        let knownPid = daemonPid
        let shutdownRes: HTTPResult<Data> = await postEmpty(path: "/api/shutdown")

        if isLoginAgentInstalled {
            _ = await Self.bootoutLaunchAgent()
        } else if case .httpError(let status, _) = shutdownRes, status == 404, let pid = knownPid {
            kill(pid_t(pid), SIGTERM)
        } else if case .unreachable = shutdownRes, let pid = knownPid {
            kill(pid_t(pid), SIGTERM)
        }

        for _ in 0..<12 {
            try? await Task.sleep(for: .milliseconds(150))
            if !(await isDaemonReachable()) {
                break
            }
        }

        if await isDaemonReachable(), let pid = knownPid, !isLoginAgentInstalled {
            kill(pid_t(pid), SIGTERM)
            try? await Task.sleep(for: .milliseconds(250))
        }

        health = nil
        stats = nil
        spawnedPid = nil
        phase = .stopped
    }

    func restartDaemon() async {
        guard !isBusy else { return }
        if isLoginAgentInstalled {
            isBusy = true
            phase = .starting
            lastError = nil
            defer { isBusy = false }

            if let launchErr = await Self.kickstartLaunchAgent() {
                lastError = launchErr
                await pollOnce()
                return
            }
            for _ in 0..<16 {
                try? await Task.sleep(for: .milliseconds(250))
                if await isDaemonReachable() {
                    await pollOnce()
                    return
                }
            }
            lastError = "Daemon restart timed out on :\(daemonPort)."
            await pollOnce()
            return
        }

        await stopDaemon()
        try? await Task.sleep(for: .milliseconds(250))
        await startDaemon()
    }

    func stopDaemonAndQuit() {
        Task { @MainActor in
            await stopDaemon()
            NSApp.terminate(nil)
        }
    }

    func quitMenubarOnly() {
        NSApp.terminate(nil)
    }

    // MARK: - Live Controls

    func toggleCompression() {
        let nextEnabled = !compressionEnabled
        Task { [weak self] in
            await self?.setCompression(enabled: nextEnabled)
        }
    }

    func setCompression(enabled: Bool) async {
        struct Body: Encodable { let enabled: Bool }
        let res: HTTPResult<CompressionToggleResponse> = await postJSON(path: "/api/compression", body: Body(enabled: enabled))
        switch res {
        case .ok(let payload):
            phase = payload.compressionEnabled ? .live : .paused
            lastError = nil
            await pollOnce()
        case .httpError(let status, let msg):
            lastError = "Compression toggle failed (\(status)): \(msg)"
        case .unreachable(let reason):
            lastError = "Daemon unreachable: \(reason)"
            phase = .stopped
        }
    }

    func toggleModel(model: String, on: Bool) {
        Task { [weak self] in
            await self?.setModel(model: model, on: on)
        }
    }

    private func setModel(model: String, on: Bool) async {
        struct ToggleBody: Encodable {
            let model: String
            let on: Bool
        }

        var nextSet = Set(allowedModels)
        if on { nextSet.insert(model) } else { nextSet.remove(model) }
        allowedModels = Array(nextSet).sorted()

        let res: HTTPResult<ModelsResponse> = await postJSON(path: "/api/models", body: ToggleBody(model: model, on: on))
        switch res {
        case .ok(let payload):
            if !payload.allowedModels.isEmpty || on == false {
                allowedModels = payload.allowedModels
            }
            lastError = nil
            await pollOnce()
        case .httpError(let status, _) where status == 404:
            // Back-compat fallback for daemons with /fragments/models only
            let fallback: HTTPResult<Data> = await postJSONRaw(path: "/fragments/models", body: ToggleBody(model: model, on: on))
            if case .httpError(let fbStatus, let fbMsg) = fallback {
                lastError = "Model update failed (\(fbStatus)): \(fbMsg)"
            } else {
                await pollOnce()
            }
        case .httpError(let status, let msg):
            lastError = "Model update failed (\(status)): \(msg)"
            await pollOnce()
        case .unreachable(let reason):
            lastError = "Daemon unreachable: \(reason)"
        }
    }

    func setModels(_ models: [String]) async {
        guard !isPreview else { return }
        struct ListBody: Encodable { let models: [String] }
        let res: HTTPResult<ModelsResponse> = await postJSON(path: "/api/models", body: ListBody(models: models))
        switch res {
        case .ok(let payload):
            allowedModels = payload.allowedModels
            lastError = nil
            await pollOnce()
        case .httpError(let status, let msg):
            lastError = "Model scope update failed (\(status)): \(msg)"
        case .unreachable(let reason):
            lastError = "Daemon unreachable: \(reason)"
        }
    }

    static func isThirdPartyModel(_ id: String) -> Bool {
        let cleaned = id
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: #"\[[^\]]*\]"#, with: "", options: .regularExpression)
        guard !cleaned.isEmpty else { return false }
        let base = cleaned.split(separator: "/").last.map(String.init) ?? cleaned
        if base.hasPrefix("claude") || cleaned.contains("gemini") || base.hasPrefix("gpt") {
            return false
        }
        if base == "o1" || base.hasPrefix("o1-") || base == "o3" || base.hasPrefix("o3-") || base == "o4" || base.hasPrefix("o4-") {
            return false
        }
        return true
    }

    var enabledThirdPartyModels: [String] {
        allowedModels.filter { Self.isThirdPartyModel($0) }
    }

    var catalogThirdPartyModels: [String] {
        mergedModelsCatalog.map(\.id).filter { Self.isThirdPartyModel($0) }
    }

    func disableAllThirdPartyModels() {
        let filtered = allowedModels.filter { !Self.isThirdPartyModel($0) }
        allowedModels = filtered
        guard !isPreview else { return }
        Task { [weak self] in
            await self?.setModels(filtered)
        }
    }

    func enableAllThirdPartyModels() {
        var seen = Set(allowedModels)
        var merged = allowedModels
        for id in catalogThirdPartyModels where !seen.contains(id) {
            seen.insert(id)
            merged.append(id)
        }
        allowedModels = merged
        guard !isPreview else { return }
        Task { [weak self] in
            await self?.setModels(merged)
        }
    }

    func togglePlugin(id: String, enabled: Bool) {
        plugins = plugins.map { $0.id == id ? $0.withEnabled(enabled) : $0 }
        guard !isPreview else { return }
        Task { [weak self] in
            await self?.setPlugin(id: id, enabled: enabled)
        }
    }

    private static let builtInPluginIDs: Set<String> = [
        "optical-microfiche",
        "tscg-schema",
        "toon-structured",
        "acdc-epochs",
        "casi-delta",
        "skill:fiche",
    ]

    static func isThirdPartyPlugin(_ plugin: PluginDescriptor) -> Bool {
        plugin.kind != .stage && !builtInPluginIDs.contains(plugin.id)
    }

    var thirdPartyPlugins: [PluginDescriptor] {
        plugins.filter { Self.isThirdPartyPlugin($0) }
    }

    var enabledThirdPartyPluginsCount: Int {
        thirdPartyPlugins.filter(\.enabled).count
    }

    var hasEnabledThirdPartyPlugins: Bool {
        enabledThirdPartyPluginsCount > 0
    }

    func setAllThirdPartyPlugins(enabled: Bool) {
        plugins = plugins.map { Self.isThirdPartyPlugin($0) ? $0.withEnabled(enabled) : $0 }
        guard !isPreview else { return }
        Task { [weak self] in
            await self?.postThirdPartyPlugins(enabled: enabled)
        }
    }

    private func postThirdPartyPlugins(enabled: Bool) async {
        struct ScopeBody: Encodable {
            let scope: String
            let enabled: Bool
        }

        let res: HTTPResult<Data> = await postJSONRaw(
            path: "/api/plugins",
            body: ScopeBody(scope: "third-party", enabled: enabled)
        )
        switch res {
        case .ok:
            lastError = nil
            await pollOnce()
        case .httpError(let status, let msg):
            lastError = "3rd-party plugin update failed (\(status)): \(msg)"
            await pollOnce()
        case .unreachable(let reason):
            lastError = "Daemon unreachable: \(reason)"
            await pollOnce()
        }
    }

    static func discoverInstalledDesktopApps() -> [String] {
        let candidates = [
            "Antigravity",
            "Antigravity IDE",
            "Claude",
            "Cursor",
            "OpenCode",
            "Runic",
            "ChatGPT",
        ]
        let fm = FileManager.default
        let userApps = fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path
        return candidates.filter { name in
            fm.fileExists(atPath: "/Applications/\(name).app")
                || fm.fileExists(atPath: "\(userApps)/\(name).app")
        }
    }

    func launchDesktopAppViaFiche(_ appName: String) {
        guard !isPreview else { return }
        lastError = nil
        Task.detached(priority: .userInitiated) {
            let nodePath = Self.resolveNodeBinary()
            guard let exe = Self.resolveFicheExecutable(nodePath: nodePath) else {
                await MainActor.run { [weak self] in
                    self?.lastError = "Could not locate fiche CLI to warp \(appName)."
                }
                return
            }

            let process = Process()
            switch exe {
            case .binary(let bin):
                process.executableURL = URL(fileURLWithPath: bin)
                process.arguments = ["warp", "--app", appName]
            case .nodeScript(let node, let script):
                process.executableURL = URL(fileURLWithPath: node)
                process.arguments = [script, "warp", "--app", appName]
            }

            var env = ProcessInfo.processInfo.environment
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            let existingPath = env["PATH"] ?? "/usr/bin:/bin"
            env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(home)/.local/bin:\(existingPath)"
            process.environment = env
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice

            do {
                try process.run()
            } catch {
                await MainActor.run { [weak self] in
                    self?.lastError = "Failed to launch \(appName): \(error.localizedDescription)"
                }
            }
        }
    }

    private func setPlugin(id: String, enabled: Bool) async {
        struct PluginBody: Encodable {
            let id: String
            let enabled: Bool
        }

        plugins = plugins.map { $0.id == id ? $0.withEnabled(enabled) : $0 }

        let res: HTTPResult<Data> = await postJSONRaw(path: "/api/plugins", body: PluginBody(id: id, enabled: enabled))
        switch res {
        case .ok:
            lastError = nil
            await pollOnce()
        case .httpError(let status, let msg):
            lastError = "Plugin toggle failed (\(status)): \(msg)"
            await pollOnce()
        case .unreachable(let reason):
            lastError = "Daemon unreachable: \(reason)"
            await pollOnce()
        }
    }

    // MARK: - LaunchAgent Management

    func setLoginAgent(enabled: Bool) {
        if enabled {
            installLoginAgent()
        } else {
            uninstallLoginAgent()
        }
    }

    func installLoginAgent() {
        Task { [weak self] in
            await self?.runServiceSubcommand("install")
        }
    }

    func uninstallLoginAgent() {
        Task { [weak self] in
            await self?.runServiceSubcommand("uninstall")
        }
    }

    private func runServiceSubcommand(_ subcommand: String) async {
        guard !isBusy else { return }
        isBusy = true
        lastError = nil
        defer { isBusy = false }

        let result = await Task.detached(priority: .userInitiated) {
            Self.runFicheCommand(arguments: ["service", subcommand])
        }.value

        isLoginAgentInstalled = Self.checkLaunchAgentExists()
        if result.exitCode != 0 {
            let detail = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            let fallback = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            lastError = !detail.isEmpty
                ? detail
                : (!fallback.isEmpty ? fallback : "`fiche service \(subcommand)` exited with code \(result.exitCode)")
        } else {
            await pollOnce()
        }
    }

    // MARK: - Folder & Dashboard Actions

    func openDashboard() {
        NSWorkspace.shared.open(baseURL)
    }

    func openSponsor() {
        if let url = URL(string: "https://github.com/sponsors/sriinnu") {
            NSWorkspace.shared.open(url)
        }
    }

    func openRepository() {
        if let url = URL(string: "https://github.com/sriinnu/fiche") {
            NSWorkspace.shared.open(url)
        }
    }

    func openWebsite() {
        if let url = URL(string: "https://fiche.srinivas.dev") {
            NSWorkspace.shared.open(url)
        }
    }

    func openPluginsFolder() {
        let path: String
        if let raw = pluginsDir, !raw.isEmpty {
            path = (raw as NSString).expandingTildeInPath
        } else {
            path = Self.ficheHomeURL.appendingPathComponent("plugins").path
        }
        let url = URL(fileURLWithPath: path, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.open(url)
    }

    func openConfigFolder() {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config", isDirectory: true)
            .appendingPathComponent("fiche", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.open(url)
    }

    func openErrLog() {
        let url = Self.errLogURL
        if FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.open(url)
        } else {
            openFicheHomeFolder()
        }
    }

    func openFicheHomeFolder() {
        let url = Self.ficheHomeURL
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.open(url)
    }

    // MARK: - HTTP Client Helpers

    private func isDaemonReachable() async -> Bool {
        let healthProbe: HTTPResult<Data> = await getRaw(path: "/api/health")
        switch healthProbe {
        case .ok:
            return true
        case .httpError(let status, _) where status == 404:
            let legacyProbe: HTTPResult<Data> = await getRaw(path: "/proxy-stats")
            if case .ok = legacyProbe { return true }
            return false
        case .httpError, .unreachable:
            return false
        }
    }

    private func getRaw(path: String) async -> HTTPResult<Data> {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            return .unreachable("Invalid URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return await performRaw(req)
    }

    private func getJSON<T: Decodable & Sendable>(path: String) async -> HTTPResult<T> {
        let raw = await getRaw(path: path)
        switch raw {
        case .ok(let data):
            do {
                let decoded = try JSONDecoder().decode(T.self, from: data)
                return .ok(decoded)
            } catch {
                return .httpError(status: 200, body: "Decode error on \(path): \(error.localizedDescription)")
            }
        case .httpError(let status, let body):
            return .httpError(status: status, body: body)
        case .unreachable(let reason):
            return .unreachable(reason)
        }
    }

    private func postEmpty(path: String) async -> HTTPResult<Data> {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            return .unreachable("Invalid URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        return await performRaw(req)
    }

    private func postJSONRaw<Body: Encodable>(path: String, body: Body) async -> HTTPResult<Data> {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            return .unreachable("Invalid URL")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            req.httpBody = try JSONEncoder().encode(body)
        } catch {
            return .unreachable("Encode error: \(error.localizedDescription)")
        }
        return await performRaw(req)
    }

    private func postJSON<Body: Encodable, Resp: Decodable & Sendable>(path: String, body: Body) async -> HTTPResult<Resp> {
        let raw = await postJSONRaw(path: path, body: body)
        switch raw {
        case .ok(let data):
            do {
                let decoded = try JSONDecoder().decode(Resp.self, from: data)
                return .ok(decoded)
            } catch {
                return .httpError(status: 200, body: "Decode error on \(path): \(error.localizedDescription)")
            }
        case .httpError(let status, let msg):
            return .httpError(status: status, body: msg)
        case .unreachable(let reason):
            return .unreachable(reason)
        }
    }

    private func performRaw(_ request: URLRequest) async -> HTTPResult<Data> {
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                return .unreachable("Non-HTTP response")
            }
            if (200..<300).contains(http.statusCode) {
                return .ok(data)
            }
            let snippet = String(data: data.prefix(240), encoding: .utf8) ?? ""
            return .httpError(status: http.statusCode, body: snippet)
        } catch {
            return .unreachable(error.localizedDescription)
        }
    }

    // MARK: - Non-isolated Filesystem & Process Helpers

    nonisolated private static var ficheHomeURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".fiche", isDirectory: true)
    }

    nonisolated private static var outLogURL: URL {
        ficheHomeURL.appendingPathComponent("daemon.out.log")
    }

    nonisolated private static var errLogURL: URL {
        ficheHomeURL.appendingPathComponent("daemon.err.log")
    }

    nonisolated private static var launchAgentPlistURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
            .appendingPathComponent("\(launchAgentLabel).plist")
    }

    nonisolated private static func checkLaunchAgentExists() -> Bool {
        FileManager.default.fileExists(atPath: launchAgentPlistURL.path)
    }

    nonisolated private static func kickstartLaunchAgent() async -> String? {
        await Task.detached(priority: .userInitiated) {
            let uid = getuid()
            let domain = "gui/\(uid)"
            let target = "\(domain)/\(launchAgentLabel)"
            let plistPath = launchAgentPlistURL.path

            let first = runProcessSync(executable: "/bin/launchctl", arguments: ["kickstart", "-k", target])
            if first.exitCode == 0 {
                return nil
            }

            let bootstrap = runProcessSync(executable: "/bin/launchctl", arguments: ["bootstrap", domain, plistPath])
            if bootstrap.exitCode == 0 {
                let second = runProcessSync(executable: "/bin/launchctl", arguments: ["kickstart", "-k", target])
                if second.exitCode == 0 {
                    return nil
                }
                let err = second.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                return err.isEmpty ? "launchctl kickstart failed (\(second.exitCode))" : err
            }

            let bootErr = bootstrap.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            let firstErr = first.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return !bootErr.isEmpty ? bootErr : (!firstErr.isEmpty ? firstErr : "launchctl bootstrap failed (\(bootstrap.exitCode))")
        }.value
    }

    nonisolated private static func bootoutLaunchAgent() async -> String? {
        await Task.detached(priority: .userInitiated) {
            let uid = getuid()
            let target = "gui/\(uid)/\(launchAgentLabel)"
            let res = runProcessSync(executable: "/bin/launchctl", arguments: ["bootout", target])
            if res.exitCode == 0 { return nil }
            let err = res.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return err.isEmpty ? nil : err
        }.value
    }

    nonisolated private static func resolveNodeBinary() -> String? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path

        let fixedCandidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
        ]
        for candidate in fixedCandidates where fm.isExecutableFile(atPath: candidate) {
            return candidate
        }

        // Check common version managers (newest version directory first)
        let versionedDirs = [
            "\(home)/.nvm/versions/node",
            "\(home)/.fnm/node-versions",
            "\(home)/.local/share/mise/installs/node",
            "\(home)/.volta/tools/image/node",
        ]
        for base in versionedDirs {
            guard let entries = try? fm.contentsOfDirectory(atPath: base) else { continue }
            let sorted = entries.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            for ver in sorted {
                let direct = "\(base)/\(ver)/bin/node"
                if fm.isExecutableFile(atPath: direct) { return direct }
                let fnm = "\(base)/\(ver)/installation/bin/node"
                if fm.isExecutableFile(atPath: fnm) { return fnm }
            }
        }

        // Fallback to PATH lookup via /usr/bin/which
        let whichRes = runProcessSync(
            executable: "/usr/bin/which",
            arguments: ["node"],
            extraPathPrefix: "/opt/homebrew/bin:/usr/local/bin:\(home)/.local/bin"
        )
        let found = whichRes.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if whichRes.exitCode == 0, !found.isEmpty, fm.isExecutableFile(atPath: found) {
            return found
        }
        return nil
    }

    nonisolated private static func resolveFicheExecutable(nodePath: String?) -> FicheExecutable? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path

        var binaryCandidates = [
            "\(home)/.local/bin/fiche",
            "/opt/homebrew/bin/fiche",
            "/usr/local/bin/fiche",
            "\(home)/.npm-global/bin/fiche",
        ]
        if let nodePath {
            let nodeDir = (nodePath as NSString).deletingLastPathComponent
            binaryCandidates.insert("\(nodeDir)/fiche", at: 0)
        }

        for path in binaryCandidates where fm.isExecutableFile(atPath: path) {
            return .binary(path)
        }

        let whichRes = runProcessSync(
            executable: "/usr/bin/which",
            arguments: ["fiche"],
            extraPathPrefix: "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin"
        )
        let found = whichRes.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if whichRes.exitCode == 0, !found.isEmpty, fm.isExecutableFile(atPath: found) {
            return .binary(found)
        }

        if let customCli = ProcessInfo.processInfo.environment["FICHE_CLI_PATH"],
           !customCli.isEmpty,
           fm.fileExists(atPath: customCli) {
            if fm.isExecutableFile(atPath: customCli), !customCli.hasSuffix(".js") {
                return .binary(customCli)
            }
            if let nodePath {
                return .nodeScript(node: nodePath, script: customCli)
            }
        }

        return nil
    }

    private struct SpawnFailure: Error {
        let message: String
    }

    nonisolated private static func spawnDetachedDaemon(port: Int) -> Result<Int32, SpawnFailure> {
        let nodePath = resolveNodeBinary()
        guard let entry = resolveFicheExecutable(nodePath: nodePath) else {
            return .failure(SpawnFailure(
                message: "Could not locate `fiche` or `node`. Install `@sriinnu/fiche` or build `dist/node.js`."
            ))
        }

        let fm = FileManager.default
        do {
            try fm.createDirectory(at: ficheHomeURL, withIntermediateDirectories: true)
        } catch {
            return .failure(SpawnFailure(message: "Failed to create ~/.fiche: \(error.localizedDescription)"))
        }

        let outFd = Darwin.open(outLogURL.path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        let errFd = Darwin.open(errLogURL.path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
        guard outFd >= 0, errFd >= 0 else {
            if outFd >= 0 { Darwin.close(outFd) }
            if errFd >= 0 { Darwin.close(errFd) }
            return .failure(SpawnFailure(message: "Unable to open daemon log files under ~/.fiche/."))
        }

        let outHandle = FileHandle(fileDescriptor: outFd, closeOnDealloc: true)
        let errHandle = FileHandle(fileDescriptor: errFd, closeOnDealloc: true)

        let process = Process()
        switch entry {
        case .binary(let binPath):
            process.executableURL = URL(fileURLWithPath: binPath)
            process.arguments = []
        case .nodeScript(let node, let script):
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = [script]
        }

        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        env["HOST"] = "127.0.0.1"
        env["FICHE_PRICES"] = "kosha"
        env["FICHE_TEXT_HYGIENE"] = "on"
        env["PATH"] = buildAugmentedPath(existing: env["PATH"], nodePath: nodePath)
        process.environment = env

        process.standardInput = FileHandle.nullDevice
        process.standardOutput = outHandle
        process.standardError = errHandle

        do {
            try process.run()
            let pid = process.processIdentifier
            return .success(pid)
        } catch {
            return .failure(SpawnFailure(message: "Failed to launch fiche daemon: \(error.localizedDescription)"))
        }
    }

    nonisolated private static func runFicheCommand(arguments: [String]) -> CommandOutput {
        let nodePath = resolveNodeBinary()
        guard let entry = resolveFicheExecutable(nodePath: nodePath) else {
            return CommandOutput(
                exitCode: 127,
                stdout: "",
                stderr: "Could not locate `fiche` or `node` executable."
            )
        }

        switch entry {
        case .binary(let binPath):
            return runProcessSync(
                executable: binPath,
                arguments: arguments,
                extraPathPrefix: nodePath.map { ($0 as NSString).deletingLastPathComponent }
            )
        case .nodeScript(let node, let script):
            return runProcessSync(
                executable: node,
                arguments: [script] + arguments,
                extraPathPrefix: (node as NSString).deletingLastPathComponent
            )
        }
    }

    nonisolated private static func runProcessSync(
        executable: String,
        arguments: [String],
        extraPathPrefix: String? = nil
    ) -> CommandOutput {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = buildAugmentedPath(existing: env["PATH"], extraPrefix: extraPathPrefix)
        process.environment = env

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = outPipe
        process.standardError = errPipe

        do {
            try process.run()
        } catch {
            return CommandOutput(exitCode: 1, stdout: "", stderr: error.localizedDescription)
        }

        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        return CommandOutput(
            exitCode: process.terminationStatus,
            stdout: String(data: outData, encoding: .utf8) ?? "",
            stderr: String(data: errData, encoding: .utf8) ?? ""
        )
    }

    nonisolated private static func buildAugmentedPath(
        existing: String?,
        nodePath: String? = nil,
        extraPrefix: String? = nil
    ) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        var segments: [String] = []
        if let extraPrefix, !extraPrefix.isEmpty {
            segments.append(extraPrefix)
        }
        if let nodePath {
            segments.append((nodePath as NSString).deletingLastPathComponent)
        }
        segments.append(contentsOf: [
            "\(home)/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ])
        if let existing, !existing.isEmpty {
            segments.append(existing)
        }
        var seen = Set<String>()
        return segments
            .flatMap { $0.split(separator: ":").map(String.init) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
            .joined(separator: ":")
    }

    nonisolated private static func readErrLogTail() -> String? {
        guard let data = try? Data(contentsOf: errLogURL), !data.isEmpty else { return nil }
        let slice = data.suffix(512)
        guard let text = String(data: slice, encoding: .utf8) else { return nil }
        let lines = text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return lines.last
    }
}
