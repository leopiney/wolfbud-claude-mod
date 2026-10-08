import Foundation
import Testing
@testable import WolfBudCore

@Test func queueReplacesTheSameKindAndSpeaksTheOldest() {
    var queue = AnnouncementQueue()
    queue.push(AnnouncementDraft(text: "first", label: "one", kind: "a"), now: 0)
    queue.push(AnnouncementDraft(text: "second", label: "two", kind: "b"), now: 10)
    queue.push(AnnouncementDraft(text: "first again", label: "one", kind: "a"), now: 20)
    #expect(queue.size == 2)
    #expect(queue.items.map(\.text) == ["second", "first again"])

    queue.agentSpeaking(false, now: 0)
    let turn = queue.take(now: afterAgentMs, isUserSpeaking: false)
    #expect(turn == .announce("second" + countWait(1)))
}

@Test func queueHoldsTheFloorWhileTheAgentOwesAReply() {
    var queue = AnnouncementQueue()
    queue.push(AnnouncementDraft(text: "news", label: "news", kind: "a"), now: 0)
    queue.agentSpeaking(false, now: 0)
    queue.replyOwed(now: 1_000)
    #expect(queue.take(now: 1_000 + afterAgentMs, isUserSpeaking: false) == nil)
    queue.agentReplied(now: 2_000)
    #expect(queue.take(now: 2_000 + afterAgentMs, isUserSpeaking: false) != nil)
}

@Test func queueOffersTheRestAfterAPause() {
    var queue = AnnouncementQueue()
    queue.push(AnnouncementDraft(text: "first event", label: "shop finished a task", kind: "a"), now: 0)
    queue.push(AnnouncementDraft(text: "second event", label: "shop is waiting for permission", kind: "b"), now: 0)
    queue.agentSpeaking(false, now: 0)
    _ = queue.take(now: afterAgentMs, isUserSpeaking: false)
    queue.agentReplied(now: 3_000)
    let offer = queue.take(now: 3_000 + offerAfterMs, isUserSpeaking: false)
    guard case let .offer(text) = offer else {
        Issue.record("expected an offer, got \(String(describing: offer))")
        return
    }
    #expect(text.contains("shop is waiting for permission"))
    #expect(text.contains("wolfbud_next_update"))
    #expect(queue.take(now: 3_000 + offerAfterMs + 1_000, isUserSpeaking: false) == nil)
}

@Test func spokenEventsAndQuietContextMatchTheWebWording() {
    let done = ClaudeEvent.turnComplete(TurnComplete(at: 0, answer: "shipped it", reason: .answer, durationMs: 12_000))
    let spoken = SessionText.spokenEvent(done)
    #expect(spoken == "[claude event] Claude finished its task after 12s. Its final message: \"shipped it\" Tell the user the gist in one short sentence.")
    #expect(SessionText.quietOf(spoken ?? "") == "[claude activity] Claude finished its task after 12s. Its final message: \"shipped it\"")
    #expect(SessionText.eventLabel(done, name: "shop") == "shop finished a task")

    let permission = ClaudeEvent.notification(at: 1, message: "Allow rm", type: "permission")
    #expect(SessionText.spokenEvent(permission)?.contains("waiting for the user's permission") == true)
    #expect(SessionText.sessionSpoken(done, name: "api")?.hasPrefix("[session event] api:") == true)
    #expect(SessionText.promptUpdate(.prompt(at: 1, text: "fix the bug", from: .wolfbud)) == nil)
    #expect(SessionText.feedLine(.turnStart(at: 1)) == nil)
}

@Test func activityAnswerUsesTheClockItIsGiven() {
    let events = [
        ClaudeEvent.turnComplete(TurnComplete(at: 1_000, answer: "done", reason: .answer, durationMs: 1_000)),
    ]
    let text = SessionText.activityAnswer(focus: .lastAnswer, events: events, isBusy: false, snapshot: "", now: 4_000)
    #expect(text == "Claude's latest final message (3s ago): done")
}

