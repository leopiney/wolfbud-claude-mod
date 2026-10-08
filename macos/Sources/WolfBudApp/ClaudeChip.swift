import SwiftUI
import WolfBudCore

struct ClaudeChip: View {
    var name: String?
    var isBusy: Bool
    var busySince: Double

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: .now, by: isBusy ? 1 : 3600)) { context in
            label(at: context.date, pulse: pulse(at: context.date))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(isBusy ? "Claude is working" : "Claude is idle")
    }

    private func label(at date: Date, pulse: Double) -> some View {
        let now = date.timeIntervalSince1970 * 1000
        return HStack(spacing: 6) {
            Circle()
                .fill(isBusy ? Theme.busy : Theme.dim)
                .frame(width: 7, height: 7)
                .opacity(pulse)
            Text(SessionText.chip(name: name, isBusy: isBusy, busySince: busySince, now: now))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(isBusy ? Theme.busy : Theme.dim)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 3)
        .background(Theme.raised.opacity(0.001), in: Capsule())
        .overlay(Capsule().strokeBorder(isBusy ? Theme.busy.opacity(0.4) : Theme.line, lineWidth: 1))
    }

    private func pulse(at date: Date) -> Double {
        guard isBusy, !reduceMotion else { return 1 }
        let wave = sin(date.timeIntervalSinceReferenceDate * .pi * 2 / 1.2)
        return 0.45 + 0.55 * (wave * 0.5 + 0.5)
    }
}
