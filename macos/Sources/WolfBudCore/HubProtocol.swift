import Foundation

public enum PromptSource: String, Codable, Equatable, Sendable {
    case user
    case wolfbud
}

public enum ToolStatus: String, Codable, Equatable, Sendable {
    case ok
    case error
    case denied
}

public enum TurnReason: String, Codable, Equatable, Sendable {
    case answer
    case aborted
    case refusal
    case error
}

public struct ToolStep: Equatable, Sendable {
    public var at: Double
    public var tool: String
    public var detail: String
    public var status: ToolStatus
    public var error: String?
    public var isSubagent: Bool

    public init(at: Double, tool: String, detail: String, status: ToolStatus, error: String? = nil, isSubagent: Bool = false) {
        self.at = at
        self.tool = tool
        self.detail = detail
        self.status = status
        self.error = error
        self.isSubagent = isSubagent
    }
}

public struct TurnComplete: Equatable, Sendable {
    public var at: Double
    public var answer: String
    public var reason: TurnReason
    public var durationMs: Double

    public init(at: Double, answer: String, reason: TurnReason, durationMs: Double) {
        self.at = at
        self.answer = answer
        self.reason = reason
        self.durationMs = durationMs
    }
}

/// One thing that happened in a Claude session, as the window hears it.
public enum ClaudeEvent: Equatable, Sendable {
    case prompt(at: Double, text: String, from: PromptSource)
    case turnStart(at: Double)
    case tool(ToolStep)
    case turnComplete(TurnComplete)
    case notification(at: Double, message: String, type: String)

    public var at: Double {
        switch self {
        case let .prompt(at, _, _), let .turnStart(at), let .notification(at, _, _):
            at
        case let .tool(step):
            step.at
        case let .turnComplete(turn):
            turn.at
        }
    }

    public var kind: String {
        switch self {
        case .prompt: "prompt"
        case .turnStart: "turn-start"
        case .tool: "tool"
        case .turnComplete: "turn-complete"
        case .notification: "notification"
        }
    }
}

public struct RosterRow: Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var project: String
    public var isBusy: Bool
    public var badge: Int
    public var isRemote: Bool
    public var host: String

    public init(id: String, name: String, project: String, isBusy: Bool, badge: Int, isRemote: Bool, host: String) {
        self.id = id
        self.name = name
        self.project = project
        self.isBusy = isBusy
        self.badge = badge
        self.isRemote = isRemote
        self.host = host
    }
}

public struct TrackedSession: Equatable, Sendable, Identifiable {
    public var row: RosterRow
    public var events: [ClaudeEvent]
    public var snapshot: String
    public var busySince: Double

    public var id: String { row.id }

    public init(row: RosterRow, events: [ClaudeEvent] = [], snapshot: String = "", busySince: Double = 0) {
        self.row = row
        self.events = events
        self.snapshot = snapshot
        self.busySince = busySince
    }
}

public struct HelloRow: Equatable, Sendable {
    public var row: RosterRow
    public var recent: [ClaudeEvent]
    public var snapshot: String

    public init(row: RosterRow, recent: [ClaudeEvent], snapshot: String) {
        self.row = row
        self.recent = recent
        self.snapshot = snapshot
    }
}

public struct Hello: Equatable, Sendable {
    public var focusedID: String?
    public var rows: [HelloRow]

    public init(focusedID: String?, rows: [HelloRow]) {
        self.focusedID = focusedID
        self.rows = rows
    }
}

public struct RosterPayload: Equatable, Sendable {
    public var focusedID: String?
    public var rows: [RosterRow]

    public init(focusedID: String?, rows: [RosterRow]) {
        self.focusedID = focusedID
        self.rows = rows
    }
}

public struct SessionEvent: Equatable, Sendable {
    public var sessionID: String
    public var event: ClaudeEvent

    public init(sessionID: String, event: ClaudeEvent) {
        self.sessionID = sessionID
        self.event = event
    }
}

public enum WindowCommand: String, Equatable, Sendable {
    case startCall = "start-call"
    case endCall = "end-call"
    case raise
    case superseded
}

public enum HubStreamEvent: Equatable, Sendable {
    case hello(Hello)
    case roster(RosterPayload)
    case claude(SessionEvent)
    case snapshot(sessionID: String, text: String)
    case command(WindowCommand)
    case bye
}

public enum CallPhase: String, Equatable, Sendable {
    case idle
    case connecting
    case live
    case error
}

public enum VoiceMode: String, Equatable, Sendable {
    case speaking
    case listening
}

public enum SendWhen: String, Equatable, Sendable {
    case now
    case afterCurrent = "after_current"
}

enum HubDecoding {
    static func event(from data: Data) throws -> ClaudeEvent {
        try decoder.decode(EventBox.self, from: data).event
    }

