import SwiftUI
import WolfBudCore

@MainActor
@Observable
final class SessionStore {
    private(set) var director = SessionDirector()
    private(set) var phase: CallPhase = .idle
    private(set) var mode: VoiceMode = .listening
    private(set) var statusText = "Not on a call"
    private(set) var agentCaption = ""
    private(set) var userCaption = ""
    var hearing = false
    private(set) var muted = false
    private(set) var overlay: String?
    private(set) var hubConnected = false

    var announce: Bool {
        didSet {
            director.announce = announce
            UserDefaults.standard.set(announce, forKey: Keys.announce)
        }
    }

    var keepOnTop: Bool {
        didSet { UserDefaults.standard.set(keepOnTop, forKey: Keys.keepOnTop) }
    }

    let driver = WolfDriver()
    let hub = HubClient()
    let voice: VoiceController

    private var superseded = false
    private var lostAt: Double?
    private let startsHub: Bool

    init(startsHub: Bool = true) {
        self.startsHub = startsHub
        if UserDefaults.standard.object(forKey: Keys.announce) == nil {
            announce = true
        } else {
            announce = UserDefaults.standard.bool(forKey: Keys.announce)
        }
        keepOnTop = UserDefaults.standard.bool(forKey: Keys.keepOnTop)
        voice = VoiceController()
        director.announce = announce
        voice.attach(self)
        hub.onEvent = { [weak self] event in self?.handle(event) }
        hub.onConnection = { [weak self] connected in self?.connection(connected) }
    }

    static var millis: Double { Date().timeIntervalSince1970 * 1000 }

    var rosterRows: [RosterRow] { director.sessions.map(\.row) }
    var focusedSessionID: String? { director.focusedID }
    var chipName: String? { director.focused?.row.name }
    var chipBusy: Bool { director.focused?.row.isBusy == true }
    var chipSince: Double { director.focused?.busySince ?? 0 }
    var feedLines: [FeedLine] { Array(director.feedLines().suffix(5)) }

    func run() async {
        guard startsHub else { return }
        await tick()
        while !Task.isCancelled {
            do { try await OffMain.sleep(1) } catch { return }
            await tick()
        }
    }

    func toggleCall() {
        if phase == .live || phase == .connecting {
            Task { await voice.end() }
        } else {
            voice.start()
        }
    }

    func toggleMute() {
        guard phase == .live else { return }
        muted = voice.toggleMute()
    }

    func focus(name: String) {
        hub.tellFocus(name)
    }

    func shutdown() {
        hub.stop()
        Task { await voice.end() }
    }

    func showAgent(_ text: String) { agentCaption = text }
    func showUser(_ text: String) { userCaption = text }
    func setAgentLive(_ live: Bool) { director.isLive = live }

    func applyCall(phase: CallPhase, mode: VoiceMode? = nil, error: String? = nil) {
        self.phase = phase
        if let mode { self.mode = mode }
        if phase != .live {
            agentCaption = ""
            userCaption = ""
            hearing = false
            muted = false
            driver.setTalking(false)
            driver.setHeard(0)
        }
        switch phase {
        case .connecting:
            statusText = "Calling…"
        case .live:
            statusText = self.mode == .speaking ? "Talking" : "Listening"
        case .error:
            statusText = error ?? "The call failed"
        case .idle:
            statusText = "Not on a call"
        }
        syncMood()
        hub.tellStatus(phase: phase, mode: phase == .live ? self.mode : nil, error: phase == .error ? statusText : nil)
    }

    func applyMode(_ mode: VoiceMode) {
        self.mode = mode
        guard phase == .live else { return }
        statusText = mode == .speaking ? "Talking" : "Listening"
        driver.setTalking(mode == .speaking)
        syncMood()
        hub.tellStatus(phase: .live, mode: mode, error: nil)
    }

