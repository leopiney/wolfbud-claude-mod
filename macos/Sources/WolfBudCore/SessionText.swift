import Foundation

public enum ActivityFocus: String, Equatable, Sendable {
    case lastAnswer = "last_answer"
    case recentSteps = "recent_steps"
    case errors
    case overview
}

public enum FeedTone: Equatable, Sendable {
    case ok
    case bad
    case info
}

public enum FeedSymbol: Equatable, Sendable {
    case wolf
    case prompt
    case ok
    case bad
    case done
    case notice
}

public struct FeedLine: Equatable, Sendable, Identifiable {
    public var id: String
    public var symbol: FeedSymbol
    public var text: String
    public var tone: FeedTone

    public init(id: String, symbol: FeedSymbol, text: String, tone: FeedTone) {
        self.id = id
        self.symbol = symbol
        self.text = text
        self.tone = tone
    }
}

public enum SessionText {
    public static func clip(_ text: String, max: Int) -> String {
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard flat.count > max else { return flat }
        return String(flat.prefix(max - 1)) + "…"
    }

    public static func stepLine(_ event: ToolStep) -> String {
        let who = event.isSubagent ? "a subagent ran " : ""
        let detail = event.detail.isEmpty ? "" : " (\(event.detail))"
        let what = "\(who)\(event.tool)\(detail)"
        switch event.status {
        case .denied:
            return "\(what): blocked\(event.error.map { ", \(clip($0, max: 160))" } ?? "")"
        case .error:
            return "\(what): failed\(event.error.map { ", \(clip($0, max: 220))" } ?? "")"
        case .ok:
            return what
        }
    }

    public static func activityUpdate(_ events: [ClaudeEvent], isBusy: Bool) -> String {
        let turn = currentTurn(events)
        let steps = turn.compactMap(tool)
        let prompt = lastPrompt(events)
        let failed = steps.filter { $0.status != .ok }.count
        let head: String
        if isBusy {
            let on = prompt.map { " on: \"\(clip($0.text, max: 300))\"" } ?? ""
            let fail = failed > 0 ? ", \(failed) failed" : ""
            head = "[claude activity] Claude is working\(on). \(steps.count) steps so far\(fail)."
        } else {
            head = "[claude activity] Claude is idle, waiting for the user."
        }
        if steps.isEmpty { return head }
        return "\(head) Latest steps, oldest first: \(steps.suffix(8).map(stepLine).joined(separator: "; "))."
    }

    public static func promptUpdate(_ event: ClaudeEvent) -> String? {
        guard case let .prompt(_, text, from) = event, from == .user else { return nil }
        return "[claude activity] The user typed a new prompt to Claude in the terminal: \"\(clip(text, max: 600))\""
    }

    public static func spokenEvent(_ event: ClaudeEvent) -> String? {
        switch event {
        case let .turnComplete(turn):
            let how: String
            switch turn.reason {
            case .answer: how = "finished its task"
            case .aborted: how = "was interrupted"
            case .refusal, .error: how = "stopped (\(turn.reason.rawValue))"
            }
            let answer = turn.answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "It left no final message."
                : "Its final message: \"\(clip(turn.answer, max: 900))\""
            return "[claude event] Claude \(how) after \(seconds(turn.durationMs)). \(answer) Tell the user the gist in one short sentence."
        case let .notification(_, message, type):
            if type == "clear" { return nil }
            if type.range(of: "permission", options: .caseInsensitive) != nil
                || message.range(of: "permission", options: .caseInsensitive) != nil {
                return "[claude event] Claude is waiting for the user's permission: \"\(clip(message, max: 200))\". Let them know in one short sentence."
            }
            if type.range(of: "idle", options: .caseInsensitive) != nil { return nil }
            return "[claude event] Claude Code says: \"\(clip(message, max: 200))\". Mention it in one short sentence if it matters."
        default:
            return nil
        }
    }

    public static func sessionSpoken(_ event: ClaudeEvent, name: String) -> String? {
        spokenEvent(event)?.replacingOccurrences(of: "[claude event]", with: "[session event] \(name):")
    }

