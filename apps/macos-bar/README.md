# FicheBar — Native macOS Menubar App

A pure native macOS 14+ AppKit + SwiftUI (`MenuBarExtra`) companion for **Fiche**, built with Swift 6 strict concurrency and zero external SwiftPM dependencies.

## Features

- **Concept A Brand Craft Everywhere**:
  - **Menu bar template glyph** (`FicheMenuBarIcon`): 18×18 monochrome AppKit template `NSImage` matching Fiche's Concept A silhouette (3 optical compression ribbons feeding into the microfiche aperture frame with faceted crystal core, plus paused/stopped states) paired with tabular savings (`-44% · $1.24`, `fiche`, `Paused`, `Off`).
  - **Popover header mark** (`FicheLogoMark`): Full-color vector SwiftUI `Canvas` rendering of `assets/fiche-mark.svg`.
  - **App bundle icon** (`AppIcon.icns`): Multi-resolution macOS iconset (`16` through `1024`) generated from `assets/fiche-mark.svg`.
- **5 Native Themes**: `Native` (macOS material), `Slate` (cool grey-blue), `Midnight` (obsidian indigo + SF Rounded), `Terminal` (dark monospaced), and `Editorial` (Swiss white paper + condensed type + crimson accent), persisted via `UserDefaults`.
- **Auto-Start & Lifecycle Supervision**: Probes `http://127.0.0.1:47821/api/health` on launch. When unreachable and `autoStartDaemon` is enabled, kickstarts `~/Library/LaunchAgents/com.sriinnu.fiche.plist` via `launchctl` or spawns a detached `fiche` background daemon (`FICHE_PRICES=kosha`, `FICHE_TEXT_HYGIENE=on`) logging to `~/.fiche/daemon.{out,err}.log`.
- **Serene Control Center Popover (360px)**:
  - **Hero Savings Band**: 2-column typographic split (`TOKENS SAVED` & `REAL USD SAVED`) plus latest turn summary strip.
  - **Activity**: Per-model savings breakdown (`by_model`) with `OPTICAL` / `TEXT` badges, active session rollup, and lifetime Requests / Compressed / Render Cache stats.
  - **Models**: Live model-scope toggles and **My Providers** toggles synced with `/api/models` and `/api/providers`, plus 1-click **Kosha Registry Sync** (`Sync` / `Update & Sync` + `All 21 providers` toggle reading `~/.kosha/registry.json` via `fiche models sync-kosha --apply`), grouped by provider (`Anthropic`, `Google Gemini`, `OpenAI / Codex`, `OpenAI-Compat` with collapsible long lists).
  - **Stages**: Live toggles for built-in compiler stages and discovered `~/.fiche/plugins` & `~/.agents/skills` via `/api/plugins`, with direct folder access.
  - **Control**: Theme picker, live Compression toggle, Auto-start, Start at login (`launchd`), port/poll settings, and Restart/Stop controls.

## Build & Install

Install directly via Homebrew (macOS arm64 Sonoma+):

```sh
brew install --cask sriinnu/tap/fichebar
# Upgrade later:
brew upgrade --cask fichebar
```

Or build from source (requires **macOS 14+** and **Xcode / Swift 6+** toolchain):

```sh
# Build debug binary
swift build --package-path apps/macos-bar

# Build & ad-hoc sign FicheBar.app locally (no /Applications install)
./apps/macos-bar/bundle.sh --no-install

# Build, ad-hoc sign, install to /Applications/FicheBar.app, and launch
./apps/macos-bar/bundle.sh --install
```

The `--no-install` build writes to `apps/macos-bar/build.noindex/FicheBar.app` (the `.noindex` suffix keeps dev builds out of Spotlight and Launchpad).

## Architecture

- `Package.swift` — SwiftPM manifest targeting macOS 14+ with Swift 6 strict concurrency and zero external dependencies.
- `Sources/FicheBar/Theme.swift` — `ThemeID` / `Theme` tokens for all 5 themes plus `Hairline`, `VerticalHairline`, and `Band` layout primitives.
- `Sources/FicheBar/FicheLogo.swift` — `FicheLogoMark` (SwiftUI vector Concept A mark) and `FicheMenuBarIcon` (`18×18` monochrome AppKit template `NSImage`).
- `Sources/FicheBar/FicheBarApp.swift` — `@main` `MenuBarExtra(.window)` entry point with template menu bar icon and `NSApplicationDelegateAdaptor` accessory activation policy.
- `Sources/FicheBar/FicheModels.swift` — `Sendable` + resilient `Codable` models for `/api/health`, `/proxy-stats`, `/api/last-turn.json`, `/api/models`, `/api/plugins`, and formatting helpers.
- `Sources/FicheBar/DaemonController.swift` — `@MainActor` `ObservableObject` managing 3s structured polling, LaunchAgent/`node`+`fiche` discovery and detached spawning, live POST controls (`/api/compression`, `/api/models`, `/api/plugins`, `/api/shutdown`), and persisted `themeID`.
- `Sources/FicheBar/PopoverView.swift` — 360px Apple Control Center-style SwiftUI popover with segmented/typographic tabs (`Activity`, `Models`, `Stages`, `Control`) and footer Quit menu.
- `bundle.sh` — Release build, `AppIcon.icns` generation from `assets/fiche-mark.svg`, `Info.plist` generation (`dev.srinivas.fichebar`), asset bundling, ad-hoc code signing, and optional `/Applications` install.

## License

MIT License — see [LICENSE](../../LICENSE).
