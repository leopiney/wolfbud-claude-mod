import Foundation

public struct SSEEvent: Equatable, Sendable {
    public var event: String
    public var data: String

    public init(event: String, data: String) {
        self.event = event
        self.data = data
    }
}

/// One Server-Sent Events stream. `feed` takes a line without its newline.
public struct SSEParser: Equatable, Sendable {
    private var event = "message"
    private var data: [String] = []

    public init() {}

    public mutating func feed(_ line: String) -> SSEEvent? {
        let line = line.hasSuffix("\r") ? String(line.dropLast()) : line
        if line.isEmpty {
            guard !data.isEmpty else {
                event = "message"
                return nil
            }
            let finished = SSEEvent(event: event, data: data.joined(separator: "\n"))
            event = "message"
            data = []
            return finished
        }
        if line.hasPrefix(":") { return nil }
        if line.hasPrefix("event:") {
            event = String(line.dropFirst("event:".count)).trimmingCharacters(in: .whitespaces)
            return nil
        }
        if line.hasPrefix("data:") {
            var value = String(line.dropFirst("data:".count))
            if value.hasPrefix(" ") { value.removeFirst() }
            data.append(value)
        }
        return nil
    }
}

public enum HubStreamDecoding {
    public static func decode(_ event: SSEEvent) -> HubStreamEvent? {
        guard let data = event.data.data(using: .utf8) else { return nil }
        return try? HubDecoding.streamEvent(named: event.event, data: data)
    }
}
