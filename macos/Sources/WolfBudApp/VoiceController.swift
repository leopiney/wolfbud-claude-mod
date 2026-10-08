import ElevenLabs
import Foundation
import WolfBudCore

/// The ElevenLabs call. Timing stays in `CallEngine`; this type only moves audio and tool results.
@MainActor
final class VoiceController {
    private var store: SessionStore?
    private var conversation: Conversation?
    private var engine = CallEngine()
    private var startTask: Task<Void, Never>?
    private var drainTask: Task<Void, Never>?
    private var contextChain: Task<Void, Never>?
    private var seenTools = Set<String>()
    private var lastError: String?

    func attach(_ store: SessionStore) {
        self.store = store
    }

    func start() {
        guard let store, store.phase == .idle || store.phase == .error else { return }
        startTask?.cancel()
        startTask = Task { await self.open() }
    }

    func end() async {
        startTask?.cancel()
        let live = conversation
        await tearDown(reportIdle: true)
        if let live { await live.endConversation() }
    }

    func toggleMute() -> Bool {
        guard let store, store.phase == .live else { return false }
        let muted = !store.muted
        Task { try? await self.conversation?.setMuted(muted) }
        return muted
    }

    func push(_ notes: [ContextNote]) {
        enqueue(notes.map(\.text))
    }

    func apply(_ update: AgentUpdate, now: Double) {
        var texts = update.contexts.map(\.text)
        if let item = update.announcement, let context = update.announcementContext {
            texts.append(contentsOf: engine.announce(item, context: context, now: now))
        }
        enqueue(texts)
    }

    /// The Swift SDK appends each update. It has no context id, so a later note cannot replace an earlier one.
    private func enqueue(_ texts: [String]) {
        let texts = texts.filter { !$0.isEmpty }
        guard engine.isLive, !texts.isEmpty else { return }
        let previous = contextChain
        contextChain = Task { [weak self] in
            await previous?.value
            guard let self, let conversation = self.conversation else { return }
            for text in texts {
                try? await conversation.updateContext(text)
            }
        }
    }

    func resendStatus() {
        guard let store else { return }
        store.hub.tellStatus(phase: store.phase, mode: store.phase == .live ? store.mode : nil, error: store.phase == .error ? store.statusText : nil)
    }

    private func open() async {
        guard let store else { return }
        store.applyCall(phase: .connecting)
        do {
            let token = try await store.hub.token()
            if Task.isCancelled { return }
            try await connect(token: token)
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, store.phase != .idle else { return }
            store.applyCall(phase: .error, error: Self.describe(error, wrapping: false))
        }
    }

    private func connect(token: String) async throws {
        guard let store else { return }
        let variables = SessionText.dynamicVariables(sessions: store.director.sessions, focusedID: store.director.focusedID)
        var config = ConversationConfig()
        config.dynamicVariables = variables
        config.agentStateConfiguration = .default
        config.onAgentResponse = { [weak self] text, _ in
            Task { @MainActor in self?.agentSaid(text) }
        }
        config.onAgentResponseCorrection = { [weak self] _, corrected, _ in
            Task { @MainActor in self?.agentCorrected(corrected) }
        }
        config.onUserTranscript = { [weak self] text, _ in
            Task { @MainActor in self?.userSaid(text) }
        }
        config.onVadScore = { [weak self] score in
            Task { @MainActor in self?.heard(score) }
        }
        config.onAgentStateChange = { [weak self] state in
            Task { @MainActor in self?.agentState(state) }
        }
        config.onUnhandledClientToolCall = { [weak self] event in
            Task { @MainActor in await self?.handleTool(event) }
        }
        config.onError = { [weak self] error in
            let text = String(describing: error)
            Task { @MainActor in self?.lastError = text }
        }
        do {
            conversation = try await ElevenLabs.startConversation(
                conversationToken: token,
                config: config,
                onAgentReady: { [weak self] in
                    Task { @MainActor in self?.ready() }
                },
                onDisconnect: { [weak self] reason in
                    Task { @MainActor in self?.disconnected(reason) }
                }
            )
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            await tearDown(reportIdle: false)
            throw HubFailure(message: "Couldn't start the call: \(error.localizedDescription)")
        }
    }

    private func ready() {
        guard let store else { return }
        let now = SessionStore.millis
        engine.connected(now: now)
        store.setAgentLive(true)
        store.applyCall(phase: .live, mode: .speaking)
        enqueue(store.director.brief(withSnapshot: false).map(\.text))
        store.hub.tellSnapshot()
        drainTask?.cancel()
        drainTask = Task { await self.drainLoop() }
    }

    private func drainLoop() async {
        while !Task.isCancelled {
            do { try await OffMain.sleep(0.5) } catch { return }
            await drain()
        }
    }

