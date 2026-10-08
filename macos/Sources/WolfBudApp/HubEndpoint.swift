import Foundation

struct HubFailure: Error {
    var message: String
}

/// The window key and port from `~/.wolfbud/hub.json`. The service token in that file is not read.
struct HubEndpoint: Equatable, Sendable {
    var port: Int
    var windowKey: String

    var streamURL: URL {
        url("/api/stream", query: [URLQueryItem(name: "k", value: windowKey)])
    }

    func url(_ path: String, query: [URLQueryItem] = []) -> URL {
        var parts = URLComponents()
        parts.scheme = "http"
        parts.host = "127.0.0.1"
        parts.port = port
        parts.path = path
        if !query.isEmpty { parts.queryItems = query }
        return parts.url!
    }

    static func load() -> HubEndpoint? {
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".wolfbud/hub.json")
        guard
            let data = try? Data(contentsOf: file),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let windowKey = json["windowKey"] as? String,
            !windowKey.isEmpty
        else { return nil }
        let port = (json["port"] as? NSNumber)?.intValue ?? 4747
        guard port > 0, port < 65536 else { return nil }
        return HubEndpoint(port: port, windowKey: windowKey)
    }
}
