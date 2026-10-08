// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "WolfBud",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "WolfBudCore", targets: ["WolfBudCore"]),
        .executable(name: "WolfBud", targets: ["WolfBudApp"]),
    ],
    dependencies: [
        .package(url: "https://github.com/elevenlabs/elevenlabs-swift-sdk.git", exact: "3.4.0"),
        .package(url: "https://github.com/warrenm/GLTFKit2.git", exact: "0.5.15"),
    ],
    targets: [
        .target(
            name: "WolfBudCore",
            // The ElevenLabs SDK is Swift 5. Our calls into it stay in that mode
            // so its unchecked boundaries don't become our build failures.
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .executableTarget(
            name: "WolfBudApp",
            dependencies: [
                "WolfBudCore",
                .product(name: "ElevenLabs", package: "elevenlabs-swift-sdk"),
                .product(name: "GLTFKit2", package: "GLTFKit2"),
            ],
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.linkedFramework("AVFoundation")]
        ),
        .testTarget(
            name: "WolfBudCoreTests",
            dependencies: ["WolfBudCore"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
