import SwiftUI

struct CallOverlay: View {
    var text: String

    var body: some View {
        ZStack {
            Theme.background.opacity(0.88)
            Text(text)
                .font(.body)
                .foregroundStyle(Theme.text)
                .multilineTextAlignment(.center)
                .padding(28)
                .frame(maxWidth: 320)
        }
        .accessibilityAddTraits(.isModal)
    }
}
