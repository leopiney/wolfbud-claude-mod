import Foundation

public enum ToolOutcome: Equatable, Sendable {
    case reply(String)
    case send(prompt: String, when: SendWhen, summary: String, session: String?)
    case stop(reason: String, session: String?)
    case activity(ActivityFocus, session: String?)
    case nextUpdate

    public static func interpret(name: String, parameters: [String: String]) -> ToolOutcome {
        func raw(_ key: String) -> String { parameters[key] ?? "" }
        func trimmed(_ key: String) -> String { raw(key).trimmingCharacters(in: .whitespacesAndNewlines) }
        switch name {
        case "wolfbud_send_to_claude":
            let prompt = trimmed("prompt")
            if prompt.isEmpty { return .reply("No prompt given: say what Claude should do in `prompt`.") }
            let session = trimmed("session")
            return .send(
                prompt: prompt,
                when: raw("when") == "now" ? .now : .afterCurrent,
                summary: raw("summary"),
                session: session.isEmpty ? nil : session
            )
        case "wolfbud_stop_claude":
            let session = trimmed("session")
            return .stop(reason: raw("reason"), session: session.isEmpty ? nil : session)
        case "wolfbud_next_update":
            return .nextUpdate
        case "wolfbud_claude_activity":
            let focus = ActivityFocus(rawValue: raw("focus")) ?? .overview
            let session = trimmed("session")
            return .activity(focus, session: session.isEmpty ? nil : session)
        default:
            return .reply("Unknown tool \(name).")
        }
    }
}

public struct CallEffects: Equatable, Sendable {
    public var userSpeaking = false
    public var userMessage: String?
    public var pendingContext: String?
    public var keepalive = false

    public init() {}
}

/// The call's timing: announcements, the silence keepalive, and the "you said you would" nudge.
/// The voice session and the hub stay outside, so this runs without a microphone.
public struct CallEngine: Equatable, Sendable {
    public static let vadSpeaking = 0.5
    public static let userHoldMs = 1_500.0
    public static let heartbeatMs = 25_000.0
    public static let watchdogDelayMs = 5_000.0
    public static let watchdogRetryMs = 2_000.0
    public static let nudgeGapMs = 15_000.0
    public static let nudge = "[continue] You said you would do something but did not call the tool. Call it now and carry on from its result."

    private static let promise = try! NSRegularExpression(
        pattern: #"(?i)\b(?:one (?:sec|second|moment)|let me (?:send|tell|pass|ask|check|look|pull)|i'?ll (?:send|tell|pass|ask|let claude)|sending (?:that|it)|passing (?:that|it))\b"#
    )

    public private(set) var announcements = AnnouncementQueue()
    public private(set) var isLive = false
    public private(set) var isSpeaking = false
    private var lastUserVoiceAt = 0.0
    private var lastMessageAt = 0.0
    private var lastToolAt = 0.0
    private var lastNudgeAt: Double?
    private var watchdogAt: Double?
    private var promisedAt = 0.0

    public init() {}

    public mutating func connected(now: Double) {
        isLive = true
        isSpeaking = true
        announcements.agentSpeaking(true, now: now)
        lastMessageAt = now
    }

    public mutating func ended() {
        isLive = false
        isSpeaking = false
        announcements.clear()
        watchdogAt = nil
        lastUserVoiceAt = 0
        lastToolAt = 0
    }

    public mutating func noteSpeaking(_ speaking: Bool, now: Double) {
        isSpeaking = speaking
        announcements.agentSpeaking(speaking, now: now)
    }

    public mutating func noteDraft(now: Double) {
        announcements.agentDrafting(now: now)
    }

    public mutating func noteAgentLine(_ text: String, now: Double) {
        announcements.agentReplied(now: now)
        armWatchdog(text, now: now)
    }

    public mutating func noteUserLine(now: Double) {
        lastUserVoiceAt = now
        announcements.userSpoke(now: now)
        announcements.replyOwed(now: now)
        watchdogAt = nil
    }

    public mutating func noteVad(_ score: Double, now: Double) {
        guard score >= Self.vadSpeaking else { return }
        lastUserVoiceAt = now
        announcements.userSpoke(now: now)
    }

    public mutating func touchTool(now: Double) {
        lastToolAt = now
        announcements.replyOwed(now: now)
        watchdogAt = nil
    }

    public mutating func announce(_ item: AnnouncementDraft, context: String, now: Double) -> [String] {
        guard isLive else { return [] }
        announcements.push(item, now: now)
        return [context, announcements.pendingNote()]
    }

    public mutating func pullNext(now: Double) -> (reply: String, pending: String) {
        let next = announcements.next(now: now) ?? "No updates are waiting."
        return (next, announcements.pendingNote())
    }

    public mutating func tick(now: Double) -> CallEffects {
        var effects = CallEffects()
        effects.userSpeaking = isUserSpeaking(now)
        guard isLive else { return effects }
        if let nudge = checkWatchdog(now: now) {
            effects.userMessage = nudge
            return effects
        }
        if let turn = announcements.take(now: now, isUserSpeaking: effects.userSpeaking) {
            lastMessageAt = now
            switch turn {
            case let .announce(text):
                effects.pendingContext = announcements.pendingNote()
                effects.userMessage = text
            case let .offer(text):
                effects.userMessage = text
            }
            return effects
        }
        if !isSpeaking, !effects.userSpeaking, now - lastMessageAt >= Self.heartbeatMs {
            lastMessageAt = now
            effects.keepalive = true
        }
        return effects
    }

    private func isUserSpeaking(_ now: Double) -> Bool {
        now - lastUserVoiceAt < Self.userHoldMs
    }

    private mutating func armWatchdog(_ said: String, now: Double) {
        watchdogAt = nil
        let range = NSRange(said.startIndex..., in: said)
        guard Self.promise.firstMatch(in: said, range: range) != nil else { return }
        promisedAt = now
        watchdogAt = now + Self.watchdogDelayMs
    }

    private mutating func checkWatchdog(now: Double) -> String? {
        guard let due = watchdogAt, now >= due else { return nil }
        if !isLive || lastToolAt > promisedAt || isUserSpeaking(now) {
            watchdogAt = nil
            return nil
        }
        if isSpeaking {
            watchdogAt = now + Self.watchdogRetryMs
            return nil
        }
        if let lastNudgeAt, now - lastNudgeAt < Self.nudgeGapMs {
            watchdogAt = nil
            return nil
        }
        lastNudgeAt = now
        lastMessageAt = now
        announcements.replyOwed(now: now)
        watchdogAt = nil
        return Self.nudge
    }
}
