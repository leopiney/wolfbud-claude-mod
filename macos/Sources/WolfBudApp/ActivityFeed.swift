import SwiftUI
import WolfBudCore

struct ActivityFeed: View {
    var lines: [FeedLine]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Focused session")
                .font(.caption)
                .foregroundStyle(Theme.dim)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 3) {
                        ForEach(lines) { line in
                            FeedRow(line: line)
                                .id(line.id)
                        }
                    }
                }
                .onChange(of: lines.last?.id) {
                    if let id = lines.last?.id { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Focused session")
    }
}

private struct FeedRow: View {
    var line: FeedLine

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol)
                .font(.caption2)
                .foregroundStyle(color)
                .frame(width: 14)
                .accessibilityHidden(true)
            Text(line.text)
                .font(.caption)
                .foregroundStyle(color)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var symbol: String {
        switch line.symbol {
        case .wolf: "pawprint.fill"
        case .prompt: "text.bubble"
        case .ok: "checkmark"
        case .bad: "xmark"
        case .done: "checkmark.circle"
        case .notice: "exclamationmark.triangle"
        }
    }

    private var color: Color {
        switch line.tone {
        case .ok: Theme.listen
        case .bad: Theme.bad
        case .info: Theme.dim
        }
    }
}