@Test func toolCallsParseTheWayTheAgentSendsThem() {
    let missing = ToolOutcome.interpret(name: "wolfbud_send_to_claude", parameters: ["prompt": "  "])
    #expect(missing == .reply("No prompt given: say what Claude should do in `prompt`."))
    let send = ToolOutcome.interpret(name: "wolfbud_send_to_claude", parameters: [
        "prompt": " rename the button ",
        "when": "now",
        "summary": "rename",
        "session": "shop",
    ])
    #expect(send == .send(prompt: "rename the button", when: .now, summary: "rename", session: "shop"))
    let focus = ToolOutcome.interpret(name: "wolfbud_claude_activity", parameters: ["focus": "errors"])
    #expect(focus == .activity(.errors, session: nil))
}

@Test func watchdogNudgesAPromiseAndStopsAfterATool() {
    var engine = CallEngine()
    engine.connected(now: 0)
    engine.noteSpeaking(false, now: 0)
    engine.noteAgentLine("I'll send that to Claude.", now: 1_000)
    let tooSoon = engine.tick(now: 1_000 + CallEngine.watchdogDelayMs - 1)
    #expect(tooSoon.userMessage == nil)
    let nudge = engine.tick(now: 1_000 + CallEngine.watchdogDelayMs)
    #expect(nudge.userMessage == CallEngine.nudge)

    engine.noteAgentLine("Let me send that.", now: 20_000)
    engine.touchTool(now: 21_000)
    let quiet = engine.tick(now: 20_000 + CallEngine.watchdogDelayMs)
    #expect(quiet.userMessage == nil)
}

@Test func directorAnnouncesAFinishedTaskAndKeepsAnotherSessionAudible() {
    var director = SessionDirector()
    director.announce = true
    director.isLive = true
    let shop = RosterRow(id: "1", name: "shop", project: "shop", isBusy: false, badge: 0, isRemote: false, host: "")
    let api = RosterRow(id: "2", name: "api", project: "api", isBusy: false, badge: 0, isRemote: true, host: "mini")
    _ = director.applyRoster(focusedID: "1", rows: [shop, api], now: 0)
    let done = ClaudeEvent.turnComplete(TurnComplete(at: 5, answer: "ok", reason: .answer, durationMs: 1_000))
    let focused = director.ingest(SessionEvent(sessionID: "1", event: done), now: 10)
    #expect(focused.announcement?.kind == "1:turn-complete")
    #expect(focused.announcementContext?.hasPrefix("[claude activity]") == true)

    director.announce = false
    let other = director.ingest(SessionEvent(sessionID: "2", event: done), now: 20)
    #expect(other.announcement?.text.hasPrefix("[session event] api:") == true)
}

@Test func sseAndHelloDecodeTheHubWireFormat() throws {
    var parser = SSEParser()
    #expect(parser.feed(": ping") == nil)
    #expect(parser.feed("event: hello") == nil)
    let payload = #"{"focusedId":"1","rows":[{"id":"1","name":"shop","project":"shop","isBusy":true,"badge":2,"isRemote":false,"host":"","recent":[{"kind":"prompt","at":4,"text":"hi","from":"user"}],"snapshot":"tree"}]}"#
    #expect(parser.feed("data: \(payload)") == nil)
    // `#require` wraps its argument in a non-mutating closure, so the
    // mutating `feed` has to run first.
    let flushed = parser.feed("")
    let event = try #require(flushed)
    let decoded = try #require(HubStreamDecoding.decode(event))
    guard case let .hello(hello) = decoded else {
        Issue.record("expected hello")
        return
    }
    #expect(hello.focusedID == "1")
    #expect(hello.rows.first?.row.isBusy == true)
    #expect(hello.rows.first?.recent == [.prompt(at: 4, text: "hi", from: .user)])
    #expect(hello.rows.first?.snapshot == "tree")
}

private func countWait(_ rest: Int) -> String {
    let word = rest == 1 ? "One more update is" : "\(rest) more updates are"
    let it = rest == 1 ? "it" : "them"
    return " \(word) waiting after this one. Don't bring \(it) up yet: the app will tell you when to offer \(it)."
}
