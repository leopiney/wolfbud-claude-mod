import SwiftUI
import WolfBudCore

struct ControlsBar: View {
    var phase: CallPhase
    var muted: Bool
    @Binding var announce: Bool
    var onCall: () -> Void
    var onMute: () -> Void

    private var onCallNow: Bool { phase == .live || phase == .connecting }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button(onCallNow ? "End call" : "Call WolfBud", action: onCall)
                    .buttonStyle(.plain)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(onCallNow ? Theme.text : Color.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(onCallNow ? Theme.raised : Theme.accentStrong, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(onCallNow ? Theme.line : .clear, lineWidth: 1))
                Button(action: onMute) {
                    Image(systemName: muted ? "mic.slash.fill" : "mic.fill")
                        .font(.body)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .foregroundStyle(muted ? Theme.bad : Theme.text)
                .background(Theme.raised, in: Circle())
                .overlay(Circle().strokeBorder(Theme.line, lineWidth: 1))
                .disabled(phase != .live)
                .accessibilityLabel(muted ? "Unmute microphone" : "Mute microphone")
            }
            Toggle("Speak up when Claude finishes", isOn: $announce)
                .font(.caption)
                .foregroundStyle(Theme.dim)
                .toggleStyle(.checkbox)
        }
    }
}
