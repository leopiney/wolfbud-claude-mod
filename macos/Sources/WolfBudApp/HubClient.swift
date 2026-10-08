import Foundation
import WolfBudCore

/// The window's side of the hub: SSE in, page posts out. Reconnects with the key currently on disk.
@MainActor
final class HubClient {
    var onEvent: ((HubStreamEvent) -> Void)?
    var onConnection: ((Bool) -> Void)?

    private var endpoint: HubEndpoint?
    private var streamTask: Task<Void, Never>?
    private var stopped = false

    func watch(_ endpoint: HubEndpoint) {
        let changed = endpoint != self.endpoint
        self.endpoint = endpoint
        stopped = false
        guard changed || streamTask == nil else { return }
        streamTask?.cancel()
        streamTask = Task { await self.loop() }
    }

    func stop() {
        stopped = true
        streamTask?.cancel()
        streamTask = nil
    }

    func token() async throws -> String {
        let reply = try await request(path: "/api/token", method: "GET", body: nil)
        if let token = reply.json["token"] as? String, !token.isEmpty { return token }
        let message = reply.json["message"] as? String
        throw HubFailure(message: message ?? "the hub answered \(reply.status)")
    }

    func ask(_ body: [String: Any]) async -> String {
        do {
            let reply = try await request(path: "/api/page", method: "POST", body: body)
            if let message = reply.json["message"] as? String, !message.isEmpty { return message }
            return "Claude Code did not say what happened."
        } catch {
            return "Lost the connection to Claude Code for a moment. Try again in a few seconds."
        }
    }

    func tellStatus(phase: CallPhase, mode: VoiceMode?, error: String?) {
        var body: [String: Any] = ["type": "status", "call": phase.rawValue, "mode": mode?.rawValue ?? NSNull()]
        if let error { body["error"] = error }
        tell(body)
    }

    func tellLine(role: String, text: String) {
        tell(["type": "line", "role": role, "text": text])
    }

    func tellFocus(_ name: String) {
        tell(["type": "focus", "session": name])
    }

    func tellSnapshot() {
        tell(["type": "snapshot"])
    }

    private func tell(_ body: [String: Any]) {
        guard endpoint != nil else { return }
        Task { _ = try? await self.request(path: "/api/page", method: "POST", body: body) }
    }

    private func loop() async {
        var delay = 1.0
        while !stopped, !Task.isCancelled {
            let current = HubEndpoint.load() ?? endpoint
            guard let current else { return }
            endpoint = current
            do {
                try await read(current)
                if stopped || Task.isCancelled { return }
                onConnection?(false)
                delay = 1
            } catch is CancellationError {
                return
            } catch {
                if stopped || Task.isCancelled { return }
                onConnection?(false)
            }
            do { try await OffMain.sleep(delay) } catch { return }
            delay = min(delay * 2, 8)
        }
    }

    private func read(_ endpoint: HubEndpoint) async throws {
        var request = URLRequest(url: endpoint.streamURL)
        request.timeoutInterval = 86_400
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw HubFailure(message: "the hub answered \(status)") }
        onConnection?(true)
        var parser = SSEParser()
        for try await line in bytes.lines {
            if Task.isCancelled { throw CancellationError() }
            guard let event = parser.feed(line), let decoded = HubStreamDecoding.decode(event) else { continue }
            onEvent?(decoded)
        }
    }

    private struct Reply {
        var status: Int
        var json: [String: Any]
    }

    private func request(path: String, method: String, body: [String: Any]?) async throws -> Reply {
        guard let endpoint else { throw HubFailure(message: "WolfBud hub is not running") }
        var request = URLRequest(url: endpoint.url(path))
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue(endpoint.windowKey, forHTTPHeaderField: "x-wolfbud-key")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        return Reply(status: status, json: json)
    }
}
