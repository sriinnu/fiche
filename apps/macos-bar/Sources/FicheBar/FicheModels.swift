import Foundation

// MARK: - Dynamic CodingKey & Resilient Decoding Helpers

struct DynamicCodingKey: CodingKey, Hashable {
    var stringValue: String
    var intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }

    init(_ string: String) {
        self.stringValue = string
        self.intValue = nil
    }
}

extension KeyedDecodingContainer where Key == DynamicCodingKey {
    func firstString(_ keys: String...) -> String? {
        for name in keys {
            let key = DynamicCodingKey(name)
            if let value = try? decodeIfPresent(String.self, forKey: key) {
                return value
            }
        }
        return nil
    }

    func firstBool(_ keys: String...) -> Bool? {
        for name in keys {
            let key = DynamicCodingKey(name)
            if let value = try? decodeIfPresent(Bool.self, forKey: key) {
                return value
            }
        }
        return nil
    }

    func firstInt(_ keys: String...) -> Int? {
        for name in keys {
            let key = DynamicCodingKey(name)
            if let value = try? decodeIfPresent(Int.self, forKey: key) {
                return value
            }
            if let doubleVal = try? decodeIfPresent(Double.self, forKey: key), doubleVal.isFinite {
                return Int(doubleVal.rounded())
            }
        }
        return nil
    }

    func firstInt64(_ keys: String...) -> Int64? {
        for name in keys {
            let key = DynamicCodingKey(name)
            if let value = try? decodeIfPresent(Int64.self, forKey: key) {
                return value
            }
            if let doubleVal = try? decodeIfPresent(Double.self, forKey: key), doubleVal.isFinite {
                return Int64(doubleVal.rounded())
            }
        }
        return nil
    }

    func firstDouble(_ keys: String...) -> Double? {
        for name in keys {
            let key = DynamicCodingKey(name)
            if let value = try? decodeIfPresent(Double.self, forKey: key), value.isFinite {
                return value
            }
        }
        return nil
    }

    func firstStringArray(_ keys: String...) -> [String]? {
        for name in keys {
            let key = DynamicCodingKey(name)
            if let value = try? decodeIfPresent([String].self, forKey: key) {
                return value
            }
        }
        return nil
    }
}

// MARK: - Daemon State

enum DaemonPhase: String, Sendable, Equatable {
    case stopped
    case starting
    case paused
    case live
}

// MARK: - GET /api/health

struct HealthResponse: Decodable, Sendable, Equatable {
    let ok: Bool
    let name: String?
    let version: String?
    let pid: Int?
    let host: String?
    let port: Int?
    let uptimeSec: Double?
    let compressionEnabled: Bool?
    let priceMode: String?
    let allowedModels: [String]?
    let enabledProviders: [String]?
    let eventsFile: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.ok = c.firstBool("ok") ?? true
        self.name = c.firstString("name")
        self.version = c.firstString("version")
        self.pid = c.firstInt("pid")
        self.host = c.firstString("host")
        self.port = c.firstInt("port")
        self.uptimeSec = c.firstDouble("uptime_sec", "uptimeSec")
        self.compressionEnabled = c.firstBool("compression_enabled", "compressionEnabled")
        self.priceMode = c.firstString("price_mode", "priceMode")
        self.allowedModels = c.firstStringArray("allowed_models", "allowedModels")
        self.enabledProviders = c.firstStringArray("enabled_providers", "enabledProviders")
        self.eventsFile = c.firstString("events_file", "eventsFile")
    }
}

// MARK: - GET /proxy-stats

struct RenderCacheStats: Decodable, Sendable, Equatable {
    let entries: Int
    let bytes: Int64
    let maxBytes: Int64
    let hits: Int
    let misses: Int
    let evictions: Int
    let oversized: Int

    var hitRatePct: Double? {
        let total = hits + misses
        guard total > 0 else { return nil }
        return (Double(hits) / Double(total)) * 100.0
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.entries = c.firstInt("entries") ?? 0
        self.bytes = c.firstInt64("bytes") ?? 0
        self.maxBytes = c.firstInt64("max_bytes", "maxBytes") ?? 0
        self.hits = c.firstInt("hits") ?? 0
        self.misses = c.firstInt("misses") ?? 0
        self.evictions = c.firstInt("evictions") ?? 0
        self.oversized = c.firstInt("oversized") ?? 0
    }
}

struct PricingAssumptions: Decodable, Sendable, Equatable {
    let priceMode: String?
    let priceSnapshot: String?
    let inputPerMtok: Double?
    let source: String?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.priceMode = c.firstString("price_mode", "priceMode")
        self.priceSnapshot = c.firstString("price_snapshot", "priceSnapshot")
        self.inputPerMtok = c.firstDouble("input_per_mtok", "inputPerMtok")
        self.source = c.firstString("source")
    }
}