    public static func quietEvent(_ event: ClaudeEvent) -> String? {
        if case let .notification(_, message, type) = event, type == "clear" {
            return "[claude activity] \(message)"
        }
        guard let spoken = spokenEvent(event) else { return nil }
        return quietOf(spoken)
    }

    public static func eventLabel(_ event: ClaudeEvent, name: String) -> String {
        switch event {
        case let .turnComplete(turn):
            switch turn.reason {
            case .answer: return "\(name) finished a task"
            case .aborted: return "\(name) was interrupted"
            case .refusal, .error: return "\(name) stopped"
            }
        case let .notification(_, message, type):
            if type.range(of: "permission", options: .caseInsensitive) != nil
                || message.range(of: "permission", options: .caseInsensitive) != nil {
                return "\(name) is waiting for permission"
            }
            return "\(name) has a notice"
        default:
            return "\(name) has a notice"
        }
    }

    public static func quietOf(_ spoken: String) -> String {
        var text = spoken
        if text.hasPrefix("[claude event]") {
            text = "[claude activity]" + text.dropFirst("[claude event]".count)
        } else if text.hasPrefix("[session event]") {
            text = "[claude activity]" + text.dropFirst("[session event]".count)
        }
        if let range = text.range(of: #" (Tell|Let|Mention) [^.]*\.$"#, options: .regularExpression) {
            text.removeSubrange(range)
        }
        return text
    }

    public static func activityAnswer(focus: ActivityFocus, events: [ClaudeEvent], isBusy: Bool, snapshot: String, now: Double) -> String {
        let steps = events.compactMap(tool)
        switch focus {
        case .lastAnswer:
            if let answer = lastAnswer(events) {
                let body = clip(answer.answer, max: 2500)
                return "Claude's latest final message (\(seconds(now - answer.at)) ago): \(body.isEmpty ? "(empty)" : body)"
            }
            return snapshot.isEmpty
                ? "Claude has not finished a task in this session yet."
                : "No task has finished since the call started. From the session snapshot:\n\(snapshot)"
        case .recentSteps:
            return steps.isEmpty
                ? "Claude has not run any tools yet."
                : "Claude's latest steps, oldest first:\n\(steps.suffix(15).map(stepLine).joined(separator: "\n"))"
        case .errors:
            let failed = steps.filter { $0.status != .ok }
            return failed.isEmpty
                ? "No failed steps recently."
                : "Recent failed steps, oldest first:\n\(failed.suffix(8).map(stepLine).joined(separator: "\n"))"
        case .overview:
            let prompt = lastPrompt(events)
            let answer = lastAnswer(events)
            let turn = currentTurn(events).compactMap(tool).count
            return [
                isBusy ? "Claude is working (\(turn) steps into the current task)." : "Claude is idle.",
                prompt.map { "Latest prompt (\($0.from == .wolfbud ? "sent by you" : "typed by the user")): \"\(clip($0.text, max: 600))\"" } ?? "",
                answer.map { "Latest final message: \"\(clip($0.answer, max: 800))\"" } ?? "",
                snapshot,
            ].filter { !$0.isEmpty }.joined(separator: "\n")
        }
    }

    public static func feedLine(_ event: ClaudeEvent) -> FeedLine? {
        switch event {
        case let .prompt(at, text, from):
            return FeedLine(id: "\(at)-prompt-\(text)", symbol: from == .wolfbud ? .wolf : .prompt, text: clip(text, max: 90), tone: .info)
        case .turnStart:
            return nil
        case let .tool(step):
            let detail = step.detail.isEmpty ? "" : " · \(step.detail)"
            return FeedLine(
                id: "\(step.at)-tool-\(step.tool)",
                symbol: step.status == .ok ? .ok : .bad,
                text: clip("\(step.tool)\(detail)", max: 90),
                tone: step.status == .ok ? .ok : .bad
            )
        case let .turnComplete(turn):
            let text = turn.answer.isEmpty ? "turn \(turn.reason.rawValue)" : turn.answer
            return FeedLine(id: "\(turn.at)-done", symbol: .done, text: clip(text, max: 90), tone: turn.reason == .answer ? .info : .bad)
        case let .notification(at, message, _):
            return FeedLine(id: "\(at)-note-\(message)", symbol: .notice, text: clip(message, max: 90), tone: .bad)
        }
    }

