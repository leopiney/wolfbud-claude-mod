import SwiftUI

@main
struct WolfBudApp: App {
    @State private var store = SessionStore()

    var body: some Scene {
        Window("WolfBud", id: "wolfbud") {
            WolfWindow(store: store)
                .frame(minWidth: 320, minHeight: 560)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 400, height: 720)
        .defaultPosition(.trailing)
        .windowResizability(.contentMinSize)
        .commands { WolfCommands(store: store) }
    }
}

struct WolfCommands: Commands {
    @Bindable var store: SessionStore

    var body: some Commands {
        CommandMenu("Call") {
            Button(store.phase == .live || store.phase == .connecting ? "End Call" : "Call WolfBud") {
                store.toggleCall()
            }
            .keyboardShortcut("k", modifiers: .command)
            Button(store.muted ? "Unmute" : "Mute") {
                store.toggleMute()
            }
            .keyboardShortcut("m", modifiers: [.command, .shift])
            .disabled(store.phase != .live)
            Toggle("Speak Up When Claude Finishes", isOn: $store.announce)
            Toggle("Keep on Top", isOn: $store.keepOnTop)
                .keyboardShortcut("t", modifiers: [.command, .shift])
        }
    }
}