struct DailySavingsPoint: Decodable, Identifiable, Sendable, Equatable {
    let date: String
    let requests: Int
    let compressed: Int
    let imaged: Int
    let textCompressed: Int
    let baselineInputWeighted: Double
    let actualInputWeighted: Double
    let savedTokens: Double
    let rawSavedTokens: Double
    let savedPct: Double
    let savedUsd: Double
    let cliffSavedUsd: Double
    let isToday: Bool

    var id: String { date }

    var shortDateLabel: String {
        if isToday { return "Today" }
        let parts = date.split(separator: "-")
        guard parts.count == 3, let month = Int(parts[1]), let day = Int(parts[2]), (1...12).contains(month) else {
            return date
        }
        let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return "\(months[month - 1]) \(day)"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.date = c.firstString("date") ?? ""
        self.requests = c.firstInt("requests") ?? 0
        self.compressed = c.firstInt("compressed", "compressed_requests", "compressedRequests") ?? 0
        self.imaged = c.firstInt("imaged", "imaged_requests", "imagedRequests") ?? 0
        self.textCompressed = c.firstInt("text_compressed", "textCompressed", "text_compressed_requests") ?? 0
        let baseline = c.firstDouble("baseline_input_weighted", "baselineInputWeighted") ?? 0
        let actual = c.firstDouble("actual_input_weighted", "actualInputWeighted") ?? 0
        self.baselineInputWeighted = baseline
        self.actualInputWeighted = actual
        self.savedTokens = c.firstDouble("saved_tokens", "savedTokens", "saved_input_tokens") ?? (baseline - actual)
        self.rawSavedTokens = c.firstDouble("raw_saved_tokens", "rawSavedTokens") ?? 0
        self.savedPct = c.firstDouble("saved_pct", "savedPct") ?? 0
        self.savedUsd = c.firstDouble("saved_usd", "savedUsd") ?? 0
        self.cliffSavedUsd = c.firstDouble("cliff_saved_usd", "cliffSavedUsd") ?? 0
        self.isToday = c.firstBool("is_today", "isToday") ?? false
    }
}

enum DesktopAppAttachmentState: String, Sendable, Equatable {
    case attached
    case launchedWithoutProxyFlag
    case runningDirect
    case stopped
}

struct DiscoveredDesktopApp: Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let displayName: String
    let bundlePath: String
    let isElectron: Bool
    let attachmentState: DesktopAppAttachmentState
    let attachedPIDs: [Int32]
    let directPIDs: [Int32]
}

struct DiscoveredCLIAgent: Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let command: String
    let provider: String
    let installed: Bool
    let binaryPath: String?
    let attachedCount: Int
    let directCount: Int
}

struct ModelStats: Decodable, Sendable, Equatable {
    let requests: Int
    let compressedRequests: Int
    let imagedRequests: Int
    let textCompressedRequests: Int
    let baselineInputWeighted: Double
    let actualInputWeighted: Double
    let savedInputTokens: Double
    let rawSavedTokens: Double
    let savedPct: Double
    let savedUsd: Double
    let cliffAvoidedEvents: Int
    let cliffSavedUsd: Double

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.requests = c.firstInt("requests", "turns", "count") ?? 0
        self.compressedRequests = c.firstInt("compressed_requests", "compressedRequests", "compressed") ?? 0
        self.imagedRequests = c.firstInt("imaged", "imaged_requests", "imagedRequests") ?? 0
        self.textCompressedRequests = c.firstInt("text_compressed", "textCompressed", "text_compressed_requests") ?? 0
        let baseline = c.firstDouble("baseline_input_weighted", "baselineInputWeighted", "baseline_tokens", "baselineTokens") ?? 0
        let actual = c.firstDouble("actual_input_weighted", "actualInputWeighted", "actual_tokens", "actualTokens") ?? 0
        let saved = c.firstDouble("saved_input_tokens", "savedInputTokens", "saved_tokens", "savedTokens")
            ?? (baseline - actual)
        self.baselineInputWeighted = baseline
        self.actualInputWeighted = actual
        self.savedInputTokens = saved
        self.rawSavedTokens = c.firstDouble("raw_saved_tokens", "rawSavedTokens") ?? 0
        if let pct = c.firstDouble("saved_pct", "savedPct", "saved_pct_input_only") {
            self.savedPct = pct
        } else if baseline > 0 {
            self.savedPct = (saved / baseline) * 100.0
        } else {
            self.savedPct = 0
        }
        self.savedUsd = c.firstDouble("saved_usd", "savedUsd") ?? 0
        self.cliffAvoidedEvents = c.firstInt("cliff_avoided_events", "cliffAvoidedEvents") ?? 0
        self.cliffSavedUsd = c.firstDouble("cliff_saved_usd", "cliffSavedUsd") ?? 0
    }
}

