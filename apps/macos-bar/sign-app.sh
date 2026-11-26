#!/usr/bin/env bash
# sign-app.sh — code-sign an assembled FicheBar.app bundle.
#
# Usage:
#   ./sign-app.sh [--adhoc] <App.app>
#
# Modes:
#   --adhoc     Ad-hoc signature ("-"); local development only, never distributed.
#   (default)   Developer ID Application + Hardened Runtime + secure timestamp + entitlements.plist.
#               Uses $DEV_ID if set, or auto-selects the first Developer ID Application
#               identity available in the active keychain search list.
#
# Never prints signing identities, team IDs, or keychain paths to stdout.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ADHOC=0
APP_DIR=""
for arg in "$@"; do
  case "${arg}" in
    --adhoc) ADHOC=1 ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    -*)
      echo "Unknown flag: ${arg}" >&2
      exit 2
      ;;
    *)
      if [[ -n "${APP_DIR}" ]]; then
        echo "Unexpected extra argument: ${arg}" >&2
        exit 2
      fi
      APP_DIR="${arg}"
      ;;
  esac
done

[[ -n "${APP_DIR}" ]] || { echo "Usage: sign-app.sh [--adhoc] <App.app>" >&2; exit 2; }
[[ -d "${APP_DIR}/Contents" ]] || { echo "ERROR: ${APP_DIR} is not a valid .app bundle" >&2; exit 2; }

ENTITLEMENTS="${ENTITLEMENTS:-${SCRIPT_DIR}/entitlements.plist}"

# Strip extended attributes (quarantine, FinderInfo, resource forks) and AppleDouble files.
xattr -cr "${APP_DIR}" 2>/dev/null || true
find "${APP_DIR}" -name '._*' -delete 2>/dev/null || true

if [[ "${ADHOC}" -eq 1 ]]; then
  echo "==> Signing ${APP_DIR} (ad-hoc, local dev only)..."
  for bin in "${APP_DIR}/Contents/MacOS/"*; do
    [[ -f "${bin}" ]] || continue
    codesign --force --sign - "${bin}"
  done
  codesign --force --sign - "${APP_DIR}"
  codesign --verify --deep --strict "${APP_DIR}"
  exit 0
fi

[[ -f "${ENTITLEMENTS}" ]] || { echo "ERROR: entitlements not found at ${ENTITLEMENTS}" >&2; exit 3; }

SIGN_ID="${DEV_ID:-}"
if [[ -z "${SIGN_ID}" ]]; then
  SIGN_ID="$(security find-identity -v -p codesigning \
    | sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' | head -n 1 || true)"
fi
if [[ -z "${SIGN_ID}" ]]; then
  echo "ERROR: No Developer ID Application identity found (set DEV_ID or import Developer ID cert)" >&2
  exit 3
fi

echo "==> Signing ${APP_DIR} with Developer ID (Hardened Runtime + secure timestamp)..."
for bin in "${APP_DIR}/Contents/MacOS/"*; do
  [[ -f "${bin}" ]] || continue
  codesign --force --options runtime --timestamp \
    --entitlements "${ENTITLEMENTS}" \
    --sign "${SIGN_ID}" "${bin}"
done
codesign --force --options runtime --timestamp \
  --entitlements "${ENTITLEMENTS}" \
  --sign "${SIGN_ID}" "${APP_DIR}"
unset SIGN_ID

echo "==> Verifying Developer ID signature and Hardened Runtime..."
codesign --verify --deep --strict --verbose=2 "${APP_DIR}"
SIGN_INFO="$(codesign -dvv "${APP_DIR}" 2>&1)"
printf '%s\n' "${SIGN_INFO}" | grep -q 'flags=.*runtime' || {
  echo "ERROR: Hardened Runtime flag missing after codesign" >&2
  exit 4
}
printf '%s\n' "${SIGN_INFO}" | grep -q 'Timestamp=' || {
  echo "ERROR: Secure timestamp missing after codesign" >&2
  exit 4
}
printf '%s\n' "${SIGN_INFO}" | grep -q 'Authority=Developer ID Application:' || {
  echo "ERROR: Developer ID Application authority missing after codesign" >&2
  exit 4
}
echo "==> Signature verified cleanly (Hardened Runtime + Timestamp present)."
