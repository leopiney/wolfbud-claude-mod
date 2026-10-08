import AppKit
import SwiftUI

struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        DragView()
    }

    func updateNSView(_ nsView: NSView, context: Context) {}

    final class DragView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }
    }
}

struct WindowLevelSetter: NSViewRepresentable {
    var floating: Bool

    func makeNSView(context: Context) -> NSView {
        NSView()
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        let level: NSWindow.Level = floating ? .floating : .normal
        DispatchQueue.main.async {
            guard nsView.window?.level != level else { return }
            nsView.window?.level = level
        }
    }
}

enum WindowRaise {
    static func front() {
        NSApp.activate()
        NSApp.windows.first { $0.canBecomeKey }?.makeKeyAndOrderFront(nil)
    }

    static func quit() {
        NSApp.terminate(nil)
    }
}