struct ProxyStatsResponse: Decodable, Sendable, Equatable {
    let requests: Int
    let compressedRequests: Int
    let imagedRequests: Int
    let textCompressedRequests: Int
    let passthrough: Int
    let baselineInputWeighted: Double
    let actualInputWeighted: Double
    let savedInputTokens: Double
    let rawSavedTokens: Double
    let savedPct: Double
    let savedUsd: Double
    let cliffAvoidedEvents: Int
    let cliffSavedUsd: Double
    let uptimeSec: Double?
    let compressionEnabled: Bool?
    let renderCache: RenderCacheStats?
    let pricingAssumptions: PricingAssumptions?
    let allowedModels: [String]?
    let byModel: [String: ModelStats]
    let today: DailySavingsPoint?
    let daily: [DailySavingsPoint]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        let reqs = c.firstInt("requests") ?? 0
        let comp = c.firstInt("compressed_requests", "compressedRequests") ?? 0
        self.requests = reqs
        self.compressedRequests = comp
        self.imagedRequests = c.firstInt("imaged_requests", "imagedRequests") ?? 0
        self.textCompressedRequests = c.firstInt("text_compressed_requests", "textCompressedRequests") ?? 0
        self.passthrough = c.firstInt("passthrough", "passthrough_paid_requests") ?? max(0, reqs - comp)
        self.baselineInputWeighted = c.firstDouble("baseline_input_weighted", "baselineInputWeighted") ?? 0
        self.actualInputWeighted = c.firstDouble("actual_input_weighted", "actualInputWeighted") ?? 0
        self.savedInputTokens = c.firstDouble("saved_input_tokens", "savedInputTokens") ?? 0
        self.rawSavedTokens = c.firstDouble("raw_saved_tokens", "rawSavedTokens") ?? 0
        self.savedPct = c.firstDouble("saved_pct", "saved_pct_input_only", "savedPct") ?? 0
        self.savedUsd = c.firstDouble("saved_usd", "savedUsd") ?? 0
        self.cliffAvoidedEvents = c.firstInt("cliff_avoided_events", "cliffAvoidedEvents") ?? 0
        self.cliffSavedUsd = c.firstDouble("cliff_saved_usd", "cliffSavedUsd") ?? 0
        self.uptimeSec = c.firstDouble("uptime_sec", "uptimeSec")
        self.compressionEnabled = c.firstBool("compression_enabled", "compressionEnabled")
        self.renderCache = try? c.decodeIfPresent(RenderCacheStats.self, forKey: DynamicCodingKey("render_cache"))
        self.pricingAssumptions = try? c.decodeIfPresent(PricingAssumptions.self, forKey: DynamicCodingKey("pricing_assumptions"))
        self.allowedModels = c.firstStringArray("allowed_models", "allowedModels")
        self.byModel = (try? c.decodeIfPresent([String: ModelStats].self, forKey: DynamicCodingKey("by_model")))
            ?? (try? c.decodeIfPresent([String: ModelStats].self, forKey: DynamicCodingKey("byModel")))
            ?? [:]
        self.today = try? c.decodeIfPresent(DailySavingsPoint.self, forKey: DynamicCodingKey("today"))
        self.daily = (try? c.decodeIfPresent([DailySavingsPoint].self, forKey: DynamicCodingKey("daily"))) ?? []
    }
}

// MARK: - GET /api/last-turn.json

struct LastTurnSnapshot: Decodable, Sendable, Equatable {
    let ts: String?
    let model: String?
    let rawInputTokens: Double?
    let inputTokens: Double?
    let savedTokens: Double
    let savedPct: Double?
    let savedUsd: Double
    let stages: [String]
    let compressed: Bool
    let cacheReadTokens: Double?
    let cacheHitPct: Double?
    let cliffAvoidedAt: Double?
    let cliffSavedUsd: Double?
    let sessionId: String?

    var effectiveSavedPct: Double? {
        if let savedPct { return savedPct }
        let raw = rawInputTokens ?? inputTokens ?? 0
        if raw > 0, savedTokens != 0 {
            let baseline = rawInputTokens != nil ? raw : (raw + savedTokens)
            if baseline > 0 {
                return (savedTokens / baseline) * 100.0
            }
        }
        return nil
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.ts = c.firstString("ts")
        self.model = c.firstString("model")
        self.rawInputTokens = c.firstDouble("rawInputTokens", "raw_input_tokens")
        self.inputTokens = c.firstDouble("inputTokens", "input_tokens")
        self.savedTokens = c.firstDouble("savedTokens", "saved_tokens") ?? 0
        self.savedPct = c.firstDouble("savedPct", "saved_pct")
        self.savedUsd = c.firstDouble("savedUsd", "saved_usd") ?? 0
        self.stages = c.firstStringArray("stages") ?? []
        let hasStagesOrSaved = !self.stages.isEmpty || self.savedTokens > 0
        self.compressed = c.firstBool("compressed") ?? hasStagesOrSaved
        self.cacheReadTokens = c.firstDouble("cacheReadTokens", "cache_read_tokens", "cachedTokens", "cached_tokens")
        self.cacheHitPct = c.firstDouble("cacheHitPct", "cache_hit_pct")
        self.cliffAvoidedAt = c.firstDouble("cliffAvoidedAt", "cliff_avoided_at")
        self.cliffSavedUsd = c.firstDouble("cliffSavedUsd", "cliff_saved_usd")
        self.sessionId = c.firstString("sessionId", "session_id")
    }
}

