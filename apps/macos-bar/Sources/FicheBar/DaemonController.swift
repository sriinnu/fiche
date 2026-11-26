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
    case timedOut(String)
    case unreachable(String)
}

private enum PollOutcome: Sendable {
    case reachable
    case offline
    case superseded
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

private final class LockedDataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func set(_ next: Data) {
        lock.lock()
        data = next
        lock.unlock()
    }

    func appendBounded(_ chunk: Data, maxBytes: Int) {
        guard !chunk.isEmpty else { return }
        lock.lock()
        data.append(chunk)
        if data.count > maxBytes {
            data = Data(data.suffix(maxBytes))
        }
        lock.unlock()
    }

    func snapshot() -> Data {
        lock.lock()
        let copy = data
        lock.unlock()
        return copy
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
            consecutivePollTimeouts = 0
            pollGeneration &+= 1
            inFlightPoll?.task.cancel()
            inFlightPoll = nil
            Task { [weak self] in
                await self?.pollOnce(forceRefresh: true)
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

    // Preserved Popover UI state across close/reopen
    @Published var selectedTab: PopoverTab = .activity
    @Published var heroScope: HeroScope = .lifetime
    @Published var dailyMetric: DailyChartMetric = .tokens

    // Live daemon state
    @Published private(set) var phase: DaemonPhase = .stopped
    @Published private(set) var health: HealthResponse?
    @Published private(set) var stats: ProxyStatsResponse?
    @Published private(set) var lastTurn: LastTurnResponse?
    @Published private(set) var mmuStats: MmuStatsResponse?
    @Published private(set) var calibratedProfiles: [CalibratedModelProfile] = []
    @Published private(set) var allowedModels: [String] = []
    @Published private(set) var modelCatalog: [ModelCatalogItem] = ModelCatalogItem.curatedDefaults
    @Published private(set) var providers: [ProviderDescriptor] = ProviderDescriptor.fallbackDefaults
    @Published private(set) var plugins: [PluginDescriptor] = []
    @Published private(set) var pluginsDir: String?
    @Published private(set) var isLoginAgentInstalled: Bool = false
    @Published private(set) var isShellAutoWrapInstalled: Bool = false
    @Published private(set) var shellRCDisplayName: String = "~/.zshrc"
    @Published private(set) var unsupportedShellName: String? = nil
    @Published private(set) var discoveredDesktopApps: [DiscoveredDesktopApp] = []
    @Published private(set) var discoveredCLIAgents: [DiscoveredCLIAgent] = []
    @Published private(set) var hasCompletedAgentDiscovery: Bool = false
    @Published private(set) var hasKoshaCLI: Bool = false
    @Published private(set) var hasKoshaRegistry: Bool = false
    @Published private(set) var koshaRegistryUpdatedAt: Date? = nil
    @Published private(set) var isSyncingKosha: Bool = false
    @Published private(set) var koshaSyncStage: String? = nil
    @Published private(set) var lastKoshaSyncSummary: String? = nil
    @Published private(set) var transientNotice: String? = nil
    @Published private(set) var isBusy: Bool = false
    @Published private(set) var daemonError: String?
    @Published private(set) var actionError: String?
    @Published private(set) var lastUpdatedAt: Date?
    @Published private(set) var spawnedPid: Int32?
    @Published private(set) var pluginsEndpointSupported: Bool = true

    var lastError: String? {
        actionError ?? daemonError
    }

    var isOnline: Bool {
        phase == .live || phase == .paused
    }

    func dismissActionError() {
        actionError = nil
    }

    private let isPreview: Bool
    private let session: URLSession
    private let pollBox = TaskCancellationBox()
    private var inFlightPoll: (port: Int, generation: Int, task: Task<PollOutcome, Never>)?
    private var mutationChain: Task<Void, Never>?
    private var hasPerformedStartupCheck = false
    private var noticeGeneration: Int = 0
    private var pollGeneration: Int = 0
    private var consecutivePollTimeouts: Int = 0
    private var discoveryGeneration: Int = 0
    private var koshaGeneration: Int = 0
    private var isUpdatingShellAutoWrap: Bool = false

    private static let maxTransientTimeoutsBeforeOffline = 3

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
        config.timeoutIntervalForRequest = 5.0
        config.timeoutIntervalForResource = 10.0
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: config)

        startPolling()
        refreshAgentDiscovery()
        refreshKoshaStatus()
    }

