import Foundation

/// After the agent goes quiet, the user gets this long to answer before the app says anything.
public let afterAgentMs = 2_500.0
/// A pause this long in the conversation on a topic is when the rest are offered.
public let offerAfterMs = 5_000.0
/// A topic nobody has talked about for this long is over: the next one is announced, not offered.
public let topicIdleMs = 20_000.0
/// An offer nobody took up lapses after this much silence.
public let offerHoldMs = 120_000.0
/// A reply the agent owes but never gives stops holding the queue after this long.
public let replyWaitMs = 15_000.0

public struct Announcement: Equatable, Sendable {
    public var text: String
    public var label: String
    public var kind: String
    public var at: Double

    public init(text: String, label: String, kind: String, at: Double) {
        self.text = text
        self.label = label
        self.kind = kind
        self.at = at
    }
}

public struct AnnouncementDraft: Equatable, Sendable {
    public var text: String
    public var label: String
    public var kind: String

    public init(text: String, label: String, kind: String) {
        self.text = text
        self.label = label
        self.kind = kind
    }
}

public enum AnnouncementTurn: Equatable, Sendable {
    case announce(String)
    case offer(String)
}

/// What WolfBud says out loud about Claude, and when. Pure and clocked by the caller.
public struct AnnouncementQueue: Equatable, Sendable {
    public private(set) var items: [Announcement] = []
    private var isSpeaking = false
    private var agentAt = 0.0
    private var userAt = 0.0
    private var owedSince: Double?
    private var topic: Announcement?
    private var offeredAt: Double?

    public init() {}

    public var size: Int { items.count }

    /// A newer one of the same kind replaces a waiting one and goes to the back.
    public mutating func push(_ item: AnnouncementDraft, now: Double) {
        items.removeAll { $0.kind == item.kind }
        items.append(Announcement(text: item.text, label: item.label, kind: item.kind, at: now))
    }

    public mutating func agentSpeaking(_ isSpeaking: Bool, now: Double) {
        self.isSpeaking = isSpeaking
        agentAt = now
    }

    public mutating func agentDrafting(now: Double) {
        agentAt = now
    }

    public mutating func agentReplied(now: Double) {
        owedSince = nil
        agentAt = now
    }

    public mutating func replyOwed(now: Double) {
        owedSince = now
    }

    public mutating func userSpoke(now: Double) {
        userAt = now
    }

    public func isFloorFree(now: Double) -> Bool {
        if isSpeaking { return false }
        if let owedSince, now - owedSince < replyWaitMs { return false }
        return now - agentAt >= afterAgentMs
    }

    public mutating func take(now: Double, isUserSpeaking: Bool) -> AnnouncementTurn? {
        if items.isEmpty || isUserSpeaking || !isFloorFree(now: now) { return nil }
        let quiet = now - max(agentAt, userAt)
        if offeredAt != nil {
            if quiet < offerHoldMs { return nil }
            offeredAt = nil
            topic = nil
        }
        if let topic, quiet < topicIdleMs {
            if quiet < offerAfterMs { return nil }
            offeredAt = now
            replyOwed(now: now)
            return .offer(offer(topic))
        }
        guard let next = next(now: now) else { return nil }
        replyOwed(now: now)
        return .announce(next)
    }

    public mutating func next(now: Double) -> String? {
        guard !items.isEmpty else { return nil }
        let item = items.removeFirst()
        topic = item
        offeredAt = nil
        let minutes = Int((now - item.at) / 60_000)
        let age = minutes >= 1 ? " (This happened \(minutes == 1 ? "a minute" : "\(minutes) minutes") ago.)" : ""
        let rest = items.count
        let after = rest == 0
            ? ""
            : " \(count(rest)) waiting after this one. Don't bring \(rest == 1 ? "it" : "them") up yet: the app will tell you when to offer \(rest == 1 ? "it" : "them")."
        return "\(item.text)\(age)\(after)"
    }

    public func pendingNote() -> String {
        if items.isEmpty { return "[claude activity] No updates are waiting to be told." }
        let labels = items.map(\.label).joined(separator: "; ")
        return "[claude activity] \(count(items.count)) waiting to be told: \(labels). Don't read them out on your own. When the user wants the next one, call wolfbud_next_update."
    }

    public mutating func clear() {
        items = []
        isSpeaking = false
        agentAt = 0
        userAt = 0
        owedSince = nil
        topic = nil
        offeredAt = nil
    }

    private func offer(_ topic: Announcement) -> String {
        let rest = items.count
        let labels = items.map(\.label).joined(separator: "; ")
        return "[pending updates] \(count(rest)) waiting: \(labels). Ask the user in one short sentence whether to go through \(rest == 1 ? "it" : "them") now or stay on \(topic.label) first. Don't read \(rest == 1 ? "it" : "them") out yet. If they want \(rest == 1 ? "it" : "them"), call wolfbud_next_update."
    }
}

private func count(_ n: Int) -> String {
    n == 1 ? "One more update is" : "\(n) more updates are"
}
