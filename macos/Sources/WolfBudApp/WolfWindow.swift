import SwiftUI

struct WolfWindow: View {
    @Bindable var store: SessionStore

    var body: some View {
        VStack(spacing: 10) {
            ClaudeChip(name: store.chipName, isBusy: store.chipBusy, busySince: store.chipSince)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .frame(minHeight: 28)
                .background(WindowDragArea())
            if !store.rosterRows.isEmpty {
                RosterBar(rows: store.rosterRows, focusedID: store.focusedSessionID, onFocus: store.focus)
            }
            WolfStage(
                driver: store.driver,
                phase: store.phase,
                mode: store.mode,
                hearing: store.hearing,
                status: store.statusText
            )
            CaptionBand(agent: store.agentCaption, user: store.userCaption)
                .frame(maxHeight: 110)
            ActivityFeed(lines: store.feedLines)
                .frame(maxHeight: 132)
            ControlsBar(
                phase: store.phase,
                muted: store.muted,
                announce: $store.announce,
                onCall: store.toggleCall,
                onMute: store.toggleMute
            )
            if let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String, !version.isEmpty {
                Text("v\(version)")
                    .font(.caption2)
                    .foregroundStyle(Theme.dim.opacity(0.7))
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background)
        .overlay {
            if let text = store.overlay {
                CallOverlay(text: text)
            }
        }
        .background(WindowLevelSetter(floating: store.keepOnTop))
        .preferredColorScheme(.dark)
        .task { await store.run() }
        .onDisappear { store.shutdown() }
    }
}

#Preview("Idle") {
    WolfWindow(store: .previewIdle)
        .frame(width: 400, height: 720)
}

#Preview("On a call") {
    WolfWindow(store: .previewLive)
        .frame(width: 400, height: 720)
}
