import Foundation
import os

enum WolfMood: Equatable, Sendable {
    case asleep
    case awake
    case listening
    case speaking
}

struct WolfDrive: Equatable, Sendable {
    var talking = false
    var voiceLevel = 0.0
    var heardLevel = 0.0
    var mood: WolfMood = .asleep
    var pointerX = 0.0
    var pointerY = 0.0
    var hasPointer = false
    var petKicks = 0
}

/// Per-frame wolf input. The scene reads it on the render thread; SwiftUI does not observe it.
final class WolfDriver: Sendable {
    private let state = OSAllocatedUnfairLock(initialState: WolfDrive())

    func snapshot() -> WolfDrive {
        state.withLock { $0 }
    }

    func setTalking(_ talking: Bool) {
        state.withLock { $0.talking = talking }
    }

    func setHeard(_ level: Double) {
        state.withLock { $0.heardLevel = level }
    }

    func setMood(_ mood: WolfMood) {
        state.withLock { $0.mood = mood }
    }

    func setPointer(x: Double, y: Double) {
        state.withLock {
            $0.pointerX = x
            $0.pointerY = y
            $0.hasPointer = true
        }
    }

    func clearPointer() {
        state.withLock { $0.hasPointer = false }
    }

    func pet() {
        state.withLock { $0.petKicks += 1 }
    }

    func takePets() -> Int {
        state.withLock {
            let kicks = $0.petKicks
            $0.petKicks = 0
            return kicks
        }
    }
}