    private func tick() async {
        guard !superseded else { return }
        if let endpoint = HubEndpoint.load() {
            hub.watch(endpoint)
        } else {
            hub.stop()
            if lostAt == nil { lostAt = Self.millis }
            if phase == .idle, overlay == nil || overlay == Self.reconnecting {
                overlay = Self.missingHub
            }
        }
        if let lostAt, Self.millis - lostAt > 20_000, phase != .idle {
            await voice.end()
            overlay = Self.lostCall
        }
        if let note = director.flushActivity(now: Self.millis) {
            voice.push([note])
        }
    }

    private func connection(_ up: Bool) {
        hubConnected = up
        guard !superseded else { return }
        if up {
            lostAt = nil
            overlay = nil
            voice.resendStatus()
            return
        }
        if lostAt == nil { lostAt = Self.millis }
        if overlay == nil || overlay == Self.missingHub {
            overlay = Self.reconnecting
        }
    }

    private func handle(_ event: HubStreamEvent) {
        if superseded { return }
        let now = Self.millis
        switch event {
        case let .hello(hello):
            voice.push(director.applyHello(hello, now: now))
        case let .roster(payload):
            voice.push(director.applyRoster(focusedID: payload.focusedID, rows: payload.rows, now: now))
        case let .claude(message):
            voice.apply(director.ingest(message, now: now), now: now)
        case let .snapshot(sessionID, text):
            if let note = director.applySnapshot(sessionID: sessionID, text: text) {
                voice.push([note])
            }
        case let .command(command):
            perform(command)
        case .bye:
            break
        }
    }

    private func perform(_ command: WindowCommand) {
        switch command {
        case .startCall:
            voice.start()
        case .endCall:
            Task { await voice.end() }
        case .raise:
            WindowRaise.front()
        case .superseded:
            giveWay()
        }
    }

    private func giveWay() {
        superseded = true
        overlay = Self.moved
        Task {
            await voice.end()
            hub.stop()
            try? await OffMain.sleep(0.3)
            WindowRaise.quit()
        }
    }

    private func syncMood() {
        let mood: WolfMood
        switch phase {
        case .live:
            mood = mode == .speaking ? .speaking : .listening
        case .connecting:
            mood = .awake
        case .idle, .error:
            mood = .asleep
        }
        driver.setMood(mood)
        if phase == .live { driver.setTalking(mode == .speaking) }
    }

    private func seedPreview() {
        let shop = RosterRow(id: "1", name: "shop", project: "shop", isBusy: true, badge: 1, isRemote: false, host: "")
        let api = RosterRow(id: "2", name: "api", project: "api", isBusy: false, badge: 0, isRemote: true, host: "mini")
        let recent: [ClaudeEvent] = [
            .prompt(at: 1, text: "Rename the call button", from: .user),
            .tool(ToolStep(at: 2, tool: "Edit", detail: "window/index.html", status: .ok)),
            .turnComplete(TurnComplete(at: 3, answer: "Renamed the button.", reason: .answer, durationMs: 4_000)),
        ]
        let hello = Hello(focusedID: "1", rows: [
            HelloRow(row: shop, recent: recent, snapshot: ""),
            HelloRow(row: api, recent: [], snapshot: ""),
        ])
        _ = director.applyHello(hello, now: Self.millis)
    }

    static var previewIdle: SessionStore {
        let store = SessionStore(startsHub: false)
        store.seedPreview()
        return store
    }

    static var previewLive: SessionStore {
        let store = SessionStore(startsHub: false)
        store.seedPreview()
        store.applyCall(phase: .live, mode: .speaking)
        store.showAgent("I'll send that to Claude.")
        store.showUser("Rename the button")
        return store
    }

    static let missingHub = "Open WolfBud from Claude Code: type /wolfbud in a session that loads the wolfbud mod."
    static let reconnecting = "Lost the WolfBud hub. Reconnecting…"
    static let lostCall = "Lost the WolfBud hub, so the call ended. Reopen it with /wolfbud."
    static let moved = "WolfBud moved to a newer window. You can close this one."

    private enum Keys {
        static let announce = "wolfbud.announce"
        static let keepOnTop = "wolfbud.keepOnTop"
    }
}