struct SessionRollup: Decodable, Sendable, Equatable {
    let sessionId: String?
    let turns: Int
    let compressedTurns: Int
    let savedTokens: Double
    let savedPct: Double?
    let savedUsd: Double
    let cliffSavedUsd: Double
    let avgCacheHitPct: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.sessionId = c.firstString("sessionId", "session_id")
        self.turns = c.firstInt("turns") ?? 0
        self.compressedTurns = c.firstInt("compressedTurns", "compressed_turns") ?? 0
        self.savedTokens = c.firstDouble("savedTokens", "saved_tokens") ?? 0
        self.savedPct = c.firstDouble("savedPct", "saved_pct")
        self.savedUsd = c.firstDouble("savedUsd", "saved_usd") ?? 0
        self.cliffSavedUsd = c.firstDouble("cliffSavedUsd", "cliff_saved_usd") ?? 0
        self.avgCacheHitPct = c.firstDouble("avgCacheHitPct", "avg_cache_hit_pct")
    }
}

struct LastTurnResponse: Decodable, Sendable, Equatable {
    let eventsFile: String?
    let hasNewTurn: Bool
    let lastTurn: LastTurnSnapshot?
    let session: SessionRollup?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.eventsFile = c.firstString("eventsFile", "events_file")
        self.hasNewTurn = c.firstBool("hasNewTurn", "has_new_turn") ?? false
        self.lastTurn = try? c.decodeIfPresent(LastTurnSnapshot.self, forKey: DynamicCodingKey("lastTurn"))
            ?? c.decodeIfPresent(LastTurnSnapshot.self, forKey: DynamicCodingKey("last_turn"))
        self.session = try? c.decodeIfPresent(SessionRollup.self, forKey: DynamicCodingKey("session"))
    }
}

// MARK: - POST /api/compression

struct CompressionToggleResponse: Decodable, Sendable {
    let compressionEnabled: Bool

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.compressionEnabled = c.firstBool("compression_enabled", "compressionEnabled", "enabled") ?? true
    }
}

// MARK: - GET / POST /api/models

