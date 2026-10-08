import SwiftUI

struct CaptionBand: View {
    var agent: String
    var user: String

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    if !agent.isEmpty {
                        Text(agent)
                            .font(.body)
                            .foregroundStyle(Theme.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id("agent")
                    }
                    if !user.isEmpty {
                        Text("you · \(user)")
                            .font(.body)
                            .foregroundStyle(Theme.dim)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id("user")
                    }
                }
            }
            .onChange(of: agent) { proxy.scrollTo("agent", anchor: .bottom) }
            .onChange(of: user) { proxy.scrollTo("user", anchor: .bottom) }
        }
        .accessibilityElement(children: .combine)
    }
}