    private init(previewTheme: ThemeID, initialTab: PopoverTab = .activity) {
        self.isPreview = true
        self.autoStartDaemon = true
        self.daemonPort = 47_821
        self.pollIntervalSeconds = 3.0
        self.themeID = previewTheme
        self.selectedTab = initialTab
        self.session = URLSession(configuration: .ephemeral)
        self.phase = .live
        self.isLoginAgentInstalled = true
        self.allowedModels = ["gemini-4-argon-high", "claude-fable-5", "gpt-6.2-astra", "claude-opus-5-5", "deepseek", "kimi", "glm", "grok"]
        self.providers = ProviderDescriptor.fallbackDefaults

        let decoder = JSONDecoder()
        let healthJSON = """
        {
          "ok": true,
          "name": "fiche",
          "version": "0.19.0",
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
              "compressed": 7,
              "imaged": 7,
              "text_compressed": 0,
              "baseline_input_weighted": 57220,
              "actual_input_weighted": 23340,
              "saved_tokens": 33880,
              "raw_saved_tokens": 82300,
              "saved_pct": 59.2,
              "saved_usd": 0.094,
              "cliff_avoided_events": 0,
              "cliff_saved_usd": 0
            },
            "claude-opus-5": {
              "requests": 4,
              "compressed": 4,
              "imaged": 0,
              "text_compressed": 4,
              "baseline_input_weighted": 31200,
              "actual_input_weighted": 12800,
              "saved_tokens": 18400,
              "raw_saved_tokens": 41200,
              "saved_pct": 59.0,
              "saved_usd": 0.048,
              "cliff_avoided_events": 0,
              "cliff_saved_usd": 0
            },
            "gemini-4-neon-high": {
              "requests": 3,
              "compressed": 0,
              "imaged": 0,
              "text_compressed": 0,
              "baseline_input_weighted": 0,
              "actual_input_weighted": 0,
              "saved_tokens": 0,
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
            PluginDescriptor(id: "lsm-context", name: "LSM-Context Hierarchy", description: "Multi-level LSM history compaction tiers for long-running sessions.", kind: .stage, source: "builtin", enabled: true, mutable: false),
            PluginDescriptor(id: "context-mmu", name: "Context-MMU Virtual Memory", description: "Virtual context paging, Markovian episode folding, and live-tail hydration.", kind: .stage, source: "builtin", enabled: true, mutable: false),
            PluginDescriptor(id: "skill-linker", name: "Session Skill Linker", description: "Turn-1 pinned skill catalog stubbing with Turn-N auto-hydration.", kind: .stage, source: "builtin", enabled: true, mutable: false),
            PluginDescriptor(id: "skill:fiche", name: "fiche", description: "Inspect token & dollar savings from the fiche context compiler.", kind: .skill, source: "skill", enabled: true, mutable: true),
            PluginDescriptor(id: "skill:azure-ai", name: "azure-ai", description: "External Azure AI skill extension.", kind: .skill, source: "skill", enabled: true, mutable: true),
            PluginDescriptor(id: "skill:baton-handover", name: "baton-handover", description: "External session baton handover extension.", kind: .skill, source: "skill", enabled: true, mutable: true),
            PluginDescriptor(id: "skill:code-mode", name: "code-mode", description: "External code-mode workflow extension.", kind: .skill, source: "skill", enabled: true, mutable: true),
            PluginDescriptor(id: "skill:tokmeter", name: "tokmeter", description: "External token meter inspection extension.", kind: .skill, source: "skill", enabled: true, mutable: true),
        ]
        self.isShellAutoWrapInstalled = true
        self.hasCompletedAgentDiscovery = true
        self.discoveredDesktopApps = [
            DiscoveredDesktopApp(id: "Antigravity", name: "Antigravity", displayName: "Antigravity", bundlePath: "/Applications/Antigravity.app", isElectron: true, attachmentState: .attached, attachedPIDs: [4101], directPIDs: []),
            DiscoveredDesktopApp(id: "Cursor", name: "Cursor", displayName: "Cursor", bundlePath: "/Applications/Cursor.app", isElectron: true, attachmentState: .runningDirect, attachedPIDs: [], directPIDs: [5210]),
            DiscoveredDesktopApp(id: "Claude", name: "Claude", displayName: "Claude", bundlePath: "/Applications/Claude.app", isElectron: true, attachmentState: .stopped, attachedPIDs: [], directPIDs: []),
        ]
        self.discoveredCLIAgents = [
            DiscoveredCLIAgent(id: "claude", name: "Claude Code", command: "claude", provider: "Anthropic", installed: true, binaryPath: "/Users/demo/.local/bin/claude", attachedCount: 1, directCount: 0),
            DiscoveredCLIAgent(id: "codex", name: "OpenAI Codex", command: "codex", provider: "OpenAI", installed: true, binaryPath: "/usr/local/bin/codex", attachedCount: 0, directCount: 1),
            DiscoveredCLIAgent(id: "agy", name: "Antigravity CLI", command: "agy", provider: "Google / Multi", installed: true, binaryPath: "/Users/demo/.local/bin/agy", attachedCount: 0, directCount: 0),
            DiscoveredCLIAgent(id: "gemini", name: "Gemini CLI", command: "gemini", provider: "Google", installed: true, binaryPath: "/Users/demo/.local/bin/gemini", attachedCount: 0, directCount: 0),
            DiscoveredCLIAgent(id: "opencode", name: "OpenCode", command: "opencode", provider: "Multi", installed: true, binaryPath: "/Users/demo/.opencode/bin/opencode", attachedCount: 0, directCount: 0),
            DiscoveredCLIAgent(id: "aider", name: "Aider", command: "aider", provider: "Multi", installed: false, binaryPath: nil, attachedCount: 0, directCount: 0),
        ]
        self.hasKoshaCLI = true
        self.hasKoshaRegistry = true
        self.koshaRegistryUpdatedAt = Date().addingTimeInterval(-1_800)
        self.lastKoshaSyncSummary = "Up to date · 8 active bases"
        self.mmuStats = MmuStatsResponse(
            stats: MmuStatsSnapshot(
                pagesStored: 16,
                pagesEvicted: 0,
                activePages: 16,
                activeBytes: 428_032,
                tailHydrations: 4,
                tailHydrationTokens: 1_552,
                markovFolds: 1,
                skillsStubbed: 12,
                densityPrunedBlocks: 1
            ),
            pageCount: 16,
            limits: MmuLimitsSnapshot(maxPages: 512, maxBytes: 16 * 1024 * 1024, persisted: false),
            prefixTape: PrefixTapeSnapshot(
                stage2Entries: 24,
                stage2Hits: 82,
                stage2Misses: 12,
                sealSessions: 2,
                totalSeals: 14,
                sealHits: 28,
                casiEntries: 18,
                casiHits: 31,
                casiMisses: 6
            )
        )
        self.calibratedProfiles = [
            CalibratedModelProfile(
                model: "gemini-4-argon",
                band: "spleen-5x8",
                cols: 312,
                maxHeightPx: 768,
                calibratedAtIso: "2026-11-25T10:00:00Z",
                source: "probe",
                overallScore: 0.99,
                passed: true
            ),
            CalibratedModelProfile(
                model: "gpt-6.2-sol",
                band: "jetbrains-mono-14",
                cols: 95,
                maxHeightPx: 512,
                calibratedAtIso: "2026-11-25T10:00:00Z",
                source: "probe",
                overallScore: 0.96,
                passed: true
            ),
        ]
    }

    static func previewSample(theme: ThemeID, tab: PopoverTab = .activity) -> DaemonController {
        DaemonController(previewTheme: theme, initialTab: tab)
    }

    deinit {
        pollBox.cancel()
        session.invalidateAndCancel()
    }

    // MARK: - Computed Properties

    func calibratedProfile(for modelId: String) -> CalibratedModelProfile? {
        let stripped = modelId
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: #"\[[^\]]*\]"#, with: "", options: .regularExpression)
        guard !stripped.isEmpty else { return nil }
        if let exact = calibratedProfiles.first(where: { $0.model.lowercased() == stripped }) {
            return exact
        }
        let base = stripped.split(separator: "/").last.map(String.init) ?? stripped
        return calibratedProfiles.first(where: {
            let p = $0.model.lowercased()
            let pBase = p.split(separator: "/").last.map(String.init) ?? p
            return pBase == base
        })
    }

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
        let liveById = Dictionary(modelCatalog.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var result: [ModelCatalogItem] = []
        var seen = Set<String>()

        func append(_ item: ModelCatalogItem) {
            guard !item.id.isEmpty, !seen.contains(item.id) else { return }
            seen.insert(item.id)
            result.append(item)
        }

        for item in ModelCatalogItem.curatedDefaults {
            if let live = liveById[item.id] {
                append(ModelCatalogItem(
                    id: item.id,
                    label: live.label.isEmpty ? item.label : live.label,
                    family: live.family.isEmpty ? item.family : live.family,
                    hint: live.hint ?? item.hint,
                    engineMode: live.engineMode ?? item.engineMode
                ))
            } else {
                append(item)
            }
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

        let outcome = await pollOnceOutcome()
        if outcome == .offline && autoStartDaemon {
            await startDaemon()
        }
    }

    @discardableResult
    func pollOnce(forceRefresh: Bool = false) async -> Bool {
        let outcome = await pollOnceOutcome(forceRefresh: forceRefresh)
        switch outcome {
        case .reachable:
            return true
        case .offline:
            return false
        case .superseded:
            if let current = inFlightPoll, current.port == daemonPort, !current.task.isCancelled {
                return await current.task.value == .reachable
            }
            return false
        }
    }

    private func pollOnceOutcome(forceRefresh: Bool = false) async -> PollOutcome {
        let targetPort = daemonPort
        if !forceRefresh,
           let active = inFlightPoll,
           active.port == targetPort,
           active.generation == pollGeneration,
           !active.task.isCancelled
        {
            return await active.task.value
        }

        if forceRefresh {
            pollGeneration &+= 1
            inFlightPoll?.task.cancel()
            inFlightPoll = nil
        }
        let gen = pollGeneration
        let task = Task<PollOutcome, Never> { [weak self] in
            guard let self else { return .offline }
            return await self.executePoll(generation: gen, targetPort: targetPort)
        }
        inFlightPoll = (port: targetPort, generation: gen, task: task)
        let outcome = await task.value
        if inFlightPoll?.generation == gen && inFlightPoll?.port == targetPort {
            inFlightPoll = nil
        }
        return outcome
    }

    private func executePoll(generation gen: Int, targetPort: Int) async -> PollOutcome {
        let loginInstalled = await Task.detached(priority: .utility) {
            await Self.checkLaunchAgentExists()
        }.value
        guard gen == pollGeneration, targetPort == daemonPort else { return .superseded }
        isLoginAgentInstalled = loginInstalled

        // Probe /api/health first; fall back to /proxy-stats if daemon predates /api/health
        let healthResult: HTTPResult<HealthResponse> = await getJSON(path: "/api/health")
        guard gen == pollGeneration, targetPort == daemonPort else { return .superseded }
        switch healthResult {
        case .ok(let h):
            consecutivePollTimeouts = 0
            health = h
            if let models = h.allowedModels {
                allowedModels = models
            }
            daemonError = nil
        case .httpError(let status, _) where status == 404:
            // Older daemon without /api/health — check /proxy-stats below
            health = nil
        case .httpError(let status, let body):
            consecutivePollTimeouts = 0
            health = nil
            lastTurn = nil
            mmuStats = nil
            if phase != .starting {
                phase = .stopped
            }
            daemonError = "Daemon returned HTTP \(status): \(body)"
            return .offline
        case .timedOut:
            consecutivePollTimeouts += 1
            if (phase == .live || phase == .paused) && consecutivePollTimeouts < Self.maxTransientTimeoutsBeforeOffline {
                return .reachable
            }
            health = nil
            stats = nil
            lastTurn = nil
            mmuStats = nil
            if phase != .starting {
                phase = .stopped
            }
            return .offline
        case .unreachable:
            consecutivePollTimeouts = 0
            health = nil
            stats = nil
            lastTurn = nil
            mmuStats = nil
            if phase != .starting {
                phase = .stopped
            }
            return .offline
        }

        async let statsFetch: HTTPResult<ProxyStatsResponse> = getJSON(path: "/proxy-stats")
        async let turnFetch: HTTPResult<LastTurnResponse> = getJSON(path: "/api/last-turn.json")
        async let modelsFetch: HTTPResult<ModelsResponse> = getJSON(path: "/api/models")
        async let providersFetch: HTTPResult<ProvidersResponse> = getJSON(path: "/api/providers")
        async let pluginsFetch: HTTPResult<PluginsResponse> = getJSON(path: "/api/plugins")
        async let mmuFetch: HTTPResult<MmuStatsResponse> = getJSON(path: "/api/mmu/stats")
        async let calibrationFetch: HTTPResult<CalibrationResponse> = getJSON(path: "/api/calibration")

        let (statsRes, turnRes, modelsRes, providersRes, pluginsRes, mmuRes, calibrationRes) = await (
            statsFetch,
            turnFetch,
            modelsFetch,
            providersFetch,
            pluginsFetch,
            mmuFetch,
            calibrationFetch
        )
        guard gen == pollGeneration, targetPort == daemonPort else { return .superseded }

        var anyReachable = health != nil

        switch statsRes {
        case .ok(let s):
            stats = s
            anyReachable = true
            if let models = s.allowedModels {
                allowedModels = models
            }
        case .httpError, .timedOut, .unreachable:
            break
        }

        if !anyReachable {
            if case .timedOut = statsRes,
               (phase == .live || phase == .paused),
               consecutivePollTimeouts + 1 < Self.maxTransientTimeoutsBeforeOffline
            {
                consecutivePollTimeouts += 1
                return .reachable
            }
            consecutivePollTimeouts = 0
            lastTurn = nil
            mmuStats = nil
            if phase != .starting {
                phase = .stopped
            }
            return .offline
        }
        consecutivePollTimeouts = 0

        if case .ok(let t) = turnRes {
            lastTurn = t
        }

        if case .ok(let m) = modelsRes {
            allowedModels = m.allowedModels
            if !m.catalog.isEmpty {
                modelCatalog = m.catalog
            }
        }

        if case .ok(let p) = providersRes, !p.providers.isEmpty {
            providers = p.providers
        } else if let enabledIDs = health?.enabledProviders {
            let enabledSet = Set(enabledIDs)
            providers = providers.map { item in
                var copy = item
                copy.enabled = enabledSet.contains(item.id)
                return copy
            }
        }

        switch pluginsRes {
        case .ok(let p):
            pluginsEndpointSupported = true
            plugins = p.items
            pluginsDir = p.pluginsDir
        case .httpError(let status, _) where status == 404:
            pluginsEndpointSupported = false
        case .httpError, .timedOut, .unreachable:
            break
        }

        if case .ok(let mmu) = mmuRes {
            mmuStats = mmu
        } else if case .httpError(let status, _) = mmuRes, status == 404 {
            mmuStats = nil
        }

        if case .ok(let cal) = calibrationRes {
            calibratedProfiles = cal.profiles
        } else if case .httpError(let status, _) = calibrationRes, status == 404 {
            calibratedProfiles = []
        }

        let enabled = health?.compressionEnabled ?? stats?.compressionEnabled ?? true
        phase = enabled ? .live : .paused
        lastUpdatedAt = Date()
        daemonError = nil
        return .reachable
    }

    // MARK: - Daemon Start / Stop / Restart

    func startDaemon() async {
        guard !isBusy else { return }
        isBusy = true
        phase = .starting
        daemonError = nil

        defer { isBusy = false }

        if await isDaemonReachable() {
            await pollOnce(forceRefresh: true)
            return
        }

        let port = daemonPort
        let (hasPlist, loginInstalled, agentPort) = await Task.detached(priority: .utility) {
            (Self.hasLaunchAgentPlist(), await Self.checkLaunchAgentExists(), Self.installedLaunchAgentPort())
        }.value
        isLoginAgentInstalled = loginInstalled

        if hasPlist && agentPort == port {
            let launchErr = await Self.kickstartLaunchAgent()
            if let launchErr {
                daemonError = launchErr
                phase = .stopped
                return
            }
        } else {
            let spawnResult = await Task.detached(priority: .userInitiated) {
                await Self.spawnDetachedDaemon(port: port)
            }.value

            switch spawnResult {
            case .success(let pid):
                spawnedPid = pid
            case .failure(let err):
                daemonError = err.message
                phase = .stopped
                return
            }
        }

        // Wait up to 4 seconds for /api/health or /proxy-stats to accept connections
        for _ in 0..<16 {
            try? await Task.sleep(for: .milliseconds(250))
            if await isDaemonReachable() {
                await pollOnce(forceRefresh: true)
                return
            }
        }

        let tailErr = await Task.detached(priority: .utility) {
            Self.readErrLogTail()
        }.value
        if let tailErr, !tailErr.isEmpty {
            daemonError = "Daemon failed to become ready on :\(daemonPort) — \(tailErr)"
        } else {
            daemonError = "Timed out waiting for daemon on 127.0.0.1:\(daemonPort)."
        }
        phase = .stopped
    }

    func stopDaemon() async {
        guard !isBusy else { return }
        isBusy = true
        daemonError = nil

        defer { isBusy = false }

        let knownPid = daemonPid
        let port = daemonPort
        let (hasPlist, loginInstalled, agentPort) = await Task.detached(priority: .utility) {
            (Self.hasLaunchAgentPlist(), await Self.checkLaunchAgentExists(), Self.installedLaunchAgentPort())
        }.value
        isLoginAgentInstalled = loginInstalled
        let useLaunchAgent = hasPlist && agentPort == port

        if useLaunchAgent {
            // Bootout LaunchAgent BEFORE any HTTP/reachability probe so launchd socket
            // activation cannot respawn the daemon mid-shutdown.
            let bootoutRes = await Self.bootoutLaunchAgent()

            for _ in 0..<12 {
                try? await Task.sleep(for: .milliseconds(150))
                let stillActive = await Task.detached(priority: .utility) {
                    let loaded = await Self.isLaunchAgentLoaded()
                    let pidAlive = knownPid.map { Self.isLiveFicheProcess(pid: $0) } ?? false
                    return loaded || pidAlive
                }.value
                if !stillActive {
                    break
                }
            }

            let stillRunning = await Task.detached(priority: .utility) {
                let loaded = await Self.isLaunchAgentLoaded()
                let pidAlive = knownPid.map { Self.isLiveFicheProcess(pid: $0) } ?? false
                return (loaded, pidAlive)
            }.value

            if stillRunning.0 || stillRunning.1 {
                if !stillRunning.0 {
                    _ = await postEmpty(path: "/api/shutdown")
                    if let pid = knownPid {
                        let isFiche = await Task.detached(priority: .utility) {
                            Self.isLiveFicheProcess(pid: pid)
                        }.value
                        if isFiche {
                            Darwin.kill(pid_t(pid), SIGTERM)
                            try? await Task.sleep(for: .milliseconds(250))
                        }
                    }
                } else if bootoutRes.exitCode != 0 {
                    daemonError = bootoutRes.stderr.isEmpty
                        ? "launchctl bootout failed (exit \(bootoutRes.exitCode))"
                        : bootoutRes.stderr
                }
            }
        } else {
            let shutdownRes: HTTPResult<Data> = await postEmpty(path: "/api/shutdown")
            var needTerm = false
            switch shutdownRes {
            case .ok:
                needTerm = false
            case .httpError(let status, _) where status == 404:
                needTerm = true
            case .httpError, .unreachable, .timedOut:
                needTerm = true
            }

            if needTerm, let pid = knownPid {
                let isFiche = await Task.detached(priority: .utility) {
                    Self.isLiveFicheProcess(pid: pid)
                }.value
                if isFiche {
                    Darwin.kill(pid_t(pid), SIGTERM)
                }
            }

            for _ in 0..<12 {
                try? await Task.sleep(for: .milliseconds(150))
                if let pid = knownPid {
                    let alive = await Task.detached(priority: .utility) {
                        Self.isLiveFicheProcess(pid: pid)
                    }.value
                    if !alive { break }
                } else if !(await isDaemonReachable()) {
                    break
                }
            }

            if let pid = knownPid {
                let stillAlive = await Task.detached(priority: .utility) {
                    Self.isLiveFicheProcess(pid: pid)
                }.value
                if stillAlive {
                    Darwin.kill(pid_t(pid), SIGTERM)
                    try? await Task.sleep(for: .milliseconds(250))
                }
            }
        }

        health = nil
        stats = nil
        lastTurn = nil
        mmuStats = nil
        spawnedPid = nil
        consecutivePollTimeouts = 0
        isLoginAgentInstalled = await Task.detached(priority: .utility) {
            await Self.checkLaunchAgentExists()
        }.value
        phase = .stopped
    }

    func restartDaemon() async {
        guard !isBusy else { return }
        let oldPid = daemonPid
        let port = daemonPort
        let (hasPlist, loginInstalled, agentPort) = await Task.detached(priority: .utility) {
            (Self.hasLaunchAgentPlist(), await Self.checkLaunchAgentExists(), Self.installedLaunchAgentPort())
        }.value
        isLoginAgentInstalled = loginInstalled

        if hasPlist && agentPort == port {
            isBusy = true
            phase = .starting
            daemonError = nil
            actionError = nil
            defer { isBusy = false }

            if let launchErr = await Self.kickstartLaunchAgent() {
                actionError = launchErr
                await pollOnce(forceRefresh: true)
                return
            }
            var observedPidChange = (oldPid == nil)
            for _ in 0..<16 {
                try? await Task.sleep(for: .milliseconds(250))
                let healthRes: HTTPResult<HealthResponse> = await getJSON(path: "/api/health")
                switch healthRes {
                case .ok(let h):
                    if let oldPid {
                        if let newPid = h.pid, newPid != oldPid {
                            observedPidChange = true
                        }
                    } else {
                        observedPidChange = true
                    }
                    if observedPidChange {
                        await pollOnce(forceRefresh: true)
                        return
                    }
                case .httpError(let status, _) where status == 404:
                    if await isDaemonReachable() {
                        await pollOnce(forceRefresh: true)
                        return
                    }
                case .httpError, .timedOut, .unreachable:
                    break
                }
            }
            if let oldPid, !observedPidChange {
                actionError = "Daemon restart did not replace process (pid \(oldPid))."
            } else {
                daemonError = "Daemon restart timed out on :\(daemonPort)."
            }
            await pollOnce(forceRefresh: true)
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

    private func enqueueMutation(_ operation: @escaping @MainActor () async -> Void) async {
        let previous = mutationChain
        let next = Task { @MainActor in
            _ = await previous?.value
            await operation()
        }
        mutationChain = next
        await next.value
    }

    func toggleCompression() {
        let nextEnabled = !compressionEnabled
        Task { [weak self] in
            await self?.setCompression(enabled: nextEnabled)
        }
    }

    func setCompression(enabled: Bool) async {
        await enqueueMutation { [weak self] in
            guard let self else { return }
            self.pollGeneration &+= 1
            self.actionError = nil
            struct Body: Encodable { let enabled: Bool }
            let res: HTTPResult<CompressionToggleResponse> = await self.postJSON(path: "/api/compression", body: Body(enabled: enabled))
            switch res {
            case .ok(let payload):
                self.consecutivePollTimeouts = 0
                self.phase = payload.compressionEnabled ? .live : .paused
                self.daemonError = nil
                self.actionError = nil
                await self.pollOnce(forceRefresh: true)
            case .httpError(let status, let msg):
                self.actionError = "Compression toggle failed (\(status)): \(msg)"
            case .timedOut(let reason):
                self.consecutivePollTimeouts += 1
                if (self.phase == .live || self.phase == .paused) && self.consecutivePollTimeouts < Self.maxTransientTimeoutsBeforeOffline {
                    self.actionError = "Compression toggle timed out (\(self.consecutivePollTimeouts)/\(Self.maxTransientTimeoutsBeforeOffline)): \(reason)"
                    self.showTransientNotice("Request timed out — daemon still busy")
                } else {
                    self.consecutivePollTimeouts = 0
                    self.health = nil
                    self.stats = nil
                    self.lastTurn = nil
                    self.mmuStats = nil
                    self.actionError = "Daemon unreachable: \(reason)"
                    self.phase = .stopped
                }
            case .unreachable(let reason):
                self.consecutivePollTimeouts = 0
                self.health = nil
                self.stats = nil
                self.lastTurn = nil
                self.mmuStats = nil
                self.actionError = "Daemon unreachable: \(reason)"
                self.phase = .stopped
            }
        }
    }

    func toggleProvider(id: String, on: Bool) {
        let wasEnabled = providers.first(where: { $0.id == id })?.enabled ?? !on
        providers = providers.map { item in
            guard item.id == id else { return item }
            var copy = item
            copy.enabled = on
            return copy
        }
        guard !isPreview else { return }
        Task { [weak self] in
            await self?.setProvider(id: id, on: on, previousEnabled: wasEnabled)
        }
    }

    private func setProvider(id: String, on: Bool, previousEnabled: Bool) async {
        await enqueueMutation { [weak self] in
            guard let self else { return }
            self.pollGeneration &+= 1
            self.actionError = nil
            struct ProviderToggleBody: Encodable {
                let provider: String
                let on: Bool
            }
            let res: HTTPResult<ProvidersResponse> = await self.postJSON(
                path: "/api/providers",
                body: ProviderToggleBody(provider: id, on: on)
            )
            switch res {
            case .ok(let payload):
                if !payload.providers.isEmpty {
                    self.providers = payload.providers
                }
                self.actionError = nil
                await self.pollOnce(forceRefresh: true)
            case .httpError(let status, let msg):
                self.providers = self.providers.map { item in
                    guard item.id == id else { return item }
                    var copy = item
                    copy.enabled = previousEnabled
                    return copy
                }
                self.actionError = "Provider update failed (\(status)): \(msg)"
                self.showTransientNotice("Reverted provider update (HTTP \(status))")
                await self.pollOnce(forceRefresh: true)
            case .timedOut(let reason), .unreachable(let reason):
                self.providers = self.providers.map { item in
                    guard item.id == id else { return item }
                    var copy = item
                    copy.enabled = previousEnabled
                    return copy
                }
                self.actionError = "Daemon unreachable: \(reason)"
                self.showTransientNotice("Reverted provider update — daemon unreachable")
            }
        }
    }

    func setProviders(_ ids: [String]) async {
        guard !isPreview else { return }
        await enqueueMutation { [weak self] in
            guard let self else { return }
            self.pollGeneration &+= 1
            self.actionError = nil
            struct ProvidersListBody: Encodable { let providers: [String] }
            let res: HTTPResult<ProvidersResponse> = await self.postJSON(
                path: "/api/providers",
                body: ProvidersListBody(providers: ids)
            )
            switch res {
            case .ok(let payload):
                if !payload.providers.isEmpty {
                    self.providers = payload.providers
                }
                self.actionError = nil
                await self.pollOnce(forceRefresh: true)
            case .httpError(let status, let msg):
                self.actionError = "Provider scope update failed (\(status)): \(msg)"
                await self.pollOnce(forceRefresh: true)
            case .timedOut(let reason), .unreachable(let reason):
                self.actionError = "Daemon unreachable: \(reason)"
                self.showTransientNotice("Provider scope update failed — daemon unreachable")
            }
        }
    }

    func toggleModel(model: String, on: Bool) {
        let wasAllowed = allowedModels.contains(model)
        var nextSet = Set(allowedModels)
        if on { nextSet.insert(model) } else { nextSet.remove(model) }
        allowedModels = Array(nextSet).sorted()
        guard !isPreview else { return }
        Task { [weak self] in
            await self?.setModel(model: model, on: on, wasAllowed: wasAllowed)
        }
    }

    private func setModel(model: String, on: Bool, wasAllowed: Bool) async {
        await enqueueMutation { [weak self] in
            guard let self else { return }
            self.pollGeneration &+= 1
            self.actionError = nil
            struct ToggleBody: Encodable {
                let model: String
                let on: Bool
            }

            @MainActor func revertSingleModel() {
                var set = Set(self.allowedModels)
                if wasAllowed { set.insert(model) } else { set.remove(model) }
                self.allowedModels = Array(set).sorted()
            }

            let res: HTTPResult<ModelsResponse> = await self.postJSON(path: "/api/models", body: ToggleBody(model: model, on: on))
            switch res {
            case .ok(let payload):
                if !payload.allowedModels.isEmpty || on == false {
                    self.allowedModels = payload.allowedModels
                }
                self.actionError = nil
                await self.pollOnce(forceRefresh: true)
            case .httpError(let status, _) where status == 404:
                // Back-compat fallback for daemons with /fragments/models only
                let fallback: HTTPResult<Data> = await self.postJSONRaw(path: "/fragments/models", body: ToggleBody(model: model, on: on))
                switch fallback {
                case .ok:
                    self.actionError = nil
                    await self.pollOnce(forceRefresh: true)
                case .httpError(let fbStatus, let fbMsg):
                    revertSingleModel()
                    self.actionError = "Model update failed (\(fbStatus)): \(fbMsg)"
                    self.showTransientNotice("Reverted model update (HTTP \(fbStatus))")
                case .timedOut(let reason), .unreachable(let reason):
                    revertSingleModel()
                    self.actionError = "Daemon unreachable: \(reason)"
                    self.showTransientNotice("Reverted model update — daemon unreachable")
                }
            case .httpError(let status, let msg):
                revertSingleModel()
                self.actionError = "Model update failed (\(status)): \(msg)"
                self.showTransientNotice("Reverted model update (HTTP \(status))")
                await self.pollOnce(forceRefresh: true)
            case .timedOut(let reason), .unreachable(let reason):
                revertSingleModel()
                self.actionError = "Daemon unreachable: \(reason)"
                self.showTransientNotice("Reverted model update — daemon unreachable")
            }
        }
    }

    func setModels(_ models: [String], rollbackTo previousModels: [String]? = nil) async {
        guard !isPreview else { return }
        await enqueueMutation { [weak self] in
            guard let self else { return }
            self.pollGeneration &+= 1
            self.actionError = nil
            struct ListBody: Encodable { let models: [String] }
            let fallbackModels = previousModels ?? self.allowedModels
            let res: HTTPResult<ModelsResponse> = await self.postJSON(path: "/api/models", body: ListBody(models: models))
            switch res {
            case .ok(let payload):
                self.allowedModels = payload.allowedModels
                self.actionError = nil
                await self.pollOnce(forceRefresh: true)
            case .httpError(let status, let msg):
                self.allowedModels = fallbackModels
                self.actionError = "Model scope update failed (\(status)): \(msg)"
                self.showTransientNotice("Reverted model scope (HTTP \(status))")
            case .timedOut(let reason), .unreachable(let reason):
                self.allowedModels = fallbackModels
                self.actionError = "Daemon unreachable: \(reason)"
                self.showTransientNotice("Reverted model scope — daemon unreachable")
            }
        }
    }

    func refreshKoshaStatus() {
        guard !isPreview else { return }
        koshaGeneration &+= 1
        let gen = koshaGeneration
        Task.detached(priority: .utility) { [weak self] in
            let snapshot = await Self.inspectKoshaEnvironment()
            await MainActor.run { [weak self] in
                guard let self, self.koshaGeneration == gen else { return }
                self.hasKoshaCLI = snapshot.hasCLI
                self.hasKoshaRegistry = snapshot.hasRegistry
                self.koshaRegistryUpdatedAt = snapshot.updatedAt
            }
        }
    }

    nonisolated private static func extractJSONObjectData(from stdout: String) -> Data? {
        let trimmed = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if let direct = trimmed.data(using: .utf8),
           (try? JSONSerialization.jsonObject(with: direct)) != nil
        {
            return direct
        }
        guard let firstBrace = trimmed.firstIndex(of: "{"),
              let lastBrace = trimmed.lastIndex(of: "}"),
              firstBrace <= lastBrace
        else {
            return nil
        }
        return String(trimmed[firstBrace...lastBrace]).data(using: .utf8)
    }

    func syncModelsFromKosha(updateFirst: Bool, allProviders: Bool, dryRun: Bool = false) async {
        guard !isPreview, !isSyncingKosha else { return }
        isSyncingKosha = true
        actionError = nil
        defer {
            isSyncingKosha = false
            koshaSyncStage = nil
        }

        if updateFirst && !dryRun {
            koshaSyncStage = "Running kosha update…"
            let updateRes = await Task.detached(priority: .userInitiated) { () -> CommandOutput in
                guard let koshaPath = await Self.resolveKoshaBinary() else {
                    return CommandOutput(
                        exitCode: 127,
                        stdout: "",
                        stderr: "Could not locate `kosha` binary on PATH or Homebrew."
                    )
                }
                let extraPrefix = (koshaPath as NSString).deletingLastPathComponent
                return await Self.runProcessAsync(
                    executable: koshaPath,
                    arguments: ["update"],
                    extraPathPrefix: extraPrefix,
                    timeoutSeconds: 30
                )
            }.value

            if updateRes.exitCode != 0 {
                let err = updateRes.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                let out = updateRes.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                actionError = !err.isEmpty
                    ? "kosha update failed: \(err)"
                    : (!out.isEmpty ? "kosha update failed: \(out)" : "`kosha update` exited with code \(updateRes.exitCode)")
                return
            }
        }

        if dryRun {
            koshaSyncStage = allProviders ? "Previewing all 21 providers…" : "Previewing Kosha sync…"
        } else {
            koshaSyncStage = allProviders ? "Syncing all 21 providers…" : "Syncing enabled providers…"
        }
        let port = daemonPort
        var args = ["models", "sync-kosha"]
        if !dryRun {
            args.append("--apply")
        }
        args.append("--json")
        if allProviders {
            args.append("--all-providers")
        }
        let syncArgs = args

        let syncRes = await Task.detached(priority: .userInitiated) {
            await Self.runFicheCommand(arguments: syncArgs, port: port, timeoutSeconds: 20)
        }.value

        let snap = await Task.detached(priority: .utility) {
            await Self.inspectKoshaEnvironment()
        }.value
        hasKoshaCLI = snap.hasCLI
        hasKoshaRegistry = snap.hasRegistry
        koshaRegistryUpdatedAt = snap.updatedAt

        guard syncRes.exitCode == 0 else {
            let err = syncRes.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            let out = syncRes.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            actionError = !err.isEmpty
                ? err
                : (!out.isEmpty ? out : "`fiche models sync-kosha` exited with code \(syncRes.exitCode)")
            return
        }

        guard let data = Self.extractJSONObjectData(from: syncRes.stdout),
              let decoded = try? JSONDecoder().decode(KoshaSyncResponse.self, from: data),
              decoded.ok
        else {
            actionError = "Unexpected output from `fiche models sync-kosha --json`."
            return
        }

        if dryRun {
            let previewSummary: String
            if decoded.added.isEmpty {
                previewSummary = "Dry-run: up to date · \(decoded.models.count) active bases"
            } else {
                let sample = decoded.added.prefix(3).joined(separator: ", ")
                let suffix = decoded.added.count > 3 ? "…" : ""
                previewSummary = "Dry-run: +\(decoded.added.count) new (\(sample)\(suffix))"
            }
            lastKoshaSyncSummary = previewSummary
            showTransientNotice(previewSummary)
            return
        }

        pollGeneration &+= 1
        allowedModels = decoded.models
        let delivery = decoded.synced ? " (live + config)" : (decoded.saved ? " (saved to config)" : "")
        let summary: String
        if decoded.added.isEmpty {
            summary = "Up to date · \(decoded.models.count) active bases"
        } else {
            summary = "+\(decoded.added.count) added · \(decoded.models.count) bases\(delivery)"
        }
        lastKoshaSyncSummary = summary

        if phase != .stopped && !decoded.synced {
            actionError = "Kosha models saved\(decoded.saved ? " to config" : ""), but live daemon sync on :\(daemonPort) failed. Restart daemon or retry."
            await pollOnce(forceRefresh: true)
            return
        }

        showTransientNotice(summary)
        if phase != .stopped {
            await pollOnce(forceRefresh: true)
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
        let previous = allowedModels
        let filtered = allowedModels.filter { !Self.isThirdPartyModel($0) }
        allowedModels = filtered
        guard !isPreview else { return }
        Task { [weak self] in
            await self?.setModels(filtered, rollbackTo: previous)
        }
    }

    func enableAllThirdPartyModels() {
        let previous = allowedModels
        var seen = Set(allowedModels)
        var merged = allowedModels
        for id in catalogThirdPartyModels where !seen.contains(id) {
            seen.insert(id)
            merged.append(id)
        }
        allowedModels = merged
        guard !isPreview else { return }
        Task { [weak self] in
            await self?.setModels(merged, rollbackTo: previous)
        }
    }

    func togglePlugin(id: String, enabled: Bool) {
        let wasEnabled = plugins.first(where: { $0.id == id })?.enabled ?? !enabled
        plugins = plugins.map { $0.id == id ? $0.withEnabled(enabled) : $0 }
        guard !isPreview else { return }
        Task { [weak self] in
            await self?.setPlugin(id: id, enabled: enabled, previousEnabled: wasEnabled)
        }
    }

    private static let builtInPluginIDs: Set<String> = [
        "optical-microfiche",
        "tscg-schema",
        "toon-structured",
        "acdc-epochs",
        "casi-delta",
        "lsm-context",
        "context-mmu",
        "skill-linker",
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
        let previous = plugins
        plugins = plugins.map { Self.isThirdPartyPlugin($0) ? $0.withEnabled(enabled) : $0 }
        guard !isPreview else { return }
        Task { [weak self] in
            await self?.postThirdPartyPlugins(enabled: enabled, rollbackTo: previous)
        }
    }

    private func postThirdPartyPlugins(enabled: Bool, rollbackTo previousPlugins: [PluginDescriptor]) async {
        await enqueueMutation { [weak self] in
            guard let self else { return }
            self.pollGeneration &+= 1
            self.actionError = nil
            struct ScopeBody: Encodable {
                let scope: String
                let enabled: Bool
            }

            let res: HTTPResult<Data> = await self.postJSONRaw(
                path: "/api/plugins",
                body: ScopeBody(scope: "third-party", enabled: enabled)
            )
            switch res {
            case .ok:
                self.actionError = nil
                await self.pollOnce(forceRefresh: true)
            case .httpError(let status, let msg):
                self.plugins = previousPlugins
                self.actionError = "3rd-party plugin update failed (\(status)): \(msg)"
                await self.pollOnce(forceRefresh: true)
            case .timedOut(let reason), .unreachable(let reason):
                self.plugins = previousPlugins
                self.actionError = "Daemon unreachable: \(reason)"
                self.showTransientNotice("Reverted plugin update — daemon unreachable")
            }
        }
    }

    nonisolated static let supportedCLICatalog: [(command: String, name: String, provider: String)] = [
        ("claude", "Claude Code", "Anthropic"),
        ("codex", "OpenAI Codex", "OpenAI"),
        ("ribhu", "Ribhu", "Multi"),
        ("kimi", "Kimi Code", "Kimi / Moonshot"),
        ("agy", "Antigravity CLI", "Google / Multi"),
        ("gemini", "Gemini CLI", "Google"),
        ("opencode", "OpenCode", "Multi"),
        ("cursor-agent", "Cursor Agent", "Multi"),
        ("amp", "Amp", "Multi"),
        ("pi", "Pi Agent", "Multi"),
        ("aider", "Aider", "Multi"),
    ]

    nonisolated private static let allowedCLICommands: Set<String> = Set(supportedCLICatalog.map(\.command))

    nonisolated static func isExecutableRegularFile(_ path: String) -> Bool {
        var isDir: ObjCBool = false
        let fm = FileManager.default
        return fm.fileExists(atPath: path, isDirectory: &isDir) && !isDir.boolValue && fm.isExecutableFile(atPath: path)
    }

    nonisolated private static func hasControlChars(_ s: String) -> Bool {
        s.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F }
    }

    private struct ProcessEntry {
        let pid: Int
        let ppid: Int
        let args: String
        let tokens: [String]
    }

    nonisolated private static let runtimeValueFlags: Set<String> = [
        "-r", "--require", "--import", "--loader", "--experimental-loader",
        "--env-file", "--env-file-if-exists", "-C", "--conditions",
        "--max-old-space-size", "--inspect", "--inspect-brk", "--watch-path",
        "--tsconfig", "--preload", "--smol",
    ]

    nonisolated private static func resolveRuntimeScriptInfo(tokens: [String]) -> (index: Int, token: String)? {
        var i = 1
        while i < tokens.count {
            let tok = tokens[i]
            if tok == "-e" || tok == "--eval" || tok == "-p" || tok == "--print" {
                return nil
            }
            if tok == "--" {
                return i + 1 < tokens.count ? (i + 1, tokens[i + 1]) : nil
            }
            if tok.hasPrefix("-") {
                if !tok.contains("=") && runtimeValueFlags.contains(tok) {
                    i += 2
                } else {
                    i += 1
                }
                continue
            }
            return (i, tok)
        }
        return nil
    }

    nonisolated private static func processArgvViaSysctl(pid: Int32, argmax: Int) -> [String]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = argmax
        var buf = [UInt8](repeating: 0, count: size)
        let rc = buf.withUnsafeMutableBytes { ptr in
            Darwin.sysctl(&mib, 3, ptr.baseAddress, &size, nil, 0)
        }
        guard rc == 0, size >= MemoryLayout<Int32>.size else { return nil }
        let argc = buf.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
        guard argc > 0, argc < 16_384 else { return nil }

        var idx = MemoryLayout<Int32>.size
        while idx < size && buf[idx] != 0 {
            idx += 1
        }
        while idx < size && buf[idx] == 0 {
            idx += 1
        }

        var tokens: [String] = []
        tokens.reserveCapacity(Int(argc))
        for _ in 0..<Int(argc) {
            guard idx < size else { break }
            let start = idx
            while idx < size && buf[idx] != 0 {
                idx += 1
            }
            tokens.append(String(decoding: buf[start..<idx], as: UTF8.self))
            idx += 1
        }
        return tokens.isEmpty ? nil : tokens
    }

    nonisolated private static func listRunningProcessesViaSysctl() -> [ProcessEntry]? {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
        var byteCount: Int = 0
        guard Darwin.sysctl(&mib, 4, nil, &byteCount, nil, 0) == 0, byteCount > 0 else {
            return nil
        }

        let stride = MemoryLayout<kinfo_proc>.stride
        let paddedCount = (byteCount / stride) + max(32, (byteCount / stride) / 4)
        var procs = [kinfo_proc](repeating: kinfo_proc(), count: paddedCount)
        var actualBytes = paddedCount * stride
        let rc = procs.withUnsafeMutableBytes { ptr in
            Darwin.sysctl(&mib, 4, ptr.baseAddress, &actualBytes, nil, 0)
        }
        guard rc == 0, actualBytes > 0 else { return nil }

        var argmaxInt: Int32 = 262_144
        var argmaxSize = MemoryLayout<Int32>.size
        var argmaxMib: [Int32] = [CTL_KERN, KERN_ARGMAX]
        _ = Darwin.sysctl(&argmaxMib, 2, &argmaxInt, &argmaxSize, nil, 0)
        let argmax = max(65_536, min(Int(argmaxInt), 1_048_576))

        let count = actualBytes / stride
        var entries: [ProcessEntry] = []
        entries.reserveCapacity(count)

        for i in 0..<count {
            let kp = procs[i]
            let pid = kp.kp_proc.p_pid
            let ppid = kp.kp_eproc.e_ppid
            guard pid > 1 else { continue }
            guard let tokens = processArgvViaSysctl(pid: pid, argmax: argmax) else { continue }
            entries.append(ProcessEntry(
                pid: Int(pid),
                ppid: Int(ppid),
                args: tokens.joined(separator: " "),
                tokens: tokens
            ))
        }
        return entries
    }

    nonisolated private static func listRunningProcessesViaPS() async -> [ProcessEntry] {
        let out = await runProcessAsync(executable: "/bin/ps", arguments: ["-axo", "pid=,ppid=,args="])
        guard out.exitCode == 0 else { return [] }
        var entries: [ProcessEntry] = []
        for rawLine in out.stdout.split(whereSeparator: \.isNewline) {
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            let parts = trimmed.split(maxSplits: 2, omittingEmptySubsequences: true, whereSeparator: \.isWhitespace)
            guard parts.count == 3,
                  let pid = Int(parts[0]),
                  let ppid = Int(parts[1]) else { continue }
            let args = String(parts[2])
            let tokens = args.split(whereSeparator: \.isWhitespace).map(String.init)
            entries.append(ProcessEntry(pid: pid, ppid: ppid, args: args, tokens: tokens))
        }
        return entries
    }

    nonisolated private static func listRunningProcesses() async -> [ProcessEntry] {
        if let sysctlEntries = listRunningProcessesViaSysctl() {
            return sysctlEntries
        }
        return await listRunningProcessesViaPS()
    }

    nonisolated private static func findWarpSubcommandIndex(tokens: [String]) -> Int? {
        guard let t0 = tokens.first else { return nil }
        let base0 = URL(fileURLWithPath: t0).lastPathComponent
        if base0 == "fiche" {
            return tokens.dropFirst().firstIndex(of: "warp")
        }
        if base0 == "node" || base0 == "bun" || base0 == "deno" {
            if let script = resolveRuntimeScriptInfo(tokens: tokens) {
                let scriptBase = URL(fileURLWithPath: script.token).lastPathComponent
                if scriptBase == "fiche" || scriptBase == "cli.js" || scriptBase == "node.js",
                   script.index + 1 < tokens.count
                {
                    return tokens[(script.index + 1)...].firstIndex(of: "warp")
                }
            }
        }
        return nil
    }

    nonisolated private static func findWarpCLITarget(tokens: [String]) -> String? {
        guard let wIdx = findWarpSubcommandIndex(tokens: tokens) else { return nil }
        if let dashIdx = tokens[(wIdx + 1)...].firstIndex(of: "--"),
           dashIdx + 1 < tokens.count
        {
            return URL(fileURLWithPath: tokens[dashIdx + 1]).lastPathComponent
        }
        var i = wIdx + 1
        while i < tokens.count {
            let tok = tokens[i]
            if tok == "--app" || tok == "--route" || tok == "--providers" || tok == "--provider" {
                i += 2
                continue
            }
            if tok.hasPrefix("-") {
                i += 1
                continue
            }
            return URL(fileURLWithPath: tok).lastPathComponent
        }
        return nil
    }

    nonisolated private static func isWarpProcess(tokens: [String]) -> Bool {
        findWarpSubcommandIndex(tokens: tokens) != nil
    }

    nonisolated private static func discoverAgentState() async -> (
        apps: [DiscoveredDesktopApp],
        clis: [DiscoveredCLIAgent],
        shellRCName: String,
        unsupportedShell: String?,
        autoWrap: Bool,
        loginAgent: Bool
    ) {
        let candidates = [
            "Antigravity",
            "Antigravity IDE",
            "Cursor",
            "Claude",
            "Windsurf",
            "Visual Studio Code",
            "Visual Studio Code - Insiders",
            "Zed",
            "OpenCode",
            "ChatGPT",
            "Codex",
            "Runic",
        ]
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        let userApps = fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path

        let running = await listRunningProcesses()
        var ppidOf: [Int: Int] = [:]
        var warpPids = Set<Int>()
        var cliWarpAttachedCounts: [String: Int] = [:]

        for proc in running {
            ppidOf[proc.pid] = proc.ppid
            if isWarpProcess(tokens: proc.tokens) {
                warpPids.insert(proc.pid)
                if let cliTarget = findWarpCLITarget(tokens: proc.tokens), allowedCLICommands.contains(cliTarget) {
                    cliWarpAttachedCounts[cliTarget, default: 0] += 1
                }
            }
        }

        func hasWarpAncestor(_ pid: Int) -> Bool {
            var cur = ppidOf[pid] ?? 0
            var hops = 0
            while cur > 1 && hops < 16 {
                if warpPids.contains(cur) { return true }
                cur = ppidOf[cur] ?? 0
                hops += 1
            }
            return false
        }

        // Discover desktop apps and inspect live process attachment state.
        var apps: [DiscoveredDesktopApp] = []
        for name in candidates {
            let sysPath = "/Applications/\(name).app"
            let usrPath = "\(userApps)/\(name).app"
            let bundlePath: String
            if fm.fileExists(atPath: "\(sysPath)/Contents/Info.plist") {
                bundlePath = sysPath
            } else if fm.fileExists(atPath: "\(usrPath)/Contents/Info.plist") {
                bundlePath = usrPath
            } else {
                continue
            }

            let hasCodexFramework = fm.fileExists(atPath: "\(bundlePath)/Contents/Frameworks/Codex Framework.framework")
            let isElectron = fm.fileExists(atPath: "\(bundlePath)/Contents/Frameworks/Electron Framework.framework")
                || hasCodexFramework
                || fm.fileExists(atPath: "\(bundlePath)/Contents/Resources/app.asar")
                || fm.fileExists(atPath: "\(bundlePath)/Contents/Resources/app.asar.unpacked")
            let displayName = (name == "ChatGPT" && hasCodexFramework) ? "ChatGPT (Codex)" : name
            let mainPrefix = "\(bundlePath)/Contents/MacOS/"

            var attachedPIDs: [Int32] = []
            var noFlagPIDs: [Int32] = []
            var directPIDs: [Int32] = []

            for proc in running {
                guard let exeTok = proc.tokens.first else { continue }
                guard exeTok.hasPrefix(mainPrefix) || proc.args.hasPrefix(mainPrefix) else { continue }
                let hasProxyFlag = proc.tokens.contains {
                    $0.hasPrefix("--proxy-server=http://127.0.0.1:")
                        || $0.hasPrefix("--proxy-server=http://localhost:")
                } || proc.args.contains("--proxy-server=http://127.0.0.1:")
                    || proc.args.contains("--proxy-server=http://localhost:")
                if hasWarpAncestor(proc.pid) {
                    if isElectron && !hasProxyFlag {
                        noFlagPIDs.append(Int32(proc.pid))
                    } else {
                        attachedPIDs.append(Int32(proc.pid))
                    }
                } else {
                    directPIDs.append(Int32(proc.pid))
                }
            }

            let state: DesktopAppAttachmentState
            if !attachedPIDs.isEmpty {
                state = .attached
            } else if !noFlagPIDs.isEmpty {
                state = .launchedWithoutProxyFlag
            } else if !directPIDs.isEmpty {
                state = .runningDirect
            } else {
                state = .stopped
            }

            apps.append(DiscoveredDesktopApp(
                id: name,
                name: name,
                displayName: displayName,
                bundlePath: bundlePath,
                isElectron: isElectron,
                attachmentState: state,
                attachedPIDs: attachedPIDs,
                directPIDs: directPIDs
            ))
        }

        // Discover CLIs across PATH, standard shims, and Node version managers.
        var searchDirs: [String] = []
        if let envPath = ProcessInfo.processInfo.environment["PATH"] {
            searchDirs.append(contentsOf: envPath.split(separator: ":").map(String.init))
        }
        searchDirs.append(contentsOf: [
            "\(home)/.local/bin",
            "\(home)/.kimi-code/bin",
            "\(home)/.opencode/bin",
            "\(home)/.antigravity/antigravity/bin",
            "\(home)/.volta/bin",
            "\(home)/.local/share/mise/shims",
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
            "\(home)/.local/share/fnm/node-versions",
            "\(home)/Library/Application Support/fnm/node-versions",
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

        var cliDirectCounts: [String: Int] = [:]
        for proc in running where !warpPids.contains(proc.pid) && !hasWarpAncestor(proc.pid) {
            guard let t0 = proc.tokens.first else { continue }
            // Skip macOS GUI helpers, ps, osascript, and shells executing one-liners.
            if proc.args.contains("/Contents/Frameworks/") || proc.args.contains("/bin/ps ") { continue }
            let base0 = URL(fileURLWithPath: t0).lastPathComponent
            var matchedCmd: String?
            if allowedCLICommands.contains(base0) {
                matchedCmd = base0
            } else if base0 == "node" || base0 == "bun" || base0 == "deno" {
                if let script = resolveRuntimeScriptInfo(tokens: proc.tokens) {
                    let base1 = URL(fileURLWithPath: script.token).lastPathComponent
                    if allowedCLICommands.contains(base1) {
                        matchedCmd = base1
                    }
                }
            }
            if let cmd = matchedCmd {
                cliDirectCounts[cmd, default: 0] += 1
            }
        }

        let clis = supportedCLICatalog.map { entry in
            var foundPath: String?
            for dir in uniqueDirs {
                let candidate = "\(dir)/\(entry.command)"
                if isExecutableRegularFile(candidate) {
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
                binaryPath: foundPath,
                attachedCount: cliWarpAttachedCounts[entry.command, default: 0],
                directCount: cliDirectCounts[entry.command, default: 0]
            )
        }

        let rc = await resolveShellRCInfo()
        let autoWrap = rc.url.map { checkShellAutoWrapInstalled(at: $0) } ?? false
        let unsupportedShell: String? = {
            if case .unsupported(let name) = rc.kind { return name }
            return nil
        }()
        let loginAgent = await checkLaunchAgentExists()
        return (apps, clis, rc.displayName, unsupportedShell, autoWrap, loginAgent)
    }

    func refreshAgentDiscovery() {
        guard !isPreview else { return }
        discoveryGeneration &+= 1
        let gen = discoveryGeneration
        Task.detached(priority: .utility) { [weak self] in
            let snapshot = await Self.discoverAgentState()
            await MainActor.run { [weak self] in
                guard let self, self.discoveryGeneration == gen else { return }
                self.discoveredDesktopApps = snapshot.apps
                self.discoveredCLIAgents = snapshot.clis
                self.shellRCDisplayName = snapshot.shellRCName
                self.unsupportedShellName = snapshot.unsupportedShell
                if !self.isUpdatingShellAutoWrap {
                    self.isShellAutoWrapInstalled = snapshot.autoWrap
                }
                self.isLoginAgentInstalled = snapshot.loginAgent
                self.hasCompletedAgentDiscovery = true
            }
        }
    }

    @discardableResult
    func showTransientNotice(_ message: String) -> Int {
        noticeGeneration &+= 1
        let gen = noticeGeneration
        transientNotice = message
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(2_200))
            guard let self, self.noticeGeneration == gen else { return }
            self.transientNotice = nil
        }
        return gen
    }

    private func clearTransientNotice(ifGeneration gen: Int) {
        if noticeGeneration == gen {
            transientNotice = nil
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
            actionError = "Unsupported CLI agent: \(command)"
            return
        }
        guard !isPreview else { return }
        actionError = nil
        let targetCli = command
        let port = daemonPort
        let discoveredPath = discoveredCLIAgents.first(where: { $0.command == command })?.binaryPath
        Task.detached(priority: .userInitiated) { [weak self] in
            let nodePath = await Self.resolveNodeBinary()
            var prefixParts: [String] = []
            if let discoveredPath, !Self.hasControlChars(discoveredPath) {
                let binDir = (discoveredPath as NSString).deletingLastPathComponent
                if !binDir.isEmpty, binDir != "/usr/bin", binDir != "/bin" {
                    prefixParts.append("PATH=\(Self.shellSingleQuote(binDir)):\"$PATH\"")
                }
            }
            if port != 47_821 {
                prefixParts.append("FICHE_PORT=\(port)")
            }
            let prefix = prefixParts.isEmpty ? "" : prefixParts.joined(separator: " ") + " "

            let ficheInvocation: String
            if let exe = await Self.resolveFicheExecutable(nodePath: nodePath) {
                switch exe {
                case .binary(let bin):
                    if Self.hasControlChars(bin) {
                        ficheInvocation = "fiche warp -- \(targetCli)"
                    } else {
                        ficheInvocation = "\(Self.shellSingleQuote(bin)) warp -- \(targetCli)"
                    }
                case .nodeScript(let node, let script):
                    if Self.hasControlChars(node) || Self.hasControlChars(script) {
                        ficheInvocation = "fiche warp -- \(targetCli)"
                    } else {
                        ficheInvocation = "\(Self.shellSingleQuote(node)) \(Self.shellSingleQuote(script)) warp -- \(targetCli)"
                    }
                }
            } else {
                ficheInvocation = "fiche warp -- \(targetCli)"
            }
            let ficheCmd = prefix + ficheInvocation

            let script = """
            on run argv
                set cmd to item 1 of argv
                tell application "Terminal"
                    activate
                    do script cmd
                end tell
            end run
            """
            let res = await Self.runProcessAsync(
                executable: "/usr/bin/osascript",
                arguments: ["-e", script, ficheCmd],
                timeoutSeconds: 60
            )
            await MainActor.run { [weak self] in
                guard let self else { return }
                if res.exitCode != 0 {
                    let msg = res.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                    self.actionError = msg.isEmpty ? "Could not open Terminal for \(targetCli)." : msg
                } else {
                    self.showTransientNotice("Opening \(targetCli) via Fiche in Terminal…")
                }
            }
            if res.exitCode == 0 {
                try? await Task.sleep(for: .milliseconds(1_500))
                await MainActor.run { [weak self] in
                    self?.refreshAgentDiscovery()
                }
            }
        }
    }

    private enum DetectedShellKind: Sendable, Equatable {
        case zsh
        case bash
        case unsupported(String)
    }

    private struct ShellRCInfo: Sendable, Equatable {
        let kind: DetectedShellKind
        let url: URL?
        let displayName: String

        var isSupported: Bool {
            if case .unsupported = kind { return false }
            return true
        }
    }

    nonisolated private static func resolveShellRCInfo() async -> ShellRCInfo {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        let rawShell = ProcessInfo.processInfo.environment["SHELL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let shellPath = (rawShell?.isEmpty == false) ? rawShell! : "/bin/zsh"
        let shellName = URL(fileURLWithPath: shellPath).lastPathComponent.lowercased()

        if shellName == "bash" {
            let bashProfile = "\(home)/.bash_profile"
            let bashrc = "\(home)/.bashrc"
            let profileText = (try? Data(contentsOf: URL(fileURLWithPath: bashProfile)))
                .flatMap { String(data: $0, encoding: .utf8) ?? String(data: $0, encoding: .isoLatin1) }
            let bashrcText = (try? Data(contentsOf: URL(fileURLWithPath: bashrc)))
                .flatMap { String(data: $0, encoding: .utf8) ?? String(data: $0, encoding: .isoLatin1) }

            // On macOS, Terminal starts bash as a login shell (~/.bash_profile).
            // Only target ~/.bashrc if a legacy block already lives there (and not in ~/.bash_profile)
            // or if ~/.bash_profile explicitly sources .bashrc.
            if let bashrcText,
               hasAutoWrapRule(in: bashrcText),
               !(profileText.map { hasAutoWrapRule(in: $0) } ?? false)
            {
                return ShellRCInfo(kind: .bash, url: URL(fileURLWithPath: bashrc), displayName: "~/.bashrc")
            }
            if let profileText,
               fm.fileExists(atPath: bashrc),
               (profileText.contains(".bashrc") || profileText.contains("bashrc"))
            {
                return ShellRCInfo(kind: .bash, url: URL(fileURLWithPath: bashrc), displayName: "~/.bashrc")
            }
            return ShellRCInfo(kind: .bash, url: URL(fileURLWithPath: bashProfile), displayName: "~/.bash_profile")
        }

        if shellName == "zsh" || shellName.isEmpty {
            var rawZdot = ProcessInfo.processInfo.environment["ZDOTDIR"]?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if rawZdot?.isEmpty != false {
                let zshExe = isExecutableRegularFile(shellPath) ? shellPath : "/bin/zsh"
                let probe = await runProcessAsync(
                    executable: zshExe,
                    arguments: ["-lc", "printf %s \"$ZDOTDIR\""],
                    timeoutSeconds: 3
                )
                if probe.exitCode == 0 {
                    let probed = probe.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !probed.isEmpty {
                        rawZdot = probed
                    }
                }
            }
            if let zdot = rawZdot, !zdot.isEmpty {
                let expanded: String
                if zdot == "~" {
                    expanded = home
                } else if zdot.hasPrefix("~/") {
                    expanded = home + String(zdot.dropFirst())
                } else {
                    expanded = zdot
                }
                let cleanExpanded = expanded.hasSuffix("/") && expanded.count > 1
                    ? String(expanded.dropLast())
                    : expanded
                let cleanZdot = zdot.hasSuffix("/") && zdot.count > 1
                    ? String(zdot.dropLast())
                    : zdot
                let display = cleanExpanded == home ? "~/.zshrc" : "\(cleanZdot)/.zshrc"
                return ShellRCInfo(kind: .zsh, url: URL(fileURLWithPath: "\(cleanExpanded)/.zshrc"), displayName: display)
            }
            return ShellRCInfo(kind: .zsh, url: URL(fileURLWithPath: "\(home)/.zshrc"), displayName: "~/.zshrc")
        }

        return ShellRCInfo(kind: .unsupported(shellName), url: nil, displayName: shellName)
    }

    nonisolated private static func hasAutoWrapRule(in content: String) -> Bool {
        let pattern = #"^[ \t]*[^#\r\n]*\bfiche\b[^\r\n]*\bshell-init\b[^\r\n]*--wrap\b"#
        guard let re = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) else {
            return false
        }
        let range = NSRange(content.startIndex..<content.endIndex, in: content)
        return re.firstMatch(in: content, options: [], range: range) != nil
    }

    nonisolated static func checkShellAutoWrapInstalled(at url: URL) -> Bool {
        let rcURL = url.resolvingSymlinksInPath()
        guard let data = try? Data(contentsOf: rcURL) else { return false }
        let content = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) ?? ""
        return hasAutoWrapRule(in: content)
    }

    nonisolated private static func buildAutoWrapSnippet(port: Int) async -> String {
        let nodePath = await resolveNodeBinary()
        let exe = await resolveFicheExecutable(nodePath: nodePath)
        var lines: [String] = ["# >>> fiche auto-wrap >>>"]
        if port != 47_821 {
            lines.append("export FICHE_PORT=\(port)")
        }
        lines.append("if command -v fiche >/dev/null 2>&1; then")
        lines.append("  eval \"$(fiche shell-init --wrap)\"")
        if let exe {
            switch exe {
            case .binary(let bin) where !hasControlChars(bin):
                let binDir = (bin as NSString).deletingLastPathComponent
                let quotedBin = shellSingleQuote(bin)
                let quotedDir = shellSingleQuote(binDir)
                lines.append("elif [ -x \(quotedBin) ]; then")
                if !binDir.isEmpty {
                    lines.append("  export PATH=\(quotedDir):\"$PATH\"")
                }
                lines.append("  eval \"$(\(quotedBin) shell-init --wrap)\"")
            case .nodeScript(let node, let script) where !hasControlChars(node) && !hasControlChars(script):
                let quotedNode = shellSingleQuote(node)
                let quotedScript = shellSingleQuote(script)
                lines.append("elif [ -x \(quotedNode) ] && [ -f \(quotedScript) ]; then")
                lines.append("  eval \"$(\(quotedNode) \(quotedScript) shell-init --wrap)\"")
            default:
                break
            }
        }
        lines.append("elif [ -x \"$HOME/.local/bin/fiche\" ]; then")
        lines.append("  export PATH=\"$HOME/.local/bin:$PATH\"")
        lines.append("  eval \"$(fiche shell-init --wrap)\"")
        lines.append("fi")
        lines.append("# <<< fiche auto-wrap <<<")
        return lines.joined(separator: "\n")
    }

    nonisolated private static func removeAutoWrapBlock(from content: String) -> String {
        let pattern = #"[ \t]*# >>> fiche auto-wrap >>>[\s\S]*?# <<< fiche auto-wrap <<<[ \t]*\r?\n?"#
        guard let re = try? NSRegularExpression(pattern: pattern, options: []) else {
            return content
        }
        let fullRange = NSRange(content.startIndex..<content.endIndex, in: content)
        let matches = re.matches(in: content, options: [], range: fullRange)
        guard !matches.isEmpty else { return content }

        var result = content
        for match in matches.reversed() {
            guard let swiftRange = Range(match.range, in: result) else { continue }
            var spliceStart = swiftRange.lowerBound
            var spliceEnd = swiftRange.upperBound

            while spliceStart > result.startIndex {
                let prev = result.index(before: spliceStart)
                if result[prev] == "\n" || result[prev] == "\r" {
                    spliceStart = prev
                } else {
                    break
                }
            }
            while spliceEnd < result.endIndex {
                if result[spliceEnd] == "\n" || result[spliceEnd] == "\r" {
                    spliceEnd = result.index(after: spliceEnd)
                } else {
                    break
                }
            }

            let atStart = spliceStart == result.startIndex
            let atEnd = spliceEnd == result.endIndex
            let replacement: String
            if atStart && atEnd {
                replacement = ""
            } else if atStart {
                replacement = ""
            } else if atEnd {
                replacement = "\n"
            } else {
                replacement = "\n\n"
            }
            result.replaceSubrange(spliceStart..<spliceEnd, with: replacement)
        }

        if result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return ""
        }
        return result
    }

    func installShellAutoWrap() {
        guard !isPreview, !isUpdatingShellAutoWrap else { return }
        actionError = nil
        isUpdatingShellAutoWrap = true
        discoveryGeneration &+= 1
        let port = daemonPort
        Task.detached(priority: .userInitiated) { [weak self] in
            let fm = FileManager.default
            let rc = await Self.resolveShellRCInfo()
            guard rc.isSupported, let rawURL = rc.url else {
                await MainActor.run { [weak self] in
                    self?.shellRCDisplayName = rc.displayName
                    self?.unsupportedShellName = rc.displayName
                    self?.isShellAutoWrapInstalled = false
                    self?.isUpdatingShellAutoWrap = false
                    self?.actionError = "Auto-wrap only supports zsh and bash (detected \(rc.displayName)). Use `fiche warp -- <cli>` instead."
                }
                return
            }
            let targetURL = rawURL.resolvingSymlinksInPath()

            var existingData = Data()
            let fileExists = fm.fileExists(atPath: targetURL.path)
            if fileExists {
                do {
                    existingData = try Data(contentsOf: targetURL)
                } catch {
                    await MainActor.run { [weak self] in
                        self?.isUpdatingShellAutoWrap = false
                        self?.actionError = "Failed to read \(rc.displayName): \(error.localizedDescription)"
                    }
                    return
                }
                let decoded = String(data: existingData, encoding: .utf8)
                    ?? String(data: existingData, encoding: .isoLatin1)
                    ?? ""
                if Self.hasAutoWrapRule(in: decoded) {
                    await MainActor.run { [weak self] in
                        self?.shellRCDisplayName = rc.displayName
                        self?.unsupportedShellName = nil
                        self?.isShellAutoWrapInstalled = true
                        self?.isUpdatingShellAutoWrap = false
                        self?.showTransientNotice("Auto-wrap already enabled in \(rc.displayName)")
                    }
                    return
                }
            }

            let snippet = await Self.buildAutoWrapSnippet(port: port)
            let needsLeadingNewline = !existingData.isEmpty && existingData.last != 0x0A
            let appendString = (needsLeadingNewline ? "\n\n" : "\n") + snippet + "\n"
            guard let appendData = appendString.data(using: .utf8) else {
                await MainActor.run { [weak self] in
                    self?.isUpdatingShellAutoWrap = false
                }
                return
            }

            do {
                if !fileExists {
                    try fm.createDirectory(at: targetURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                }
                var nextData = existingData
                nextData.append(appendData)
                try nextData.write(to: targetURL, options: .atomic)
                await MainActor.run { [weak self] in
                    self?.shellRCDisplayName = rc.displayName
                    self?.unsupportedShellName = nil
                    self?.isShellAutoWrapInstalled = true
                    self?.isUpdatingShellAutoWrap = false
                    self?.showTransientNotice("Added auto-wrap to \(rc.displayName) — open a new terminal to activate")
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.isUpdatingShellAutoWrap = false
                    self?.actionError = "Failed to update \(rc.displayName): \(error.localizedDescription)"
                }
            }
        }
    }

    func uninstallShellAutoWrap() {
        guard !isPreview, !isUpdatingShellAutoWrap else { return }
        actionError = nil
        isUpdatingShellAutoWrap = true
        discoveryGeneration &+= 1
        Task.detached(priority: .userInitiated) { [weak self] in
            let fm = FileManager.default
            let rc = await Self.resolveShellRCInfo()
            guard rc.isSupported, let rawURL = rc.url else {
                await MainActor.run { [weak self] in
                    self?.isUpdatingShellAutoWrap = false
                    self?.isShellAutoWrapInstalled = false
                    self?.unsupportedShellName = rc.displayName
                }
                return
            }
            let targetURL = rawURL.resolvingSymlinksInPath()
            guard fm.fileExists(atPath: targetURL.path) else {
                await MainActor.run { [weak self] in
                    self?.shellRCDisplayName = rc.displayName
                    self?.isShellAutoWrapInstalled = false
                    self?.isUpdatingShellAutoWrap = false
                }
                return
            }

            do {
                let data = try Data(contentsOf: targetURL)
                let decoded = String(data: data, encoding: .utf8)
                    ?? String(data: data, encoding: .isoLatin1)
                    ?? ""
                let cleaned = Self.removeAutoWrapBlock(from: decoded)
                if cleaned != decoded, let outData = cleaned.data(using: .utf8) {
                    try outData.write(to: targetURL, options: .atomic)
                }
                let stillInstalled = Self.hasAutoWrapRule(in: cleaned)
                await MainActor.run { [weak self] in
                    self?.shellRCDisplayName = rc.displayName
                    self?.unsupportedShellName = nil
                    self?.isShellAutoWrapInstalled = stillInstalled
                    self?.isUpdatingShellAutoWrap = false
                    if stillInstalled {
                        self?.actionError = "Removed managed block, but a manual `fiche shell-init --wrap` line remains in \(rc.displayName)."
                    } else {
                        self?.showTransientNotice("Removed auto-wrap from \(rc.displayName)")
                    }
                }
            } catch {
                await MainActor.run { [weak self] in
                    self?.isUpdatingShellAutoWrap = false
                    self?.actionError = "Failed to update \(rc.displayName): \(error.localizedDescription)"
                }
            }
        }
    }

    private final class WeakControllerRef: @unchecked Sendable {
        weak var controller: DaemonController?
        init(_ controller: DaemonController?) {
            self.controller = controller
        }
    }

    private final class WarpStderrReaderState: @unchecked Sendable {
        var isClosed = false
        var buffer = Data()

        func appendBounded(_ chunk: Data, maxBytes: Int = 16_384) {
            guard !chunk.isEmpty else { return }
            buffer.append(chunk)
            if buffer.count > maxBytes {
                buffer = Data(buffer.suffix(maxBytes))
            }
        }
    }

    func launchDesktopAppViaFiche(_ appName: String) {
        guard !isPreview else { return }
        guard !Self.hasControlChars(appName) else {
            actionError = "Invalid desktop app name."
            return
        }
        actionError = nil
        let port = daemonPort
        let noticeGen = showTransientNotice("Launching \(appName) via Fiche…")
        let controllerRef = WeakControllerRef(self)
        Task.detached(priority: .userInitiated) {
            let nodePath = await Self.resolveNodeBinary()
            guard let exe = await Self.resolveFicheExecutable(nodePath: nodePath) else {
                await MainActor.run {
                    controllerRef.controller?.clearTransientNotice(ifGeneration: noticeGen)
                    controllerRef.controller?.actionError = "Could not locate fiche CLI to warp \(appName)."
                }
                return
            }

            var fds: [Int32] = [-1, -1]
            guard Darwin.pipe(&fds) == 0 else {
                await MainActor.run {
                    controllerRef.controller?.clearTransientNotice(ifGeneration: noticeGen)
                    controllerRef.controller?.actionError = "Failed to open stderr pipe for \(appName)."
                }
                return
            }
            let readFd = fds[0]
            let writeFd = fds[1]
            _ = Darwin.fcntl(readFd, F_SETFD, FD_CLOEXEC)
            _ = Darwin.fcntl(writeFd, F_SETFD, FD_CLOEXEC)
            let fl = Darwin.fcntl(readFd, F_GETFL, 0)
            if fl >= 0 {
                _ = Darwin.fcntl(readFd, F_SETFL, fl | O_NONBLOCK)
            }

            let writeHandle = FileHandle(fileDescriptor: writeFd, closeOnDealloc: true)
            let errQueue = DispatchQueue(label: "dev.srinivas.fichebar.warp-stderr.\(UUID().uuidString)")
            let errState = WarpStderrReaderState()
            let errSource = DispatchSource.makeReadSource(fileDescriptor: readFd, queue: errQueue)

            @Sendable func drainReadFd() {
                guard !errState.isClosed else { return }
                var chunk = [UInt8](repeating: 0, count: 4096)
                while true {
                    let n = Darwin.read(readFd, &chunk, chunk.count)
                    if n > 0 {
                        errState.appendBounded(Data(chunk[..<n]), maxBytes: 16_384)
                    } else if n == 0 {
                        errSource.cancel()
                        break
                    } else {
                        let code = errno
                        if code == EINTR { continue }
                        if code == EAGAIN || code == EWOULDBLOCK { break }
                        errSource.cancel()
                        break
                    }
                }
            }

            errSource.setEventHandler {
                drainReadFd()
            }
            errSource.setCancelHandler {
                if !errState.isClosed {
                    errState.isClosed = true
                    Darwin.close(readFd)
                }
            }
            errSource.resume()

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
            env["FICHE_PORT"] = String(port)
            env["PATH"] = Self.buildAugmentedPath(existing: env["PATH"], nodePath: nodePath)
            process.environment = env
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = FileHandle.nullDevice
            process.standardError = writeHandle
            let launchedAt = Date()

            process.terminationHandler = { proc in
                let status = proc.terminationStatus
                let elapsed = Date().timeIntervalSince(launchedAt)
                errQueue.async {
                    drainReadFd()
                    if !errState.isClosed {
                        errSource.cancel()
                    }
                    let errText = String(data: errState.buffer, encoding: .utf8)?
                        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let isQuickHandoffWarning = status == 0 && !errText.isEmpty
                        && (elapsed < 5.0 || errText.contains("[fiche] warp: warning:"))
                    Task { @MainActor in
                        guard let ctrl = controllerRef.controller else { return }
                        if status != 0 && elapsed < 5.0 {
                            ctrl.clearTransientNotice(ifGeneration: noticeGen)
                            ctrl.actionError = errText.isEmpty
                                ? "Failed to launch \(appName) via Fiche (exit \(status))."
                                : errText
                        } else if isQuickHandoffWarning {
                            ctrl.clearTransientNotice(ifGeneration: noticeGen)
                            ctrl.actionError = errText
                        }
                        ctrl.refreshAgentDiscovery()
                    }
                }
            }

            do {
                try process.run()
                try? writeHandle.close()
                try? await Task.sleep(for: .milliseconds(1_200))
                await MainActor.run {
                    controllerRef.controller?.refreshAgentDiscovery()
                }
            } catch {
                try? writeHandle.close()
                errQueue.async {
                    if !errState.isClosed {
                        errSource.cancel()
                    }
                }
                await MainActor.run {
                    controllerRef.controller?.clearTransientNotice(ifGeneration: noticeGen)
                    controllerRef.controller?.actionError = "Failed to launch \(appName): \(error.localizedDescription)"
                }
            }
        }
    }

    private func setPlugin(id: String, enabled: Bool, previousEnabled: Bool) async {
        await enqueueMutation { [weak self] in
            guard let self else { return }
            self.pollGeneration &+= 1
            self.actionError = nil
            struct PluginBody: Encodable {
                let id: String
                let enabled: Bool
            }

            @MainActor func revertSinglePlugin() {
                self.plugins = self.plugins.map { $0.id == id ? $0.withEnabled(previousEnabled) : $0 }
            }

            let res: HTTPResult<Data> = await self.postJSONRaw(path: "/api/plugins", body: PluginBody(id: id, enabled: enabled))
            switch res {
            case .ok:
                self.actionError = nil
                await self.pollOnce(forceRefresh: true)
            case .httpError(let status, let msg):
                revertSinglePlugin()
                self.actionError = "Plugin toggle failed (\(status)): \(msg)"
                await self.pollOnce(forceRefresh: true)
            case .timedOut(let reason), .unreachable(let reason):
                revertSinglePlugin()
                self.actionError = "Daemon unreachable: \(reason)"
                self.showTransientNotice("Reverted plugin toggle — daemon unreachable")
            }
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
        actionError = nil
        defer { isBusy = false }

        let port = daemonPort
        let timeout: TimeInterval = subcommand == "install" ? 30 : 15
        let (result, installed) = await Task.detached(priority: .userInitiated) {
            let cmdRes = await Self.runFicheCommand(
                arguments: ["service", subcommand],
                port: port,
                timeoutSeconds: timeout
            )
            let exists = await Self.checkLaunchAgentExists()
            return (cmdRes, exists)
        }.value

        isLoginAgentInstalled = installed
        if result.exitCode != 0 {
            let detail = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            let fallback = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            actionError = !detail.isEmpty
                ? detail
                : (!fallback.isEmpty ? fallback : "`fiche service \(subcommand)` exited with code \(result.exitCode)")
        } else if subcommand == "install" && !installed {
            actionError = "LaunchAgent plist was written, but launchd did not load \(Self.launchAgentLabel)."
            await pollOnce(forceRefresh: true)
        } else {
            await pollOnce(forceRefresh: true)
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
        case .httpError, .timedOut, .unreachable:
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
        case .timedOut(let reason):
            return .timedOut(reason)
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
        case .timedOut(let reason):
            return .timedOut(reason)
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
        } catch let urlError as URLError where urlError.code == .timedOut {
            return .timedOut(urlError.localizedDescription)
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

    nonisolated private static func hasLaunchAgentPlist() -> Bool {
        FileManager.default.fileExists(atPath: launchAgentPlistURL.path)
    }

    nonisolated private static func checkLaunchAgentExists() async -> Bool {
        guard hasLaunchAgentPlist() else { return false }
        return await isLaunchAgentLoaded()
    }

    nonisolated private static func installedLaunchAgentPort() -> Int? {
        guard let data = try? Data(contentsOf: launchAgentPlistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any]
        else {
            return nil
        }
        if let env = plist["EnvironmentVariables"] as? [String: Any] {
            for key in ["FICHE_PORT", "PORT"] {
                if let portStr = env[key] as? String, let parsed = Int(portStr.trimmingCharacters(in: .whitespacesAndNewlines)) {
                    return parsed
                }
                if let portNum = env[key] as? Int {
                    return portNum
                }
            }
        }
        if let sockets = plist["Sockets"] as? [String: Any],
           let listeners = sockets["Listeners"] as? [String: Any]
        {
            if let sockStr = listeners["SockServiceName"] as? String, let parsed = Int(sockStr.trimmingCharacters(in: .whitespacesAndNewlines)) {
                return parsed
            }
            if let sockNum = listeners["SockServiceName"] as? Int {
                return sockNum
            }
        }
        return 47_821
    }

    nonisolated private static func isLaunchAgentLoaded() async -> Bool {
        let uid = getuid()
        let target = "gui/\(uid)/\(launchAgentLabel)"
        let res = await runProcessAsync(executable: "/bin/launchctl", arguments: ["print", target])
        return res.exitCode == 0
    }

    nonisolated private static func kickstartLaunchAgent() async -> String? {
        await Task.detached(priority: .userInitiated) {
            let uid = getuid()
            let domain = "gui/\(uid)"
            let target = "\(domain)/\(launchAgentLabel)"
            let plistPath = launchAgentPlistURL.path

            let first = await runProcessAsync(executable: "/bin/launchctl", arguments: ["kickstart", "-k", target])
            if first.exitCode == 0 {
                return nil
            }

            var lastBootstrap = CommandOutput(exitCode: 1, stdout: "", stderr: "")
            for attempt in 0..<3 {
                lastBootstrap = await runProcessAsync(executable: "/bin/launchctl", arguments: ["bootstrap", domain, plistPath])
                if lastBootstrap.exitCode == 0 {
                    // `bootstrap` starts RunAtLoad / KeepAlive services directly; no redundant kickstart needed.
                    return nil
                }
                let isEIO = lastBootstrap.exitCode == 5
                    || lastBootstrap.stderr.contains("Input/output error")
                    || lastBootstrap.stderr.contains("5:")
                if isEIO && attempt < 2 {
                    try? await Task.sleep(for: .milliseconds(250))
                    if await isLaunchAgentLoaded() {
                        return nil
                    }
                    continue
                }
                break
            }

            let bootErr = lastBootstrap.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            let firstErr = first.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return !bootErr.isEmpty ? bootErr : (!firstErr.isEmpty ? firstErr : "launchctl bootstrap failed (\(lastBootstrap.exitCode))")
        }.value
    }

    nonisolated private static func bootoutLaunchAgent() async -> (exitCode: Int32, stderr: String) {
        await Task.detached(priority: .userInitiated) {
            let uid = getuid()
            let target = "gui/\(uid)/\(launchAgentLabel)"
            let res = await runProcessAsync(executable: "/bin/launchctl", arguments: ["bootout", target])
            return (res.exitCode, res.stderr.trimmingCharacters(in: .whitespacesAndNewlines))
        }.value
    }

    nonisolated private static func resolveNodeBinary() async -> String? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path

        let fixedCandidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "\(home)/.volta/bin/node",
            "\(home)/.local/share/mise/shims/node",
        ]
        for candidate in fixedCandidates where isExecutableRegularFile(candidate) {
            return candidate
        }

        // Check common version managers (newest version directory first)
        let versionedDirs = [
            "\(home)/.nvm/versions/node",
            "\(home)/.fnm/node-versions",
            "\(home)/.local/share/fnm/node-versions",
            "\(home)/Library/Application Support/fnm/node-versions",
            "\(home)/.local/share/mise/installs/node",
            "\(home)/.volta/tools/image/node",
        ]
        for base in versionedDirs {
            guard let entries = try? fm.contentsOfDirectory(atPath: base) else { continue }
            let sorted = entries.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            for ver in sorted {
                let direct = "\(base)/\(ver)/bin/node"
                if isExecutableRegularFile(direct) { return direct }
                let fnm = "\(base)/\(ver)/installation/bin/node"
                if isExecutableRegularFile(fnm) { return fnm }
            }
        }

        // Fallback to PATH lookup via /usr/bin/which
        let whichRes = await runProcessAsync(
            executable: "/usr/bin/which",
            arguments: ["node"],
            extraPathPrefix: "/opt/homebrew/bin:/usr/local/bin:\(home)/.local/bin"
        )
        let found = whichRes.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if whichRes.exitCode == 0, !found.isEmpty, isExecutableRegularFile(found) {
            return found
        }
        return nil
    }

    nonisolated private static func resolveFicheExecutable(nodePath: String?) async -> FicheExecutable? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path

        var binaryCandidates = [
            "\(home)/.local/bin/fiche",
            "/opt/homebrew/bin/fiche",
            "/usr/local/bin/fiche",
            "\(home)/.volta/bin/fiche",
            "\(home)/.bun/bin/fiche",
            "\(home)/Library/pnpm/fiche",
            "\(home)/.pnpm-global/bin/fiche",
            "\(home)/.npm-global/bin/fiche",
        ]
        let versionedDirs = [
            "\(home)/.nvm/versions/node",
            "\(home)/.fnm/node-versions",
            "\(home)/.local/share/fnm/node-versions",
            "\(home)/Library/Application Support/fnm/node-versions",
            "\(home)/.local/share/mise/installs/node",
            "\(home)/.volta/tools/image/node",
        ]
        for base in versionedDirs {
            guard let entries = try? fm.contentsOfDirectory(atPath: base) else { continue }
            let sorted = entries.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
            for ver in sorted {
                binaryCandidates.append("\(base)/\(ver)/bin/fiche")
                binaryCandidates.append("\(base)/\(ver)/installation/bin/fiche")
            }
        }
        if let nodePath {
            let nodeDir = (nodePath as NSString).deletingLastPathComponent
            binaryCandidates.insert("\(nodeDir)/fiche", at: 0)
        }

        for path in binaryCandidates where isExecutableRegularFile(path) {
            return .binary(path)
        }

        let whichRes = await runProcessAsync(
            executable: "/usr/bin/which",
            arguments: ["fiche"],
            extraPathPrefix: "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:\(home)/.volta/bin:\(home)/.bun/bin"
        )
        let found = whichRes.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if whichRes.exitCode == 0, !found.isEmpty, isExecutableRegularFile(found) {
            return .binary(found)
        }

        if let customCli = ProcessInfo.processInfo.environment["FICHE_CLI_PATH"],
           !customCli.isEmpty,
           fm.fileExists(atPath: customCli) {
            if isExecutableRegularFile(customCli), !customCli.hasSuffix(".js") {
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

    nonisolated private static func spawnDetachedDaemon(port: Int) async -> Result<Int32, SpawnFailure> {
        let nodePath = await resolveNodeBinary()
        guard let entry = await resolveFicheExecutable(nodePath: nodePath) else {
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
        env["FICHE_PORT"] = String(port)
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

    private struct KoshaEnvSnapshot: Sendable {
        let hasCLI: Bool
        let hasRegistry: Bool
        let updatedAt: Date?
    }

    nonisolated private static func resolveKoshaBinary() async -> String? {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/.local/bin/kosha",
            "/opt/homebrew/bin/kosha",
            "/usr/local/bin/kosha",
            "\(home)/.bun/bin/kosha",
            "\(home)/.volta/bin/kosha",
        ]
        for path in candidates where isExecutableRegularFile(path) {
            return path
        }
        let whichRes = await runProcessAsync(
            executable: "/usr/bin/which",
            arguments: ["kosha"],
            extraPathPrefix: "\(home)/.local/bin:/opt/homebrew/bin:/usr/local/bin:\(home)/.volta/bin:\(home)/.bun/bin"
        )
        let found = whichRes.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if whichRes.exitCode == 0, !found.isEmpty, isExecutableRegularFile(found) {
            return found
        }
        return nil
    }

    nonisolated private static func inspectKoshaEnvironment() async -> KoshaEnvSnapshot {
        let fm = FileManager.default
        let envReg = ProcessInfo.processInfo.environment["KOSHA_REGISTRY"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let defaultReg = fm.homeDirectoryForCurrentUser
            .appendingPathComponent(".kosha/registry.json")
            .path
        let candidatePaths = [envReg, defaultReg].compactMap { $0 }.filter { !$0.isEmpty }
        let foundPath = candidatePaths.first { fm.fileExists(atPath: $0) }
        let updatedAt: Date? = foundPath.flatMap { path in
            try? fm.attributesOfItem(atPath: path)[.modificationDate] as? Date
        }
        return KoshaEnvSnapshot(
            hasCLI: await resolveKoshaBinary() != nil,
            hasRegistry: foundPath != nil,
            updatedAt: updatedAt
        )
    }

    nonisolated private static func runFicheCommand(
        arguments: [String],
        port: Int? = nil,
        timeoutSeconds: TimeInterval = 15
    ) async -> CommandOutput {
        let nodePath = await resolveNodeBinary()
        guard let entry = await resolveFicheExecutable(nodePath: nodePath) else {
            return CommandOutput(
                exitCode: 127,
                stdout: "",
                stderr: "Could not locate `fiche` or `node` executable."
            )
        }
        let extraEnv: [String: String] = port.map { ["FICHE_PORT": String($0), "PORT": String($0)] } ?? [:]

        switch entry {
        case .binary(let binPath):
            return await runProcessAsync(
                executable: binPath,
                arguments: arguments,
                extraPathPrefix: nodePath.map { ($0 as NSString).deletingLastPathComponent },
                extraEnv: extraEnv,
                timeoutSeconds: timeoutSeconds
            )
        case .nodeScript(let node, let script):
            return await runProcessAsync(
                executable: node,
                arguments: [script] + arguments,
                extraPathPrefix: (node as NSString).deletingLastPathComponent,
                extraEnv: extraEnv,
                timeoutSeconds: timeoutSeconds
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

    nonisolated private static func isLiveFicheProcess(pid: Int) -> Bool {
        guard pid > 1 else { return false }
        let alive = Darwin.kill(pid_t(pid), 0) == 0 || Darwin.errno == EPERM
        return alive && isFicheProcess(pid: pid)
    }

    private final class AsyncProcessState: @unchecked Sendable {
        var outData = Data()
        var errData = Data()
        var outClosed = false
        var errClosed = false
        var procExited = false
        var exitStatus: Int32 = 0
        var didTimeout = false
        var didResume = false
        var timeoutItem: DispatchWorkItem?
        var postExitGraceItem: DispatchWorkItem?
        var continuation: CheckedContinuation<CommandOutput, Never>?
    }

    nonisolated private static func runProcessAsync(
        executable: String,
        arguments: [String],
        extraPathPrefix: String? = nil,
        extraEnv: [String: String] = [:],
        timeoutSeconds: TimeInterval = 15,
        maxCaptureBytes: Int = 2 * 1024 * 1024
    ) async -> CommandOutput {
        var outFds: [Int32] = [-1, -1]
        var errFds: [Int32] = [-1, -1]
        guard Darwin.pipe(&outFds) == 0 else {
            return CommandOutput(exitCode: 1, stdout: "", stderr: "Failed to allocate stdout pipe.")
        }
        guard Darwin.pipe(&errFds) == 0 else {
            Darwin.close(outFds[0])
            Darwin.close(outFds[1])
            return CommandOutput(exitCode: 1, stdout: "", stderr: "Failed to allocate stderr pipe.")
        }

        let outReadFd = outFds[0]
        let outWriteFd = outFds[1]
        let errReadFd = errFds[0]
        let errWriteFd = errFds[1]

        for fd in [outReadFd, outWriteFd, errReadFd, errWriteFd] {
            _ = Darwin.fcntl(fd, F_SETFD, FD_CLOEXEC)
        }
        for rfd in [outReadFd, errReadFd] {
            let flags = Darwin.fcntl(rfd, F_GETFL, 0)
            if flags >= 0 {
                _ = Darwin.fcntl(rfd, F_SETFL, flags | O_NONBLOCK)
            }
        }

        let outWriteHandle = FileHandle(fileDescriptor: outWriteFd, closeOnDealloc: true)
        let errWriteHandle = FileHandle(fileDescriptor: errWriteFd, closeOnDealloc: true)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments

        var env = ProcessInfo.processInfo.environment
        for (k, v) in extraEnv {
            env[k] = v
        }
        env["PATH"] = buildAugmentedPath(existing: env["PATH"], extraPrefix: extraPathPrefix)
        process.environment = env

        process.standardInput = FileHandle.nullDevice
        process.standardOutput = outWriteHandle
        process.standardError = errWriteHandle

        let ioQueue = DispatchQueue(label: "dev.srinivas.fichebar.proc.\(UUID().uuidString)")
        let state = AsyncProcessState()
        let outSource = DispatchSource.makeReadSource(fileDescriptor: outReadFd, queue: ioQueue)
        let errSource = DispatchSource.makeReadSource(fileDescriptor: errReadFd, queue: ioQueue)
        let clampedTimeout = max(1.0, timeoutSeconds)

        @Sendable func finishIfReady() {
            guard !state.didResume else { return }
            let ready = state.didTimeout || (state.procExited && state.outClosed && state.errClosed)
            guard ready else { return }
            state.didResume = true
            state.timeoutItem?.cancel()
            state.timeoutItem = nil
            state.postExitGraceItem?.cancel()
            state.postExitGraceItem = nil
            let stdout = String(data: state.outData, encoding: .utf8) ?? ""
            let stderr = state.didTimeout
                ? "Subprocess timed out after \(Int(clampedTimeout))s."
                : (String(data: state.errData, encoding: .utf8) ?? "")
            let code: Int32 = state.didTimeout ? 124 : state.exitStatus
            let cont = state.continuation
            state.continuation = nil
            cont?.resume(returning: CommandOutput(exitCode: code, stdout: stdout, stderr: stderr))
        }

        @Sendable func drainFd(
            _ fd: Int32,
            isClosed: Bool,
            source: DispatchSourceRead,
            append: (Data) -> Void
        ) {
            guard !isClosed else { return }
            var buf = [UInt8](repeating: 0, count: 8192)
            while true {
                let n = Darwin.read(fd, &buf, buf.count)
                if n > 0 {
                    append(Data(buf[..<n]))
                } else if n == 0 {
                    source.cancel()
                    break
                } else {
                    let code = errno
                    if code == EINTR { continue }
                    if code == EAGAIN || code == EWOULDBLOCK { break }
                    source.cancel()
                    break
                }
            }
        }

        @Sendable func appendBounded(_ data: inout Data, chunk: Data) {
            guard !chunk.isEmpty, data.count < maxCaptureBytes else { return }
            let remaining = maxCaptureBytes - data.count
            data.append(chunk.prefix(remaining))
        }

        return await withCheckedContinuation { continuation in
            ioQueue.sync {
                state.continuation = continuation
            }

            outSource.setEventHandler {
                drainFd(outReadFd, isClosed: state.outClosed, source: outSource) { chunk in
                    appendBounded(&state.outData, chunk: chunk)
                }
            }
            outSource.setCancelHandler {
                if !state.outClosed {
                    state.outClosed = true
                    Darwin.close(outReadFd)
                }
                finishIfReady()
            }

            errSource.setEventHandler {
                drainFd(errReadFd, isClosed: state.errClosed, source: errSource) { chunk in
                    appendBounded(&state.errData, chunk: chunk)
                }
            }
            errSource.setCancelHandler {
                if !state.errClosed {
                    state.errClosed = true
                    Darwin.close(errReadFd)
                }
                finishIfReady()
            }

            let timeoutWork = DispatchWorkItem {
                guard !state.didResume else { return }
                state.didTimeout = true
                if process.isRunning {
                    process.terminate()
                    let pid = process.processIdentifier
                    ioQueue.asyncAfter(deadline: .now() + 0.5) {
                        if process.isRunning && pid > 0 {
                            _ = Darwin.kill(pid, SIGKILL)
                        }
                    }
                }
                if !state.outClosed { outSource.cancel() }
                if !state.errClosed { errSource.cancel() }
                finishIfReady()
            }
            state.timeoutItem = timeoutWork

            process.terminationHandler = { proc in
                let status = proc.terminationStatus
                ioQueue.async {
                    state.procExited = true
                    state.exitStatus = status
                    drainFd(outReadFd, isClosed: state.outClosed, source: outSource) { chunk in
                        appendBounded(&state.outData, chunk: chunk)
                    }
                    drainFd(errReadFd, isClosed: state.errClosed, source: errSource) { chunk in
                        appendBounded(&state.errData, chunk: chunk)
                    }
                    if !state.outClosed || !state.errClosed {
                        let grace = DispatchWorkItem {
                            if !state.outClosed { outSource.cancel() }
                            if !state.errClosed { errSource.cancel() }
                            finishIfReady()
                        }
                        state.postExitGraceItem = grace
                        ioQueue.asyncAfter(deadline: .now() + 0.3, execute: grace)
                    }
                    finishIfReady()
                }
            }

            outSource.resume()
            errSource.resume()
            ioQueue.asyncAfter(deadline: .now() + clampedTimeout, execute: timeoutWork)

            do {
                try process.run()
                try? outWriteHandle.close()
                try? errWriteHandle.close()
            } catch {
                let message = error.localizedDescription
                try? outWriteHandle.close()
                try? errWriteHandle.close()
                ioQueue.async {
                    state.timeoutItem?.cancel()
                    state.timeoutItem = nil
                    if !state.outClosed { outSource.cancel() }
                    if !state.errClosed { errSource.cancel() }
                    guard !state.didResume else { return }
                    state.didResume = true
                    let cont = state.continuation
                    state.continuation = nil
                    cont?.resume(returning: CommandOutput(exitCode: 1, stdout: "", stderr: message))
                }
            }
        }
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