struct ModelCatalogItem: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let label: String
    let family: String
    let hint: String?
    let engineMode: String?

    init(id: String, label: String, family: String, hint: String? = nil, engineMode: String? = nil) {
        self.id = id
        self.label = label
        self.family = family
        self.hint = hint
        self.engineMode = engineMode
    }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let idStr = try? single.decode(String.self) {
            self.id = idStr
            self.label = idStr
            self.family = ModelCatalogItem.inferFamily(for: idStr)
            self.hint = nil
            self.engineMode = nil
            return
        }
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        let id = c.firstString("id", "model", "name") ?? ""
        self.id = id
        self.label = c.firstString("label", "name", "displayName") ?? id
        self.family = c.firstString("family", "provider") ?? ModelCatalogItem.inferFamily(for: id)
        self.hint = c.firstString("hint", "mode", "description")
        self.engineMode = c.firstString("engine_mode", "engineMode")
    }

    static func inferFamily(for id: String) -> String {
        let lower = id.lowercased()
        let base = lower.split(separator: "/").last.map(String.init) ?? lower
        if base.hasPrefix("claude") { return "Anthropic" }
        if base.contains("gemini") || base.hasPrefix("gemma") { return "Google" }
        if base.hasPrefix("gpt") || base.hasPrefix("o1") || base.hasPrefix("o3") || base.hasPrefix("o4") {
            return "OpenAI"
        }
        if base.hasPrefix("grok") { return "xAI" }
        if base.hasPrefix("deepseek") { return "DeepSeek" }
        if base.hasPrefix("kimi") || base.contains("moonshot") { return "Moonshot" }
        if base.hasPrefix("glm") || base.hasPrefix("zai-glm") { return "Zhipu" }
        if base.hasPrefix("qwen") { return "Alibaba" }
        if base.hasPrefix("mistral")
            || base.hasPrefix("mixtral")
            || base.hasPrefix("codestral")
            || base.hasPrefix("devstral")
            || base.hasPrefix("ministral")
            || base.hasPrefix("magistral")
            || base.hasPrefix("pixtral")
        {
            return "Mistral"
        }
        if base.hasPrefix("llama") || base.contains("llama") || base.hasPrefix("codellama") {
            return "Meta"
        }
        if base.hasPrefix("minimax") { return "MiniMax" }
        if base.hasPrefix("command-") || base.hasPrefix("c4ai-aya") { return "Cohere" }
        return "Custom"
    }

    static let curatedDefaults: [ModelCatalogItem] = [
        ModelCatalogItem(id: "claude-fable-5", label: "Claude Fable 5", family: "Anthropic", hint: "Optical + 4-layer"),
        ModelCatalogItem(id: "claude-opus-5-5", label: "Claude Opus 5.5", family: "Anthropic", hint: "4-layer text"),
        ModelCatalogItem(id: "gemini", label: "Gemini (all)", family: "Google", hint: "Optical + 4-layer"),
        ModelCatalogItem(id: "gpt-6-astra", label: "GPT-6 Astra", family: "OpenAI", hint: "4-layer text"),
        ModelCatalogItem(id: "gpt-6.2-astra", label: "GPT-6.2 Astra", family: "OpenAI", hint: "4-layer text"),
        ModelCatalogItem(id: "gpt-6-sol", label: "GPT-6 Sol", family: "OpenAI", hint: "14px optical"),
        ModelCatalogItem(id: "gpt-6.1-sol", label: "GPT-6.1 Sol", family: "OpenAI", hint: "14px optical"),
        ModelCatalogItem(id: "gpt-6.2-sol", label: "GPT-6.2 Sol", family: "OpenAI", hint: "14px optical"),
        ModelCatalogItem(id: "gpt-6.1-terra", label: "GPT-6.1 Terra", family: "OpenAI", hint: "Optical + 4-layer"),
        ModelCatalogItem(id: "gpt-6-luna", label: "GPT-6 Luna", family: "OpenAI", hint: "Optical + 4-layer"),
        ModelCatalogItem(id: "deepseek", label: "DeepSeek", family: "DeepSeek", hint: "4-layer text"),
        ModelCatalogItem(id: "kimi", label: "Kimi", family: "Moonshot", hint: "4-layer text"),
        ModelCatalogItem(id: "glm", label: "GLM", family: "Zhipu", hint: "4-layer text"),
        ModelCatalogItem(id: "grok", label: "Grok", family: "xAI", hint: "4-layer text"),
    ]
}

struct ModelsResponse: Decodable, Sendable {
    let allowedModels: [String]
    let configuredModels: [String]
    let catalog: [ModelCatalogItem]
    let compressionEnabled: Bool?

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let list = try? single.decode([String].self) {
            self.allowedModels = list
            self.configuredModels = list
            self.catalog = []
            self.compressionEnabled = nil
            return
        }
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        let allowed = c.firstStringArray("allowed_models", "allowedModels", "models", "active") ?? []
        self.allowedModels = allowed
        self.configuredModels = c.firstStringArray("configured_models", "configuredModels") ?? allowed
        self.catalog = (try? c.decodeIfPresent([ModelCatalogItem].self, forKey: DynamicCodingKey("catalog")))
            ?? (try? c.decodeIfPresent([ModelCatalogItem].self, forKey: DynamicCodingKey("available")))
            ?? []
        self.compressionEnabled = c.firstBool("compression_enabled", "compressionEnabled")
    }
}

struct KoshaSyncResponse: Decodable, Sendable {
    let ok: Bool
    let applied: Bool
    let replace: Bool
    let source: String
    let providers: [String]
    let providersMatched: [String]
    let scannedModels: Int
    let matchedModels: Int
    let discoveredCount: Int
    let added: [String]
    let models: [String]
    let saved: Bool
    let synced: Bool
}

// MARK: - GET /api/mmu/stats & /api/calibration

struct MmuStatsSnapshot: Decodable, Sendable, Equatable {
    let pagesStored: Int
    let pagesEvicted: Int
    let activePages: Int
    let activeBytes: Int64
    let tailHydrations: Int
    let tailHydrationTokens: Int
    let markovFolds: Int
    let skillsStubbed: Int
    let densityPrunedBlocks: Int