    private func drain() async {
        guard let store else { return }
        let effects = engine.tick(now: SessionStore.millis)
        let hearing = effects.userSpeaking
        if hearing != store.hearing { store.hearing = hearing }
        guard engine.isLive, let conversation else { return }
        if let pending = effects.pendingContext {
            try? await conversation.updateContext(pending)
        }
        if let message = effects.userMessage {
            try? await conversation.sendMessage(message)
        } else if effects.keepalive {
            try? await conversation.interruptAgent()
        }
    }

    private func agentSaid(_ raw: String) {
        let text = ShownText.agent(raw)
        guard !ShownText.isJunk(text) else { return }
        engine.noteAgentLine(text, now: SessionStore.millis)
        store?.showAgent(text)
        store?.hub.tellLine(role: "agent", text: text)
    }

    private func agentCorrected(_ raw: String) {
        let text = ShownText.agent(raw)
        guard !ShownText.isJunk(text) else { return }
        store?.showAgent(text)
        store?.hub.tellLine(role: "agent", text: text)
    }

    private func userSaid(_ raw: String) {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ShownText.isJunk(text) else { return }
        engine.noteUserLine(now: SessionStore.millis)
        store?.showUser(text)
        store?.hub.tellLine(role: "user", text: text)
    }

    private func heard(_ score: Double) {
        store?.driver.setHeard(score)
        engine.noteVad(score, now: SessionStore.millis)
    }

    private func agentState(_ state: ElevenLabs.AgentState) {
        let speaking = state == .speaking
        engine.noteSpeaking(speaking, now: SessionStore.millis)
        store?.driver.setTalking(speaking)
        store?.applyMode(speaking ? .speaking : .listening)
    }

    private func handleTool(_ event: ClientToolCallEvent) async {
        guard let store, engine.isLive else { return }
        if seenTools.contains(event.toolCallId) { return }
        seenTools.insert(event.toolCallId)
        let now = SessionStore.millis
        engine.touchTool(now: now)
        let outcome = ToolOutcome.interpret(name: event.toolName, parameters: parameterStrings(event))
        let result: String
        switch outcome {
        case let .reply(text):
            result = text
        case let .send(prompt, when, summary, session):
            result = await store.hub.ask(Self.sendBody(prompt: prompt, when: when, summary: summary, session: session))
        case let .stop(reason, session):
            result = await store.hub.ask(Self.stopBody(reason: reason, session: session))
        case .nextUpdate:
            let pulled = engine.pullNext(now: now)
            enqueue([pulled.pending])
            result = pulled.reply
        case let .activity(focus, session):
            result = SessionText.activityTool(
                focus: focus,
                session: session,
                sessions: store.director.sessions,
                focusedID: store.director.focusedID,
                now: now
            )
        }
        guard event.expectsResponse else { return }
        try? await conversation?.sendToolResult(for: event.toolCallId, result: result, isError: false)
    }

    private func disconnected(_ reason: DisconnectionReason) {
        let message = reason == .error ? lastError : nil
        Task { await self.tearDown(reportIdle: message == nil, error: message) }
    }

    private func tearDown(reportIdle: Bool, error: String? = nil) async {
        drainTask?.cancel()
        drainTask = nil
        contextChain?.cancel()
        contextChain = nil
        conversation = nil
        engine.ended()
        seenTools.removeAll()
        guard let store else { return }
        store.setAgentLive(false)
        if let error, !error.isEmpty {
            store.applyCall(phase: .error, error: error)
        } else if reportIdle, store.phase != .idle {
            store.applyCall(phase: .idle)
        }
    }

    private func parameterStrings(_ event: ClientToolCallEvent) -> [String: String] {
        let values = (try? event.getParameters()) ?? [:]
        if !values.isEmpty { return values.mapValues(Self.stringify) }
        guard let object = try? JSONSerialization.jsonObject(with: event.parametersData) as? [String: Any] else { return [:] }
        return object.mapValues(Self.stringify)
    }

    private static func stringify(_ value: Any) -> String {
        switch value {
        case let text as String:
            text
        case let number as NSNumber:
            number.stringValue
        default:
            String(describing: value)
        }
    }

    private static func sendBody(prompt: String, when: SendWhen, summary: String, session: String?) -> [String: Any] {
        var body: [String: Any] = ["type": "send", "prompt": prompt, "when": when.rawValue, "summary": summary]
        if let session { body["session"] = session }
        return body
    }

    private static func stopBody(reason: String, session: String?) -> [String: Any] {
        var body: [String: Any] = ["type": "stop", "reason": reason]
        if let session { body["session"] = session }
        return body
    }

    private static func describe(_ error: Error, wrapping: Bool) -> String {
        if let failure = error as? HubFailure { return failure.message }
        let text = error.localizedDescription
        let lower = text.lowercased()
        if lower.contains("microphone") || lower.contains("permission") || lower.contains("not authorized") {
            return "WolfBud needs the microphone: allow it for this window, then call again."
        }
        return wrapping ? "Couldn't start the call: \(text)" : text
    }
}
