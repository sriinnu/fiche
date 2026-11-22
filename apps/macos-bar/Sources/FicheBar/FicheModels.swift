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

struct ModelStats: Decodable, Sendable, Equatable {
    let requests: Int
    let compressedRequests: Int
    let baselineInputWeighted: Double
    let actualInputWeighted: Double
    let savedInputTokens: Double
    let savedPct: Double
    let savedUsd: Double
    let cliffAvoidedEvents: Int
    let cliffSavedUsd: Double

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.requests = c.firstInt("requests", "turns", "count") ?? 0
        self.compressedRequests = c.firstInt("compressed_requests", "compressedRequests", "compressed") ?? 0
        let baseline = c.firstDouble("baseline_input_weighted", "baselineInputWeighted", "baseline_tokens", "baselineTokens") ?? 0
        let actual = c.firstDouble("actual_input_weighted", "actualInputWeighted", "actual_tokens", "actualTokens") ?? 0
        let saved = c.firstDouble("saved_input_tokens", "savedInputTokens", "saved_tokens", "savedTokens")
            ?? max(0, baseline - actual)
        self.baselineInputWeighted = baseline
        self.actualInputWeighted = actual
        self.savedInputTokens = saved
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
    let passthrough: Int
    let baselineInputWeighted: Double
    let actualInputWeighted: Double
    let savedInputTokens: Double
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

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        self.requests = c.firstInt("requests") ?? 0
        self.compressedRequests = c.firstInt("compressed_requests", "compressedRequests") ?? 0
        self.passthrough = c.firstInt("passthrough") ?? 0
        self.baselineInputWeighted = c.firstDouble("baseline_input_weighted", "baselineInputWeighted") ?? 0
        self.actualInputWeighted = c.firstDouble("actual_input_weighted", "actualInputWeighted") ?? 0
        self.savedInputTokens = c.firstDouble("saved_input_tokens", "savedInputTokens") ?? 0
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
        if raw > 0, savedTokens > 0 {
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

    init(id: String, label: String, family: String, hint: String? = nil) {
        self.id = id
        self.label = label
        self.family = family
        self.hint = hint
    }

    init(from decoder: Decoder) throws {
        if let single = try? decoder.singleValueContainer(), let idStr = try? single.decode(String.self) {
            self.id = idStr
            self.label = idStr
            self.family = ModelCatalogItem.inferFamily(for: idStr)
            self.hint = nil
            return
        }
        let c = try decoder.container(keyedBy: DynamicCodingKey.self)
        let id = c.firstString("id", "model", "name") ?? ""
        self.id = id
        self.label = c.firstString("label", "name", "displayName") ?? id
        self.family = c.firstString("family", "provider") ?? ModelCatalogItem.inferFamily(for: id)
        self.hint = c.firstString("hint", "mode", "description")
    }

    static func inferFamily(for id: String) -> String {
        let lower = id.lowercased()
        if lower.hasPrefix("claude") { return "Anthropic" }
        if lower.contains("gemini") { return "Google" }
        if lower.hasPrefix("gpt") || lower.hasPrefix("o1") || lower.hasPrefix("o3") || lower.hasPrefix("o4") {
            return "OpenAI"
        }
        if lower.hasPrefix("grok") { return "xAI" }
        if lower.hasPrefix("deepseek") { return "DeepSeek" }
        if lower.hasPrefix("kimi") { return "Moonshot" }
        if lower.hasPrefix("glm") { return "Zhipu" }
        return "Custom"
    }

    static let curatedDefaults: [ModelCatalogItem] = [
        ModelCatalogItem(id: "claude-fable-5", label: "Claude Fable 5", family: "Anthropic", hint: "Optical + 4-layer"),
        ModelCatalogItem(id: "claude-opus-5-5", label: "Claude Opus 5.5", family: "Anthropic", hint: "4-layer text"),
        ModelCatalogItem(id: "gemini", label: "Gemini (all)", family: "Google", hint: "Optical + 4-layer"),
        ModelCatalogItem(id: "gpt-6-astra", label: "GPT-6 Astra", family: "OpenAI", hint: "4-layer text"),
        ModelCatalogItem(id: "gpt-6.2-astra", label: "GPT-6.2 Astra", family: "OpenAI", hint: "4-layer text"),
        ModelCatalogItem(id: "gpt-6.1-sol", label: "GPT-6.1 Sol", family: "OpenAI", hint: "4-layer text"),
        ModelCatalogItem(id: "gpt-6.2-sol", label: "GPT-6.2 Sol", family: "OpenAI", hint: "4-layer text"),
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
        let sign = raw < 0 ? "-" : ""
        let absVal = abs(raw)
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

    static func usd(_ raw: Double) -> String {
        let absVal = abs(raw)
        let prefix = raw < 0 ? "-$" : "$"
        if absVal == 0 { return "$0.00" }
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

    static func stageLabel(_ stage: String) -> String {
        switch stage.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "image", "optical", "microfiche": return "OPTICAL"
        case "tscg": return "TSCG"
        case "toon": return "TOON"
        case "casi": return "CASI"
        case "acdc": return "ACDC"
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