    init(
        pagesStored: Int = 0,
        pagesEvicted: Int = 0,
        activePages: Int = 0,
        activeBytes: Int64 = 0,
        tailHydrations: Int = 0,
        tailHydrationTokens: Int = 0,
        markovFolds: Int = 0,
        skillsStubbed: Int = 0,
        densityPrunedBlocks: Int = 0
    ) {
        self.pagesStored = pagesStored
        self.pagesEvicted = pagesEvicted
        self.activePages = activePages
        self.activeBytes = activeBytes
        self.tailHydrations = tailHydrations
        self.tailHydrationTokens = tailHydrationTokens
        self.markovFolds = markovFolds
        self.skillsStubbed = skillsStubbed
        self.densityPrunedBlocks = densityPrunedBlocks
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.pagesStored = c.firstInt("pagesStored", "pages_stored") ?? 0
        self.pagesEvicted = c.firstInt("pagesEvicted", "pages_evicted") ?? 0
        self.activePages = c.firstInt("activePages", "active_pages") ?? 0
        self.activeBytes = c.firstInt64("activeBytes", "active_bytes") ?? 0
        self.tailHydrations = c.firstInt("tailHydrations", "tail_hydrations") ?? 0
        self.tailHydrationTokens = c.firstInt("tailHydrationTokens", "tail_hydration_tokens") ?? 0
        self.markovFolds = c.firstInt("markovFolds", "markov_folds") ?? 0
        self.skillsStubbed = c.firstInt("skillsStubbed", "skills_stubbed") ?? 0
        self.densityPrunedBlocks = c.firstInt("densityPrunedBlocks", "density_pruned_blocks") ?? 0
    }
}

struct MmuLimitsSnapshot: Decodable, Sendable, Equatable {
    let maxPages: Int
    let maxBytes: Int64
    let persisted: Bool

    init(maxPages: Int = 512, maxBytes: Int64 = 16 * 1024 * 1024, persisted: Bool = false) {
        self.maxPages = maxPages
        self.maxBytes = maxBytes
        self.persisted = persisted
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.maxPages = c.firstInt("maxPages", "max_pages") ?? 512
        self.maxBytes = c.firstInt64("maxBytes", "max_bytes") ?? Int64(16 * 1024 * 1024)
        self.persisted = c.firstBool("persisted") ?? false
    }
}

struct PrefixTapeSnapshot: Decodable, Sendable, Equatable {
    let stage2Entries: Int
    let stage2Hits: Int
    let stage2Misses: Int
    let sealSessions: Int
    let totalSeals: Int
    let sealHits: Int
    let casiEntries: Int
    let casiHits: Int
    let casiMisses: Int

    var totalHits: Int { stage2Hits + sealHits + casiHits }
    var totalLookups: Int { totalHits + stage2Misses + casiMisses }
    var hitPct: Double? {
        guard totalLookups > 0 else { return nil }
        return (Double(totalHits) / Double(totalLookups)) * 100.0
    }
}

struct MmuStatsResponse: Decodable, Sendable, Equatable {
    let stats: MmuStatsSnapshot
    let pageCount: Int
    let limits: MmuLimitsSnapshot?
    let prefixTape: PrefixTapeSnapshot?
}

struct CalibratedModelProfile: Decodable, Identifiable, Sendable, Equatable {
    var id: String { model }
    let model: String
    let band: String
    let cols: Int
    let maxHeightPx: Int
    let calibratedAtIso: String
    let source: String
    let overallScore: Double
    let passed: Bool

    var shortBandLabel: String {
        switch band.lowercased() {
        case "spleen-5x8": return "5×8"
        case "spleen-5x10": return "5×10"
        case "jetbrains-mono-12": return "12px"
        case "jetbrains-mono-14": return "14px"
        case "text-only": return "TEXT"
        default: return band
        }
    }

    init(
        model: String,
        band: String,
        cols: Int,
        maxHeightPx: Int,
        calibratedAtIso: String = "",
        source: String = "probe",
        overallScore: Double = 1.0,
        passed: Bool = true
    ) {
        self.model = model
        self.band = band
        self.cols = cols
        self.maxHeightPx = maxHeightPx
        self.calibratedAtIso = calibratedAtIso
        self.source = source
        self.overallScore = overallScore
        self.passed = passed
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.model = c.firstString("model", "id") ?? ""
        self.band = c.firstString("band") ?? "text-only"
        self.cols = c.firstInt("cols") ?? 0
        self.maxHeightPx = c.firstInt("maxHeightPx", "max_height_px") ?? 0
        self.calibratedAtIso = c.firstString("calibratedAtIso", "calibrated_at_iso") ?? ""
        self.source = c.firstString("source") ?? "probe"
        let scores = try? c.nestedContainer(keyedBy: DynamicCodingKey.self, forKey: DynamicCodingKey("scores"))
        self.overallScore = scores?.firstDouble("overallScore", "overall_score") ?? 1.0
        self.passed = scores?.firstBool("passed") ?? true
    }
}

struct CalibrationResponse: Decodable, Sendable, Equatable {
    let profiles: [CalibratedModelProfile]
}

// MARK: - GET / POST /api/providers

struct ProviderDescriptor: Identifiable, Codable, Sendable, Equatable {
    let id: String
    let label: String
    let tier: String
    let hosts: [String]
    var enabled: Bool

    var isFirstParty: Bool {
        tier == "first-party"
    }

