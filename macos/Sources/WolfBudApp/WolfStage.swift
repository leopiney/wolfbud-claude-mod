import SwiftUI
import WolfBudCore

struct WolfStage: View {
    var driver: WolfDriver
    var phase: CallPhase
    var mode: VoiceMode
    var hearing: Bool
    var status: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var badgeSide: CGFloat = 236

    var body: some View {
        VStack(spacing: 12) {
            badge
            Text(status)
                .font(.callout)
                .foregroundStyle(phase == .error ? Theme.bad : Theme.dim)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
                .frame(minHeight: 20)
                .accessibilityAddTraits(.updatesFrequently)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background {
            GeometryReader { proxy in
                Color.clear
                    .onAppear { badgeSide = fitted(proxy.size) }
                    .onChange(of: proxy.size) { _, size in badgeSide = fitted(size) }
            }
        }
    }

    private var badge: some View {
        Button {
            driver.pet()
        } label: {
            WolfViewport(driver: driver)
                .padding(8)
                .frame(width: badgeSide, height: badgeSide)
                .background(badgeFill, in: Circle())
                .shadow(color: .black.opacity(0.45), radius: 18, y: 10)
        }
        .buttonStyle(BadgePressStyle())
        .accessibilityLabel("Pet WolfBud")
        .overlay { ring.allowsHitTesting(false) }
        .onContinuousHover { hover in
            switch hover {
            case let .active(point):
                driver.setPointer(x: point.x - badgeSide / 2, y: point.y - badgeSide / 2)
            case .ended:
                driver.clearPointer()
            }
        }
        .saturation(phase == .idle || phase == .error ? 0.75 : 1)
        .brightness(phase == .idle || phase == .error ? -0.05 : 0)
    }

    private var badgeFill: some ShapeStyle {
        RadialGradient(colors: [Theme.badgeTop, Theme.badgeBottom], center: UnitPoint(x: 0.35, y: 0.3), startRadius: 0, endRadius: badgeSide * 0.72)
    }

    private var ring: some View {
        Circle()
            .strokeBorder(ringColor, lineWidth: 3)
            .padding(-7)
            .shadow(color: ringColor.opacity(glow), radius: glow > 0 ? 12 : 0)
            .phaseAnimator([false, true]) { content, pulse in
                content.opacity(phase == .connecting && pulse && !reduceMotion ? 0.55 : 1)
            } animation: { _ in
                phase == .connecting && !reduceMotion ? .easeInOut(duration: 1.1) : nil
            }
    }

    private var ringColor: Color {
        switch phase {
        case .connecting: Theme.accent
        case .error: Theme.bad
        case .live: mode == .speaking ? Theme.talk : Theme.listen
        case .idle: Theme.line
        }
    }

    private var glow: Double {
        switch phase {
        case .live where hearing && mode != .speaking: 0.6
        case .live where mode == .speaking: 0.5
        case .live: 0.35
        default: 0
        }
    }

    private func fitted(_ size: CGSize) -> CGFloat {
        let room = min(size.width, max(0, size.height - 36))
        return min(236, max(120, room))
    }
}

private struct BadgePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.2), value: configuration.isPressed)
    }
}
