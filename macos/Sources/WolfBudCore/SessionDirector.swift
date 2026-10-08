import Foundation

public struct ContextNote: Equatable, Sendable {
    public var text: String
    /// The web client replaces the previous update under this id. The Swift SDK cannot, yet.
    public var contextID: String?

    public init(text: String, contextID: String? = nil) {
        self.text = text
        self.contextID = contextID
    }
}

public struct AgentUpdate: Equatable, Sendable {
    public var contexts: [ContextNote]
    public var announcement: AnnouncementDraft?
    public var announcementContext: String?
    public var activityDue: Bool

    public static let empty = AgentUpdate(contexts: [], announcement: nil, announcementContext: nil, activityDue: false)
}

/// The roster and what the voice agent should hear about it. The hub owns busy and badge.
public struct SessionDirector: Equatable, Sendable {
    public var sessions: [TrackedSession] = []
    public var focusedID: String?
    public var announce = true
    public var isLive = false
    public var activityDueAt: Double?
    public static let recentLimit = 150
    public static let activityDelayMs = 2_500.0

    public init() {}

    public var focused: TrackedSession? {
        sessions.first { $0.id == focusedID }
    }

    public mutating func applyHello(_ hello: Hello, now: Double) -> [ContextNote] {
        let previous = focusedID
        sessions = hello.rows.map { incoming in
            TrackedSession(
                row: incoming.row,
                events: Array(incoming.recent.suffix(Self.recentLimit)),
                snapshot: incoming.snapshot,
                busySince: incoming.row.isBusy ? now : 0
            )
        }
        focusedID = hello.focusedID
        guard isLive, previous != focusedID else { return [] }
        return brief(withSnapshot: true)
    }

    public mutating func applyRoster(focusedID: String?, rows: [RosterRow], now: Double) -> [ContextNote] {
        let previous = self.focusedID
        sessions = rows.map { row in
            let current = sessions.first { $0.id == row.id }
            let becameBusy = row.isBusy && current?.row.isBusy != true
            let busySince = becameBusy ? now : (row.isBusy ? (current?.busySince ?? now) : 0)
            return TrackedSession(
                row: row,
                events: current?.events ?? [],
                snapshot: current?.snapshot ?? "",
                busySince: busySince
            )
        }
        self.focusedID = focusedID
        guard isLive, previous != focusedID else { return [] }
        return brief(withSnapshot: true)
    }

    public mutating func ingest(_ message: SessionEvent, now: Double) -> AgentUpdate {
        guard let index = sessions.firstIndex(where: { $0.id == message.sessionID }) else { return .empty }
        sessions[index].events.append(message.event)
        if sessions[index].events.count > Self.recentLimit {
            sessions[index].events.removeFirst(sessions[index].events.count - Self.recentLimit)
        }
        guard isLive else { return .empty }
        return tellAgent(at: index, event: message.event, now: now)
    }

    public mutating func applySnapshot(sessionID: String, text: String) -> ContextNote? {
        guard let index = sessions.firstIndex(where: { $0.id == sessionID }) else { return nil }
        sessions[index].snapshot = text
        guard isLive, sessionID == focusedID else { return nil }
        return ContextNote(text: text, contextID: "session_snapshot")
    }

    public func brief(withSnapshot: Bool) -> [ContextNote] {
        guard isLive else { return [] }
        var notes = [ContextNote(text: SessionText.rosterUpdate(sessions: sessions, focusedID: focusedID), contextID: "wolfbud_roster")]
        guard let row = focused else { return notes }
        notes.append(ContextNote(text: SessionText.activityUpdate(row.events, isBusy: row.row.isBusy), contextID: "claude_activity"))
        if withSnapshot, !row.snapshot.isEmpty {
            notes.append(ContextNote(text: row.snapshot, contextID: "session_snapshot"))
        }
        return notes
    }

    public mutating func flushActivity(now: Double) -> ContextNote? {
        guard let due = activityDueAt, now >= due, isLive, let row = focused else { return nil }
        activityDueAt = nil
        return ContextNote(text: SessionText.activityUpdate(row.events, isBusy: row.row.isBusy), contextID: "claude_activity")
    }

    public func feedLines() -> [FeedLine] {
        (focused?.events ?? []).compactMap(SessionText.feedLine)
    }

    private mutating func tellAgent(at index: Int, event: ClaudeEvent, now: Double) -> AgentUpdate {
        let row = sessions[index]
        let isFocused = row.id == focusedID
        var contexts: [ContextNote] = []
        if isFocused, let update = SessionText.promptUpdate(event) {
            contexts.append(ContextNote(text: update))
        }
        let spoken = isFocused ? SessionText.spokenEvent(event) : SessionText.sessionSpoken(event, name: row.row.name)
        var announcement: AnnouncementDraft?
        var announcementContext: String?
        if let spoken, announce || !isFocused {
            announcement = AnnouncementDraft(text: spoken, label: SessionText.eventLabel(event, name: row.row.name), kind: "\(row.id):\(event.kind)")
            announcementContext = SessionText.quietOf(spoken)
        } else if isFocused, let quiet = SessionText.quietEvent(event) {
            contexts.append(ContextNote(text: quiet))
        }
        var activityDue = false
        if isFocused {
            activityDueAt = now + Self.activityDelayMs
            activityDue = true
        }
        return AgentUpdate(contexts: contexts, announcement: announcement, announcementContext: announcementContext, activityDue: activityDue)
    }
}