    var hostsSubtitle: String {
        hosts.joined(separator: ", ")
    }

    static let fallbackDefaults: [ProviderDescriptor] = [
        ProviderDescriptor(id: "anthropic", label: "Anthropic / Claude", tier: "first-party", hosts: ["api.anthropic.com"], enabled: true),
        ProviderDescriptor(id: "openai", label: "OpenAI / Codex", tier: "first-party", hosts: ["api.openai.com", "chatgpt.com"], enabled: true),
        ProviderDescriptor(id: "google", label: "Google / Gemini", tier: "first-party", hosts: ["generativelanguage.googleapis.com", "cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"], enabled: true),
    ]
}

struct ProvidersResponse: Decodable, Sendable {
    let providers: [ProviderDescriptor]
    let enabled: [String]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.providers = (try? c.decodeIfPresent([ProviderDescriptor].self, forKey: DynamicCodingKey("providers"))) ?? []
        self.enabled = c.firstStringArray("enabled") ?? self.providers.filter(\.enabled).map(\.id)
    }
}

// MARK: - GET / POST /api/plugins

enum PluginKind: String, Sendable, Equatable {
    case stage
    case plugin
    case skill

    var badgeTitle: String {
        switch self {
        case .stage: return "STAGE"
        case .plugin: return "PLUGIN"
        case .skill: return "SKILL"
        }
    }

    init(rawKind: String?) {
        switch rawKind?.lowercased() {
        case "stage", "builtin", "compiler", "pipeline": self = .stage
        case "skill": self = .skill
        default: self = .plugin
        }
    }
}

struct PluginDescriptor: Decodable, Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let description: String?
    let kind: PluginKind
    let source: String?
    let enabled: Bool
    let mutable: Bool
    let path: String?

    init(
        id: String,
        name: String,
        description: String?,
        kind: PluginKind,
        source: String?,
        enabled: Bool,
        mutable: Bool = true,
        path: String? = nil
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.kind = kind
        self.source = source
        self.enabled = enabled
        self.mutable = mutable
        self.path = path
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        let id = c.firstString("id", "slug", "name") ?? UUID().uuidString
        self.id = id
        self.name = c.firstString("name", "title", "label") ?? id
        self.description = c.firstString("description", "summary", "detail")
        let parsedKind = PluginKind(rawKind: c.firstString("kind", "type", "category"))
        self.kind = parsedKind
        self.source = c.firstString("source", "origin")
        self.enabled = c.firstBool("enabled", "active", "on") ?? true
        self.mutable = c.firstBool("mutable", "toggleable", "canToggle", "configurable") ?? (parsedKind != .stage)
        self.path = c.firstString("path", "file")
    }

    func withKind(_ overrideKind: PluginKind) -> PluginDescriptor {
        PluginDescriptor(
            id: id,
            name: name,
            description: description,
            kind: overrideKind,
            source: source,
            enabled: enabled,
            mutable: mutable,
            path: path
        )
    }

    func withEnabled(_ nextEnabled: Bool) -> PluginDescriptor {
        PluginDescriptor(
            id: id,
            name: name,
            description: description,
            kind: kind,
            source: source,
            enabled: nextEnabled,
            mutable: mutable,
            path: path
        )
    }
}

struct PluginsResponse: Decodable, Sendable {
    let items: [PluginDescriptor]
    let pluginsDir: String?

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let list = try? single.decode([PluginDescriptor].self) {
            self.items = list
            self.pluginsDir = nil
            return
        }
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.pluginsDir = c.firstString("pluginsDir", "plugins_dir", "dir")

        var combined: [PluginDescriptor] = []
        var seen = Set<String>()

        func appendList(_ list: [PluginDescriptor]?, defaultKind: PluginKind?) {
            guard let list else { return }
            for item in list where !seen.contains(item.id) {
                seen.insert(item.id)
                if let defaultKind, item.kind == .plugin && defaultKind != .plugin {
                    combined.append(item.withKind(defaultKind))
                } else {
                    combined.append(item)
                }
            }
        }

        appendList(try? c.decodeIfPresent([PluginDescriptor].self, forKey: DynamicCodingKey("stages")), defaultKind: .stage)
        appendList(try? c.decodeIfPresent([PluginDescriptor].self, forKey: DynamicCodingKey("plugins")), defaultKind: nil)
        appendList(try? c.decodeIfPresent([PluginDescriptor].self, forKey: DynamicCodingKey("skills")), defaultKind: .skill)
        appendList(try? c.decodeIfPresent([PluginDescriptor].self, forKey: DynamicCodingKey("items")), defaultKind: nil)

        self.items = combined
    }
}

// MARK: - Formatting Helpers

