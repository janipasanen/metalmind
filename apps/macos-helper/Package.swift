// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MacOSHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "MacOSHelper",
            path: "Sources/MacOSHelper"
        ),
    ]
)
