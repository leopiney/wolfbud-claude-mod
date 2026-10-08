import SwiftUI
import WolfBudCore

struct RosterBar: View {
    var rows: [RosterRow]
    var focusedID: String?
    var onFocus: (String) -> Void

    var body: some View {
        WrapLayout(spacing: 6) {
            ForEach(rows) { row in
                RosterChip(row: row, focused: row.id == focusedID) {
                    onFocus(row.name)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Claude sessions")
    }
}

private struct WrapLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        let rows = lines(width: width, subviews: subviews)
        let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in lines(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for item in row.items {
                item.view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(width: item.size.width, height: item.size.height))
                x += item.size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private func lines(width: CGFloat, subviews: Subviews) -> [Line] {
        var rows: [Line] = []
        var current = Line()
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            let next = current.items.isEmpty ? 0 : current.width + spacing
            if !current.items.isEmpty, next + size.width > width {
                rows.append(current)
                current = Line()
            }
            current.items.append(Item(view: view, size: size))
            current.width += (current.items.count == 1 ? 0 : spacing) + size.width
            current.height = max(current.height, size.height)
        }
        if !current.items.isEmpty { rows.append(current) }
        return rows
    }

    private struct Item {
        var view: LayoutSubview
        var size: CGSize
    }

    private struct Line {
        var items: [Item] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }
}

private struct RosterChip: View {
    var row: RosterRow
    var focused: Bool
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if row.isBusy {
                    Circle()
                        .fill(Theme.busy)
                        .frame(width: 6, height: 6)
                        .accessibilityHidden(true)
                }
                Text(row.name)
                Text(row.isRemote ? "@\(row.host.isEmpty ? "remote" : row.host)" : "local")
                    .font(.caption2)
                    .foregroundStyle(Theme.dim)
                if row.badge > 0 {
                    Text("\(row.badge)")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Color(red: 0.10, green: 0.06, blue: 0.13))
                        .padding(.horizontal, 4)
                        .frame(minWidth: 16, minHeight: 16)
                        .background(Theme.bad, in: Capsule())
                }
            }
            .font(.caption)
            .foregroundStyle(focused ? Theme.text : Theme.dim)
            .padding(.horizontal, 10)
            .padding(.vertical, 2)
            .background(Theme.raised, in: Capsule())
            .overlay(Capsule().strokeBorder(focused ? Theme.accent : Theme.line, style: StrokeStyle(lineWidth: 1, dash: row.isRemote ? [3, 2] : [])))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityName)
        .accessibilityAddTraits(focused ? .isSelected : [])
    }

    private var accessibilityName: String {
        let state = row.isBusy ? "working" : "idle"
        let place = row.isRemote ? "remote on \(row.host.isEmpty ? "another machine" : row.host)" : "on this machine"
        return "\(row.name), \(state), \(place)"
    }
}