    static func streamEvent(named name: String, data: Data) throws -> HubStreamEvent? {
        switch name {
        case "hello":
            .hello(try decoder.decode(Hello.self, from: data))
        case "roster":
            .roster(try decoder.decode(RosterBox.self, from: data).payload)
        case "claude":
            .claude(try decoder.decode(ClaudeBox.self, from: data).message)
        case "snapshot":
            try decodeSnapshot(data)
        case "command":
            WindowCommand(rawValue: try decoder.decode(CommandBox.self, from: data).cmd).map(HubStreamEvent.command)
        case "bye":
            .bye
        default:
            nil
        }
    }

    private static let decoder = JSONDecoder()

    private static func decodeSnapshot(_ data: Data) throws -> HubStreamEvent {
        let box = try decoder.decode(SnapshotBox.self, from: data)
        return .snapshot(sessionID: box.sessionId, text: box.text)
    }
}

private struct EventBox: Decodable {
    var event: ClaudeEvent

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let kind = try c.decode(String.self, forKey: .kind)
        let at = try c.decode(Double.self, forKey: .at)
        switch kind {
        case "prompt":
            event = .prompt(at: at, text: try c.decode(String.self, forKey: .text), from: try c.decode(PromptSource.self, forKey: .from))
        case "turn-start":
            event = .turnStart(at: at)
        case "tool":
            event = .tool(ToolStep(
                at: at,
                tool: try c.decode(String.self, forKey: .tool),
                detail: try c.decodeIfPresent(String.self, forKey: .detail) ?? "",
                status: try c.decode(ToolStatus.self, forKey: .status),
                error: try c.decodeIfPresent(String.self, forKey: .error),
                isSubagent: try c.decodeIfPresent(Bool.self, forKey: .isSubagent) ?? false
            ))
        case "turn-complete":
            event = .turnComplete(TurnComplete(
                at: at,
                answer: try c.decodeIfPresent(String.self, forKey: .answer) ?? "",
                reason: try c.decode(TurnReason.self, forKey: .reason),
                durationMs: try c.decode(Double.self, forKey: .durationMs)
            ))
        case "notification":
            event = .notification(at: at, message: try c.decode(String.self, forKey: .message), type: try c.decodeIfPresent(String.self, forKey: .type) ?? "")
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown event kind \(kind)")
        }
    }

    enum Key: String, CodingKey {
        case kind, at, text, from, tool, detail, status, error, isSubagent, answer, reason, durationMs, message, type
    }
}

extension ClaudeEvent: Decodable {
    public init(from decoder: Decoder) throws {
        self = try EventBox(from: decoder).event
    }
}

private struct RowBox: Decodable {
    var row: RosterRow

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        row = RosterRow(
            id: try c.decode(String.self, forKey: .id),
            name: try c.decode(String.self, forKey: .name),
            project: try c.decode(String.self, forKey: .project),
            isBusy: try c.decodeIfPresent(Bool.self, forKey: .isBusy) ?? false,
            badge: try c.decodeIfPresent(Int.self, forKey: .badge) ?? 0,
            isRemote: try c.decodeIfPresent(Bool.self, forKey: .isRemote) ?? false,
            host: try c.decodeIfPresent(String.self, forKey: .host) ?? ""
        )
    }

    enum Key: String, CodingKey {
        case id, name, project, isBusy, badge, isRemote, host
    }
}

private struct HelloRowBox: Decodable {
    var row: HelloRow

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        let base = try RowBox(from: decoder).row
        row = HelloRow(
            row: base,
            recent: try c.decodeIfPresent([ClaudeEvent].self, forKey: .recent) ?? [],
            snapshot: try c.decodeIfPresent(String.self, forKey: .snapshot) ?? ""
        )
    }

    enum Key: String, CodingKey { case recent, snapshot }
}

extension Hello: Decodable {
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        focusedID = try c.decodeIfPresent(String.self, forKey: .focusedId)
        var raw = try c.nestedUnkeyedContainer(forKey: .rows)
        var decoded: [HelloRow] = []
        while !raw.isAtEnd {
            decoded.append(try raw.decode(HelloRowBox.self).row)
        }
        rows = decoded
    }

    enum Key: String, CodingKey { case focusedId, rows }
}

private struct RosterBox: Decodable {
    var payload: RosterPayload

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        var raw = try c.nestedUnkeyedContainer(forKey: .rows)
        var rows: [RosterRow] = []
        while !raw.isAtEnd {
            rows.append(try raw.decode(RowBox.self).row)
        }
        payload = RosterPayload(focusedID: try c.decodeIfPresent(String.self, forKey: .focusedId), rows: rows)
    }

    enum Key: String, CodingKey { case focusedId, rows }
}

private struct ClaudeBox: Decodable {
    var message: SessionEvent

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Key.self)
        message = SessionEvent(sessionID: try c.decode(String.self, forKey: .sessionId), event: try c.decode(ClaudeEvent.self, forKey: .event))
    }

    enum Key: String, CodingKey { case sessionId, event }
}

private struct SnapshotBox: Decodable {
    var sessionId: String
    var text: String
}

private struct CommandBox: Decodable {
    var cmd: String
}
