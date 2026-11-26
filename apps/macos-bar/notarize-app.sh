#!/usr/bin/env bash
# notarize-app.sh — submit an already Developer-ID-signed .app to Apple Notary Service,
# wait for acceptance, staple the ticket, validate stapling, and check Gatekeeper.
#
# Usage:
#   ./notarize-app.sh <App.app> [--key <AuthKey.p8>] [--key-id <ID>] [--issuer <UUID> | --issuer-file <path>]
#
# Also honors env vars:
#   APP_STORE_CONNECT_API_KEY_PATH
#   APP_STORE_CONNECT_KEY_ID
#   APP_STORE_CONNECT_ISSUER_ID
#
# Never prints API keys, key IDs, or issuer UUIDs to logs.
set -euo pipefail

APP_DIR=""
KEY_PATH="${APP_STORE_CONNECT_API_KEY_PATH:-}"
KEY_ID="${APP_STORE_CONNECT_KEY_ID:-}"
ISSUER_ID="${APP_STORE_CONNECT_ISSUER_ID:-}"
ISSUER_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --key)
      KEY_PATH="${2:-}"; shift 2 ;;
    --key-id)
      KEY_ID="${2:-}"; shift 2 ;;
    --issuer)
      ISSUER_ID="${2:-}"; shift 2 ;;
    --issuer-file)
      ISSUER_FILE="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,14p' "$0"
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
    *)
      if [[ -n "${APP_DIR}" ]]; then
        echo "Unexpected extra argument: $1" >&2
        exit 2
      fi
      APP_DIR="$1"
      shift
      ;;
  esac
done

[[ -n "${APP_DIR}" ]] || { echo "Usage: notarize-app.sh <App.app> [--key <AuthKey.p8>] [--key-id <ID>] [--issuer <UUID> | --issuer-file <path>]" >&2; exit 2; }
[[ -d "${APP_DIR}/Contents" ]] || { echo "ERROR: ${APP_DIR} is not a valid .app bundle" >&2; exit 2; }

if [[ -z "${ISSUER_ID}" && -n "${ISSUER_FILE}" ]]; then
  [[ -f "${ISSUER_FILE}" ]] || { echo "ERROR: issuer file not found: ${ISSUER_FILE}" >&2; exit 2; }
  ISSUER_ID="$(grep -Eo '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' "${ISSUER_FILE}" | head -n 1 || true)"
fi

[[ -n "${KEY_PATH}" && -f "${KEY_PATH}" ]] || { echo "ERROR: App Store Connect .p8 key file missing or unreadable" >&2; exit 2; }
[[ -n "${KEY_ID}" ]] || { echo "ERROR: missing --key-id / APP_STORE_CONNECT_KEY_ID" >&2; exit 2; }
[[ "${ISSUER_ID}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || {
  echo "ERROR: missing or invalid issuer UUID" >&2
  exit 2
}

codesign --verify --deep --strict "${APP_DIR}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
APP_BASE="$(basename "${APP_DIR}")"
NOTARIZE_ZIP="${TMP_DIR}/${APP_BASE}.zip"

echo "==> Packaging ${APP_BASE} for Apple notarization..."
/usr/bin/ditto --norsrc -c -k --keepParent "${APP_DIR}" "${NOTARIZE_ZIP}"

SUBMIT_JSON="${TMP_DIR}/notary-submit.json"
SUBMIT_ERR="${TMP_DIR}/notary-submit.err"
echo "==> Submitting to Apple Notary Service (waiting for completion)..."
set +e
xcrun notarytool submit "${NOTARIZE_ZIP}" \
  --key "${KEY_PATH}" \
  --key-id "${KEY_ID}" \
  --issuer "${ISSUER_ID}" \
  --output-format json \
  --wait > "${SUBMIT_JSON}" 2> "${SUBMIT_ERR}"
SUBMIT_RC=$?
set -e

PARSED_NOTARY="$(python3 -I - "${SUBMIT_JSON}" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8") as fh:
        data = json.load(fh)
    status = str(data.get("status", "")).strip()
    sub_id = str(data.get("id", "")).strip()
    print(f"{status}\t{sub_id}")
except Exception:
    print("\t")
PY
)"
IFS=$'\t' read -r NOTARY_STATUS SUBMISSION_ID <<< "${PARSED_NOTARY}"

if [[ "${SUBMIT_RC}" -ne 0 || "${NOTARY_STATUS}" != "Accepted" ]]; then
  echo "ERROR: Apple notarization failed (exit=${SUBMIT_RC}, status='${NOTARY_STATUS:-unknown}', id='${SUBMISSION_ID:-none}')." >&2
  if [[ -s "${SUBMIT_ERR}" ]]; then
    cat "${SUBMIT_ERR}" >&2
  fi
  if [[ -n "${SUBMISSION_ID}" ]]; then
    echo "==> Fetching Apple Notary Service log for ${SUBMISSION_ID}..." >&2
    xcrun notarytool log "${SUBMISSION_ID}" \
      --key "${KEY_PATH}" \
      --key-id "${KEY_ID}" \
      --issuer "${ISSUER_ID}" >&2 || true
  fi
  exit 5
fi

echo "==> Stapling notarization ticket..."
xcrun stapler staple "${APP_DIR}"
xcrun stapler validate "${APP_DIR}"

echo "==> Verifying Gatekeeper assessment..."
spctl -a -vvv -t exec "${APP_DIR}"
echo "==> Notarization, stapling, and Gatekeeper verification succeeded."
