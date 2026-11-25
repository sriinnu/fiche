#!/usr/bin/env bash
# bundle.sh — build, bundle, ad-hoc sign, and optionally install FicheBar.app
#
# Usage:
#   ./bundle.sh               # build, sign, install to /Applications/FicheBar.app & relaunch
#   ./bundle.sh --install     # same as default: install to /Applications/FicheBar.app & relaunch
#   ./bundle.sh --no-install  # build & sign into apps/macos-bar/build.noindex/FicheBar.app only
#
# Optional env overrides:
#   CFBundleShortVersionString  (defaults to version from ../../package.json, or 0.19.0)
#   CFBundleVersion             (defaults to 1)
#   SWIFTPM_ARGS                (extra flags passed to swift build, e.g. --disable-sandbox)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

INSTALL=1
for arg in "$@"; do
  case "${arg}" in
    --install)    INSTALL=1 ;;
    --no-install) INSTALL=0 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    "") ;;
    *)
      echo "Unknown flag: ${arg}" >&2
      exit 2
      ;;
  esac
done

APP_NAME="FicheBar"
BUNDLE_ID="dev.srinivas.fichebar"
BUILD_DIR="${SCRIPT_DIR}/build.noindex"
APP_DIR="${BUILD_DIR}/${APP_NAME}.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"
RESOURCES_DIR="${CONTENTS_DIR}/Resources"
ICONSET_DIR="${BUILD_DIR}/AppIcon.iconset"
ICON_SVG="${REPO_ROOT}/assets/fiche-mark.svg"

cleanup() {
  rm -rf "${ICONSET_DIR}"
}
trap cleanup EXIT

DEFAULT_VERSION="0.19.0"
if [[ -f "${REPO_ROOT}/package.json" ]]; then
  PARSED_VER="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "${REPO_ROOT}/package.json" | head -n 1 || true)"
  if [[ -n "${PARSED_VER}" ]]; then
    DEFAULT_VERSION="${PARSED_VER}"
  fi
fi

SHORT_VERSION="${CFBundleShortVersionString:-${DEFAULT_VERSION}}"
BUILD_VERSION="${CFBundleVersion:-1}"

echo "==> Building ${APP_NAME} (${SHORT_VERSION}) in release mode..."
# shellcheck disable=SC2086
swift build -c release --package-path "${SCRIPT_DIR}" ${SWIFTPM_ARGS:-}

# shellcheck disable=SC2086
BIN_DIR="$(swift build -c release --package-path "${SCRIPT_DIR}" ${SWIFTPM_ARGS:-} --show-bin-path)"
BINARY_PATH="${BIN_DIR}/${APP_NAME}"
if [[ ! -x "${BINARY_PATH}" ]]; then
  echo "ERROR: Built binary not found at ${BINARY_PATH}" >&2
  exit 1
fi

echo "==> Assembling ${APP_DIR}..."
rm -rf "${APP_DIR}" "${ICONSET_DIR}"
mkdir -p "${MACOS_DIR}" "${RESOURCES_DIR}" "${ICONSET_DIR}"

cp "${BINARY_PATH}" "${MACOS_DIR}/${APP_NAME}"
chmod +x "${MACOS_DIR}/${APP_NAME}"

if [[ -f "${REPO_ROOT}/LICENSE" ]]; then
  cp "${REPO_ROOT}/LICENSE" "${RESOURCES_DIR}/LICENSE"
fi

for svg in fiche-badge.svg fiche-mark.svg fiche-logo.svg; do
  if [[ -f "${REPO_ROOT}/assets/${svg}" ]]; then
    cp "${REPO_ROOT}/assets/${svg}" "${RESOURCES_DIR}/${svg}"
  fi
done

generate_iconset_node() {
  local svg_path="$1"
  local out_dir="$2"
  command -v node >/dev/null 2>&1 || return 1
  NODE_PATH="${REPO_ROOT}/node_modules" node - "${svg_path}" "${out_dir}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const [svgPath, outDir] = process.argv.slice(2);
const entries = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

(async () => {
  const img = await loadImage(svgPath);
  for (const [filename, size] of entries) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);
    fs.writeFileSync(path.join(outDir, filename), canvas.toBuffer('image/png'));
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
}

generate_iconset_swift() {
  local svg_path="$1"
  local out_dir="$2"
  swift - "${svg_path}" "${out_dir}" <<'SWIFT'
import AppKit
import Foundation

let args = CommandLine.arguments
let svgPath = args[1]
let outDir = args[2]

guard let img = NSImage(contentsOfFile: svgPath) else {
    fputs("Failed to load SVG at \(svgPath)\n", stderr)
    exit(1)
}

let entries: [(String, Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

for (name, px) in entries {
    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: px,
        pixelsHigh: px,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        exit(1)
    }
    rep.size = NSSize(width: px, height: px)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    img.draw(in: NSRect(x: 0, y: 0, width: px, height: px))
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else {
        exit(1)
    }
    try png.write(to: URL(fileURLWithPath: outDir).appendingPathComponent(name))
}
SWIFT
}

if [[ -f "${ICON_SVG}" ]]; then
  echo "==> Generating AppIcon.icns from assets/fiche-mark.svg..."
  if ! generate_iconset_node "${ICON_SVG}" "${ICONSET_DIR}"; then
    echo "    @napi-rs/canvas unavailable; falling back to Swift AppKit rasterizer..."
    generate_iconset_swift "${ICON_SVG}" "${ICONSET_DIR}"
  fi
  iconutil -c icns "${ICONSET_DIR}" -o "${RESOURCES_DIR}/AppIcon.icns"
  rm -rf "${ICONSET_DIR}"
else
  echo "WARNING: ${ICON_SVG} not found; skipping AppIcon.icns generation" >&2
fi

cat > "${CONTENTS_DIR}/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${SHORT_VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${BUILD_VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>MIT License — Copyright (c) 2026 Srinivas Pendela</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>FicheBar uses Terminal automation to launch wrapped coding agent CLIs routed through the local Fiche proxy.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
EOF

echo "==> Ad-hoc signing ${APP_DIR}..."
codesign --force --deep -s - "${APP_DIR}"

if [[ "${INSTALL}" -eq 1 ]]; then
  TARGET_APP="/Applications/${APP_NAME}.app"
  echo "==> Installing to ${TARGET_APP}..."
  if pgrep -x "${APP_NAME}" >/dev/null 2>&1; then
    pkill -x "${APP_NAME}" || true
    sleep 0.4
  fi
  rm -rf "${TARGET_APP}"
  ditto "${APP_DIR}" "${TARGET_APP}"
  echo "==> Launching ${TARGET_APP}..."
  open -a "${TARGET_APP}"
else
  echo "==> Built ${APP_DIR} (--no-install)"
fi
