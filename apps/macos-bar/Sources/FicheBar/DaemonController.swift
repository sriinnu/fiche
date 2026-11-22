import AppKit
import Darwin
import Foundation

@_silgen_name("proc_pidpath")
private func cProcPidPath(_ pid: Int32, _ buffer: UnsafeMutableRawPointer, _ bufferSize: UInt32) -> Int32

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
    @Published private(set) var isShellAutoWrapInstalled: Bool = false
    @Published private(set) var discoveredDesktopApps: [String] = []
    @Published private(set) var discoveredCLIAgents: [DiscoveredCLIAgent] = []
    @Published private(set) var transientNotice: String? = nil
    @Published private(set) var isBusy: Bool = false
    @Published private(set) var lastError: String?
    @Published private(set) var lastUpdatedAt: Date?
    @Published private(set) var spawnedPid: Int32?
    @Published private(set) var pluginsEndpointSupported: Bool = true

    private let isPreview: Bool
    private let session: URLSession
    private let pollBox = TaskCancellationBox()
    private var hasPerformedStartupCheck = false
    private var noticeGeneration: Int = 0

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
        self.isShellAutoWrapInstalled = Self.checkShellAutoWrapInstalled()
        startPolling()
        refreshAgentDiscovery()
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
          "requests": 14,
          "compressed_requests": 7,
          "imaged_requests": 7,
          "text_compressed_requests": 0,
          "passthrough": 7,
          "baseline_input_weighted": 88420,
          "actual_input_weighted": 36140,
          "saved_input_tokens": 52280,
          "raw_saved_tokens": 123500,
          "saved_pct": 59.1,
          "saved_usd": 0.142,
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
          "today": {
            "date": "2026-11-22",
            "requests": 5,
            "compressed": 4,
            "imaged": 4,
            "text_compressed": 0,
            "baseline_input_weighted": 31200,
            "actual_input_weighted": 12800,
            "saved_tokens": 18400,
            "raw_saved_tokens": 41200,
            "saved_pct": 59.0,
            "saved_usd": 0.048,
            "cliff_saved_usd": 0,
            "is_today": true
          },
          "daily": [
            {"date":"2026-11-09","requests":0,"compressed":0,"imaged":0,"text_compressed":0,"baseline_input_weighted":0,"actual_input_weighted":0,"saved_tokens":0,"raw_saved_tokens":0,"saved_pct":0,"saved_usd":0,"cliff_saved_usd":0,"is_today":false},
            {"date":"2026-11-10","requests":4,"compressed":3,"imaged":3,"text_compressed":0,"baseline_input_weighted":18000,"actual_input_weighted":8200,"saved_tokens":9800,"raw_saved_tokens":21000,"saved_pct":54.4,"saved_usd":0.025,"cliff_saved_usd":0,"is_today":false},
            {"date":"2026-11-11","requests":6,"compressed":5,"imaged":4,"text_compressed":1,"baseline_input_weighted":28000,"actual_input_weighted":11200,"saved_tokens":16800,"raw_saved_tokens":34500,"saved_pct":60.0,"saved_usd":0.042,"cliff_saved_usd":0,"is_today":false},
            {"date":"2026-11-12","requests":3,"compressed":2,"imaged":2,"text_compressed":0,"baseline_input_weighted":12000,"actual_input_weighted":5600,"saved_tokens":6400,"raw_saved_tokens":14200,"saved_pct":53.3,"saved_usd":0.016,"cliff_saved_usd":0,"is_today":false},
            {"date":"2026-11-13","requests":0,"compressed":0,"imaged":0,"text_compressed":0,"baseline_input_weighted":0,"actual_input_weighted":0,"saved_tokens":0,"raw_saved_tokens":0,"saved_pct":0,"saved_usd":0,"cliff_saved_usd":0,"is_today":false},
            {"date":"2026-11-14","requests":8,"compressed":6,"imaged":5,"text_compressed":1,"baseline_input_weighted":42000,"actual_input_weighted":16400,"saved_tokens":25600,"raw_saved_tokens":58000,"saved_pct":61.0,"saved_usd":0.068,"cliff_saved_usd":0,"is_today":false},
            {"date":"2026-11-15","requests":5,"compressed":4,"imaged":3,"text_compressed":1,"baseline_input_weighted":24000,"actual_input_weighted":9800,"saved_tokens":14200,"raw_saved_tokens":31000,"saved_pct":59.2,"saved_usd":0.036,"cliff_saved_usd":0,"is_today":false},
            {"date":"2026-11-16","requests":7,"compressed":5,"imaged":4,"text_compressed":1,"baseline_input_weighted":35000,"actual_input_weighted":14000,"saved_tokens":21000,"raw_saved_tokens":46000,"saved_pct":60.0,"saved_usd":0.055,"cliff_saved_usd":0,"is_today":false},
            {"date":"2026-11-17","requests":9,"compressed":7,"imaged":6,"text_compressed":1,"baseline_input_weighted":48000,"actual_input_weighted":18900,"saved_tokens":29100,"raw_saved_tokens":64000,"saved_pct":60.6,"saved_usd":0.079,"cliff_saved_usd":0,"is_today":false},
            {"date":"2026-11-18","requests":4,"compressed":3,"imaged":2,"text_compressed":1,"baseline_input_weighted":19000,"actual_input_weighted":8100,"saved_tokens":10900,"raw_saved_tokens":24500,"saved_pct":57.4,"saved_usd":0.029,"cliff_saved_usd":0,"is_today":false},
            {"date":"2026-11-19","requests":11,"compressed":9,"imaged":7,"text_compressed":2,"baseline_input_weighted":61000,"actual_input_weighted":22500,"saved_tokens":38500,"raw_saved_tokens":89000,"saved_pct":63.1,"saved_usd":0.108,"cliff_saved_usd":0,"is_today":false},
            {"date":"2026-11-20","requests":6,"compressed":5,"imaged":4,"text_compressed":1,"baseline_input_weighted":29000,"actual_input_weighted":11900,"saved_tokens":17100,"raw_saved_tokens":38000,"saved_pct":59.0,"saved_usd":0.044,"cliff_saved_usd":0,"is_today":false},
            {"date":"2026-11-21","requests":9,"compressed":7,"imaged":7,"text_compressed":0,"baseline_input_weighted":57220,"actual_input_weighted":23340,"saved_tokens":33880,"raw_saved_tokens":82300,"saved_pct":59.2,"saved_usd":0.094,"cliff_saved_usd":0,"is_today":false},
            {"date":"2026-11-22","requests":5,"compressed":4,"imaged":4,"text_compressed":0,"baseline_input_weighted":31200,"actual_input_weighted":12800,"saved_tokens":18400,"raw_saved_tokens":41200,"saved_pct":59.0,"saved_usd":0.048,"cliff_saved_usd":0,"is_today":true}
          ],
          "by_model": {
            "gemini-4-argon-high": {
              "requests": 7,
              "compressed_requests": 7,
              "imaged": 7,
              "text_compressed": 0,
              "baseline_input_weighted": 57220,
              "actual_input_weighted": 23340,
              "saved_input_tokens": 33880,
              "raw_saved_tokens": 82300,
              "saved_pct": 59.2,
              "saved_usd": 0.094,
              "cliff_avoided_events": 0,
              "cliff_saved_usd": 0
            },
            "claude-opus-5": {
              "requests": 4,
              "compressed_requests": 4,
              "imaged": 0,
              "text_compressed": 4,
              "baseline_input_weighted": 31200,
              "actual_input_weighted": 12800,
              "saved_input_tokens": 18400,
              "raw_saved_tokens": 41200,
              "saved_pct": 59.0,
              "saved_usd": 0.048,
              "cliff_avoided_events": 0,
              "cliff_saved_usd": 0
            },
            "gemini-4-neon-high": {
              "requests": 3,
              "compressed_requests": 0,
              "imaged": 0,
              "text_compressed": 0,
              "baseline_input_weighted": 0,
              "actual_input_weighted": 0,
              "saved_input_tokens": 0,
              "raw_saved_tokens": 0,
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
        self.isShellAutoWrapInstalled = false
        self.discoveredDesktopApps = ["Antigravity", "Cursor", "Claude"]
        self.discoveredCLIAgents = [
            DiscoveredCLIAgent(id: "claude", name: "Claude Code", command: "claude", provider: "Anthropic", installed: true, binaryPath: "/Users/demo/.local/bin/claude"),
            DiscoveredCLIAgent(id: "codex", name: "OpenAI Codex", command: "codex", provider: "OpenAI", installed: true, binaryPath: "/usr/local/bin/codex"),
            DiscoveredCLIAgent(id: "agy", name: "Antigravity CLI", command: "agy", provider: "Google / Multi", installed: true, binaryPath: "/Users/demo/.local/bin/agy"),
            DiscoveredCLIAgent(id: "gemini", name: "Gemini CLI", command: "gemini", provider: "Google", installed: true, binaryPath: "/Users/demo/.local/bin/gemini"),
            DiscoveredCLIAgent(id: "opencode", name: "OpenCode", command: "opencode", provider: "Multi", installed: true, binaryPath: "/Users/demo/.opencode/bin/opencode"),
            DiscoveredCLIAgent(id: "aider", name: "Aider", command: "aider", provider: "Multi", installed: false, binaryPath: nil),
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
        } else if case .httpError(let status, _) = shutdownRes, status == 404, let pid = knownPid, Self.isFicheProcess(pid: pid) {
            Darwin.kill(pid_t(pid), SIGTERM)
        } else if case .unreachable = shutdownRes, let pid = knownPid, Self.isFicheProcess(pid: pid) {
            Darwin.kill(pid_t(pid), SIGTERM)
        }

        for _ in 0..<12 {
            try? await Task.sleep(for: .milliseconds(150))
            if !(await isDaemonReachable()) {
                break
            }
        }

        if await isDaemonReachable(), let pid = knownPid, !isLoginAgentInstalled, Self.isFicheProcess(pid: pid) {
            Darwin.kill(pid_t(pid), SIGTERM)
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

    nonisolated static let supportedCLICatalog: [(command: String, name: String, provider: String)] = [
        ("claude", "Claude Code", "Anthropic"),
        ("codex", "OpenAI Codex", "OpenAI"),
        ("agy", "Antigravity CLI", "Google / Multi"),
        ("gemini", "Gemini CLI", "Google"),
        ("opencode", "OpenCode", "Multi"),
        ("cursor-agent", "Cursor Agent", "Multi"),
        ("amp", "Amp", "Multi"),
        ("pi", "Pi Agent", "Multi"),
        ("aider", "Aider", "Multi"),
    ]

    private static let allowedCLICommands: Set<String> = Set(supportedCLICatalog.map(\.command))

    nonisolated static func discoverInstalledDesktopApps() -> [String] {
        let candidates = [
            "Antigravity",
            "Antigravity IDE",
            "Cursor",
            "Claude",
            "Windsurf",
            "Zed",
            "OpenCode",
            "ChatGPT",
            "Runic",
        ]
        let fm = FileManager.default
        let userApps = fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path
        return candidates.filter { name in
            fm.fileExists(atPath: "/Applications/\(name).app")
                || fm.fileExists(atPath: "\(userApps)/\(name).app")
        }
    }

    nonisolated static func discoverInstalledCLIAgents() -> [DiscoveredCLIAgent] {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        var searchDirs: [String] = []
        if let envPath = ProcessInfo.processInfo.environment["PATH"] {
            searchDirs.append(contentsOf: envPath.split(separator: ":").map(String.init))
        }
        searchDirs.append(contentsOf: [
            "\(home)/.local/bin",
            "\(home)/.opencode/bin",
            "\(home)/.antigravity/antigravity/bin",
            "\(home)/.bun/bin",
            "\(home)/.cargo/bin",
            "\(home)/.npm-global/bin",
            "\(home)/.pnpm-global/bin",
            "\(home)/Library/pnpm",
            "\(home)/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
        ])

        let versionRoots = [
            "\(home)/.nvm/versions/node",
            "\(home)/.fnm/node-versions",
            "\(home)/.local/share/mise/installs/node",
            "\(home)/.volta/tools/image/node",
        ]
        for root in versionRoots {
            guard let entries = try? fm.contentsOfDirectory(atPath: root) else { continue }
            let sorted = entries.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            for ver in sorted {
                searchDirs.append("\(root)/\(ver)/bin")
                searchDirs.append("\(root)/\(ver)/installation/bin")
            }
        }

        var uniqueDirs: [String] = []
        var seenDirs = Set<String>()
        for dir in searchDirs where !dir.isEmpty && seenDirs.insert(dir).inserted {
            uniqueDirs.append(dir)
        }

        return supportedCLICatalog.map { entry in
            var foundPath: String?
            for dir in uniqueDirs {
                let candidate = "\(dir)/\(entry.command)"
                if fm.isExecutableFile(atPath: candidate) {
                    foundPath = candidate
                    break
                }
            }
            return DiscoveredCLIAgent(
                id: entry.command,
                name: entry.name,
                command: entry.command,
                provider: entry.provider,
                installed: foundPath != nil,
                binaryPath: foundPath
            )
        }
    }

    func refreshAgentDiscovery() {
        guard !isPreview else { return }
        Task.detached(priority: .utility) { [weak self] in
            let apps = Self.discoverInstalledDesktopApps()
            let clis = Self.discoverInstalledCLIAgents()
            let autoWrap = Self.checkShellAutoWrapInstalled()
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.discoveredDesktopApps = apps
                self.discoveredCLIAgents = clis
                self.isShellAutoWrapInstalled = autoWrap
            }
        }
    }

    func showTransientNotice(_ message: String) {
        noticeGeneration &+= 1
        let gen = noticeGeneration
        transientNotice = message
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(2_200))
            guard let self, self.noticeGeneration == gen else { return }
            self.transientNotice = nil
        }
    }

    func copyToClipboard(_ text: String, label: String = "Copied to clipboard") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        showTransientNotice(label)
    }

    nonisolated private static func shellSingleQuote(_ s: String) -> String {
        "'" + s.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
    }

    func launchCLIAgentInTerminal(_ command: String) {
        guard Self.allowedCLICommands.contains(command) else {
            lastError = "Unsupported CLI agent: \(command)"
            return
        }
        guard !isPreview else { return }
        lastError = nil
        let targetCli = command
        Task.detached(priority: .userInitiated) { [weak self] in
            let nodePath = Self.resolveNodeBinary()
            let ficheCmd: String
            if let exe = Self.resolveFicheExecutable(nodePath: nodePath) {
                switch exe {
                case .binary(let bin):
                    ficheCmd = "\(Self.shellSingleQuote(bin)) warp -- \(targetCli)"
                case .nodeScript(let node, let script):
                    ficheCmd = "\(Self.shellSingleQuote(node)) \(Self.shellSingleQuote(script)) warp -- \(targetCli)"
                }
            } else {
                ficheCmd = "fiche warp -- \(targetCli)"
            }

            let script = """
            on run argv
                set cmd to item 1 of argv
                tell application "Terminal"
                    activate
                    do script cmd
                end tell
            end run
            """
            let res = Self.runProcessSync(executable: "/usr/bin/osascript", arguments: ["-e", script, ficheCmd])
            await MainActor.run { [weak self] in
                guard let self else { return }
                if res.exitCode != 0 {
                    let msg = res.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                    self.lastError = msg.isEmpty ? "Could not open Terminal for \(targetCli)." : msg
                } else {
                    self.showTransientNotice("Opening \(targetCli) via Fiche in Terminal…")
                }
            }
        }
    }

    nonisolated static func checkShellAutoWrapInstalled() -> Bool {
        let zshrcURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".zshrc")
        guard let content = try? String(contentsOf: zshrcURL, encoding: .utf8) else { return false }
        return content.contains("fiche shell-init") && content.contains("--wrap")
    }

    func installShellAutoWrap() {
        guard !isPreview else { return }
        lastError = nil
        Task.detached(priority: .userInitiated) { [weak self] in
            let fm = FileManager.default
            let zshrcURL = fm.homeDirectoryForCurrentUser.appendingPathComponent(".zshrc")
            let existing = (try? String(contentsOf: zshrcURL, encoding: .utf8)) ?? ""
            if existing.contains("fiche shell-init") && existing.contains("--wrap") {
                await MainActor.run { [weak self] in
                    self?.isShellAutoWrapInstalled = true
                    self?.showTransientNotice("Auto-wrap already enabled in ~/.zshrc")
                }
                return
            }

            let snippet = """

            # Fiche: auto-route coding CLIs through local proxy (bypass anytime with FICHE_BYPASS=1)
            if command -v fiche >/dev/null 2>&1; then
              eval "$(fiche shell-init --wrap)"
            fi
            """
            let sep = existing.isEmpty || existing.hasSuffix("\n") ? "" : "\n"
            let updated = existing + sep + snippet.trimmingCharacters(in: .newlines) + "\n"
            do {
                try updated.write(to: zshrcURL, atomically: true, encoding: .utf8)
                await MainActor.run { [weak self] in
                    self?.isShellAutoWrapInstalled = true
                    self?.showTransientNotice("Added auto-wrap to ~/.zshrc — open a new terminal to activate")
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.lastError = "Failed to update ~/.zshrc: \(error.localizedDescription)"
                }
            }
        }
    }

    func launchDesktopAppViaFiche(_ appName: String) {
        guard !isPreview else { return }
        lastError = nil
        showTransientNotice("Launching \(appName) via Fiche…")
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
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        Darwin.chmod(url.path, 0o700)
        NSWorkspace.shared.open(url)
    }

    func openConfigFolder() {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config", isDirectory: true)
            .appendingPathComponent("fiche", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        Darwin.chmod(url.path, 0o700)
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
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        Darwin.chmod(url.path, 0o700)
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
            try fm.createDirectory(at: ficheHomeURL, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            Darwin.chmod(ficheHomeURL.path, 0o700)
        } catch {
            return .failure(SpawnFailure(message: "Failed to create ~/.fiche: \(error.localizedDescription)"))
        }

        let outFd = Darwin.open(outLogURL.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        let errFd = Darwin.open(errLogURL.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        if outFd >= 0 { Darwin.fchmod(outFd, 0o600) }
        if errFd >= 0 { Darwin.fchmod(errFd, 0o600) }
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

    nonisolated private static func isFicheProcess(pid: Int) -> Bool {
        guard pid > 1 else { return false }
        var buf = [CChar](repeating: 0, count: 4096)
        let len = cProcPidPath(Int32(pid), &buf, UInt32(buf.count))
        guard len > 0 else { return false }
        let path = String(decoding: buf.prefix(Int(len)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
        let name = URL(fileURLWithPath: path).lastPathComponent.lowercased()
        return name == "node" || name == "fiche"
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

        let group = DispatchGroup()
        nonisolated(unsafe) var outData = Data()
        nonisolated(unsafe) var errData = Data()

        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            outData = outPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }

        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }

        let timedOut = group.wait(timeout: .now() + 15) == .timedOut
        if timedOut {
            if process.isRunning {
                process.terminate()
            }
            _ = group.wait(timeout: .now() + 1)
            return CommandOutput(
                exitCode: 124,
                stdout: String(data: outData, encoding: .utf8) ?? "",
                stderr: "Subprocess timed out after 15s."
            )
        }

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