enum Fmt {
    static func tokens(_ raw: Double) -> String {
        guard raw.isFinite else { return "0" }
        let absVal = abs(raw)
        if absVal < 0.5 { return "0" }
        let sign = raw < 0 ? "-" : ""
        if absVal >= 1_000_000 {
            let val = absVal / 1_000_000
            return "\(sign)\(val >= 10 ? String(format: "%.1f", val) : String(format: "%.2f", val))M"
        }
        if absVal >= 1_000 {
            let val = absVal / 1_000
            return "\(sign)\(val >= 100 ? String(format: "%.0f", val) : String(format: "%.1f", val))K"
        }
        return "\(sign)\(Int(absVal.rounded()))"
    }

    static func tokens(_ raw: Int) -> String {
        tokens(Double(raw))
    }

    /// Formats a token saving delta where >0 is reduction (`-1.2K`) and <0 is overhead (`+1.2K`).
    static func signedTokenDelta(_ raw: Double) -> String {
        guard raw.isFinite, abs(raw) >= 0.5 else { return "0" }
        let mag = tokens(abs(raw))
        return raw > 0 ? "-\(mag)" : "+\(mag)"
    }

    /// Formats a percentage saving delta where >0 is reduction (`-45%`) and <0 is overhead (`+12%`).
    static func signedPctDelta(_ raw: Double) -> String {
        guard raw.isFinite, abs(raw) >= 0.5 else { return "0%" }
        let mag = pct(abs(raw))
        return raw > 0 ? "-\(mag)" : "+\(mag)"
    }

    static func usd(_ raw: Double) -> String {
        guard raw.isFinite else { return "$0.00" }
        let absVal = abs(raw)
        if absVal == 0 { return "$0.00" }
        if absVal < 0.001 {
            return raw < 0 ? "-<$0.001" : "<$0.001"
        }
        let prefix = raw < 0 ? "-$" : "$"
        if absVal < 0.01 { return "\(prefix)\(String(format: "%.3f", absVal))" }
        if absVal < 100 { return "\(prefix)\(String(format: "%.2f", absVal))" }
        return "\(prefix)\(String(format: "%.1f", absVal))"
    }

    static func pct(_ raw: Double) -> String {
        if raw.isNaN || !raw.isFinite { return "0%" }
        let rounded = Int(raw.rounded())
        return "\(rounded)%"
    }

    static func uptime(_ seconds: Double?) -> String {
        guard let seconds, seconds >= 0, seconds.isFinite else { return "—" }
        let total = Int(seconds)
        let days = total / 86_400
        let hours = (total % 86_400) / 3_600
        let mins = (total % 3_600) / 60
        let secs = total % 60
        if days > 0 { return "\(days)d \(hours)h" }
        if hours > 0 { return "\(hours)h \(mins)m" }
        if mins > 0 { return "\(mins)m \(secs)s" }
        return "\(secs)s"
    }

    static func megabytes(_ bytes: Int64) -> String {
        let mb = Double(max(0, bytes)) / (1024.0 * 1024.0)
        if mb >= 100 { return String(format: "%.0f", mb) }
        if mb >= 10 { return String(format: "%.1f", mb) }
        return String(format: "%.1f", mb)
    }

    static func compactBytes(_ bytes: Int64) -> String {
        let clamped = max(0, bytes)
        if clamped < 1024 { return "\(clamped) B" }
        let kb = Double(clamped) / 1024.0
        if kb < 1024 { return String(format: "%.0f KB", kb) }
        let mb = kb / 1024.0
        if mb >= 10 { return String(format: "%.1f MB", mb) }
        return String(format: "%.2f MB", mb)
    }

    static func stageLabel(_ stage: String) -> String {
        switch stage.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "image", "optical", "microfiche": return "OPTICAL"
        case "hybrid_slab_optical": return "HYBRID"
        case "hybrid_tool_optical": return "TOOL OPTICAL"
        case "hybrid_user_optical": return "USER OPTICAL"
        case "dir_tree": return "DIR TREE"
        case "json", "json_compact": return "JSON"
        case "tscg": return "TSCG"
        case "schema_dag": return "DAG"
        case "toon": return "TOON"
        case "casi", "casi_delta", "casi_dup", "casi_slice": return "CASI"
        case "acdc", "acdc_epoch": return "ACDC"
        case "lsm_l1": return "L1"
        case "lsm_l2_cold": return "L2"
        case "mmu_page": return "MMU"
        case "mmu_hydrate": return "HYDRATE"
        case "markov_fold": return "MARKOV"
        case "skill_linker": return "SKILLS"
        case "density_prune": return "PRUNE"
        default: return stage.uppercased()
        }
    }

    static func compactModelName(_ model: String?) -> String {
        guard let model, !model.isEmpty else { return "No turns yet" }
        return model
            .replacingOccurrences(of: "claude-", with: "")
            .replacingOccurrences(of: "-202", with: " 202")
    }
}
