import Foundation

public enum ShownText {
    private static let junk = try! NSRegularExpression(pattern: #"^[\s.…·,!?-]*$"#)
    private static let audioTag = try! NSRegularExpression(pattern: #"\[[^\]\n]{1,40}\]"#)

    public static func agent(_ raw: String) -> String {
        let range = NSRange(raw.startIndex..., in: raw)
        let stripped = audioTag.stringByReplacingMatches(in: raw, range: range, withTemplate: "")
        let collapsed = stripped.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
        return collapsed.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static func isJunk(_ text: String) -> Bool {
        let range = NSRange(text.startIndex..., in: text)
        return junk.firstMatch(in: text, range: range) != nil
    }
}