    public static func rosterUpdate(sessions: [TrackedSession], focusedID: String?) -> String {
        if sessions.isEmpty { return "[claude activity] No Claude session is subscribed." }
        let bits = sessions.map { session -> String in
            let focus = session.id == focusedID ? " (focused)" : ""
            let busy = session.row.isBusy ? ", working" : ", idle"
            let where_ = session.row.isRemote ? ", remote on \(session.row.host.isEmpty ? "another machine" : session.row.host)" : ", on this machine"
            return "\(session.row.name)\(focus)\(busy)\(where_)"
        }
        return "[claude activity] Subscribed Claude sessions: \(bits.joined(separator: "; ")). Tools default to the focused one. Pass session to reach another."
    }

    public static func dynamicVariables(sessions: [TrackedSession], focusedID: String?) -> [String: String] {
        let focused = sessions.first { $0.id == focusedID }
        let names = sessions.map(\.row.name).joined(separator: ", ")
        return [
            "project_name": focused?.row.project ?? "the current project",
            "focused_session": focused?.row.name ?? "none",
            "session_names": names.isEmpty ? "none" : names,
        ]
    }

    public static func activityTool(focus: ActivityFocus, session: String?, sessions: [TrackedSession], focusedID: String?, now: Double) -> String {
        let row = named(session, sessions: sessions, focusedID: focusedID)
        guard let row else {
            let names = sessions.map(\.row.name).joined(separator: ", ")
            let listed = names.isEmpty ? "none" : names
            if let session, !session.isEmpty {
                return "No Claude session named \(session). Subscribed: \(listed)."
            }
            return "No Claude session is subscribed."
        }
        let answer = activityAnswer(focus: focus, events: row.events, isBusy: row.row.isBusy, snapshot: row.snapshot, now: now)
        return "Session \(row.row.name) (\(row.row.project)).\n\(answer)"
    }

    public static func chip(name: String?, isBusy: Bool, busySince: Double, now: Double) -> String {
        let name = name ?? "no session"
        guard isBusy else { return "\(name) · Claude is idle" }
        let seconds = Int((now - busySince) / 1000)
        let clock = seconds < 60 ? "\(seconds)s" : "\(seconds / 60)m \(seconds % 60)s"
        return "\(name) · Claude is working · \(clock)"
    }

    private static func seconds(_ ms: Double) -> String {
        let s = Int((ms / 1000).rounded())
        return s < 90 ? "\(s)s" : "\(Int((Double(s) / 60).rounded())) min"
    }

    private static func currentTurn(_ events: [ClaudeEvent]) -> ArraySlice<ClaudeEvent> {
        guard let start = events.lastIndex(where: { if case .turnStart = $0 { true } else { false } }) else {
            return events[...]
        }
        return events[start...]
    }

    private static func lastPrompt(_ events: [ClaudeEvent]) -> (text: String, from: PromptSource)? {
        for event in events.reversed() {
            if case let .prompt(_, text, from) = event { return (text, from) }
        }
        return nil
    }

    private static func lastAnswer(_ events: [ClaudeEvent]) -> TurnComplete? {
        for event in events.reversed() {
            if case let .turnComplete(turn) = event { return turn }
        }
        return nil
    }

    private static func tool(_ event: ClaudeEvent) -> ToolStep? {
        if case let .tool(step) = event { return step }
        return nil
    }

    private static func named(_ name: String?, sessions: [TrackedSession], focusedID: String?) -> TrackedSession? {
        guard let name, !name.isEmpty else {
            return sessions.first { $0.id == focusedID }
        }
        return sessions.first { $0.row.name.lowercased() == name.lowercased() }
    }
}
