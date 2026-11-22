// swift-tools-version: 6.0
//
// FicheBar — native macOS 14+ menu bar companion for Fiche.
// Zero external SwiftPM dependencies; Swift 6 strict concurrency.

import PackageDescription

let package = Package(
    name: "FicheBar",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "FicheBar", targets: ["FicheBar"]),
    ],
    targets: [
        .executableTarget(
            name: "FicheBar",
            path: "Sources/FicheBar"
        ),
    ]
)
