import Foundation

enum OffMain {
    /// Sleep without holding the main actor. The caller hops back when this returns.
    static func sleep(_ seconds: Double) async throws {
        let nanos = UInt64(seconds * 1_000_000_000)
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { @concurrent in
                try await Task.sleep(nanoseconds: nanos)
            }
            try await group.next()
        }
    }
}
