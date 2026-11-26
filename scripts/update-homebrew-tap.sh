#!/usr/bin/env bash
#
# update-homebrew-tap.sh <X.Y.Z> [--dry-run] [--no-merge] [--formula-only | --cask-only]
#
# Create or update sriinnu/homebrew-tap entries for fiche:
#   - Formula/fiche.rb   (CLI + fiche-mcp from @sriinnu/fiche npm tarball)
#   - Casks/fichebar.rb  (macOS FicheBar.app from GitHub Release zip asset)
#
# Run AFTER:
#   1. @sriinnu/fiche@<X.Y.Z> is approved and live on https://registry.npmjs.org
#   2. FicheBar-<X.Y.Z>.zip is attached to GitHub Release v<X.Y.Z> in sriinnu/fiche
#
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: update-homebrew-tap.sh <X.Y.Z> [--dry-run] [--no-merge] [--formula-only | --cask-only]

Options:
  --dry-run       Print generated Formula/fiche.rb and Casks/fichebar.rb without fetching/pushing to tap
  --no-merge      Push signed commit + open PR on sriinnu/homebrew-tap, do not squash-merge
  --formula-only  Only update Formula/fiche.rb
  --cask-only     Only update Casks/fichebar.rb
  -h, --help      Show this help
EOF
}

VERSION=""
DRY_RUN=0
MERGE_PR=1
DO_FORMULA=1
DO_CASK=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --no-merge) MERGE_PR=0 ;;
    --formula-only) DO_FORMULA=1; DO_CASK=0 ;;
    --cask-only) DO_FORMULA=0; DO_CASK=1 ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        echo "Unexpected extra argument: $1" >&2
        usage >&2
        exit 2
      fi
      VERSION="$1"
      ;;
  esac
  shift
done

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "Usage: update-homebrew-tap.sh <X.Y.Z> [--dry-run] [--no-merge] [--formula-only | --cask-only]" >&2
  exit 2
fi

REPO="${REPO:-sriinnu/fiche}"
TAP="${TAP:-sriinnu/homebrew-tap}"
if [[ ! "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || [[ "$REPO" == *".."* ]]; then
  echo "Invalid REPO (expected owner/repo): $REPO" >&2
  exit 2
fi
if [[ ! "$TAP" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || [[ "$TAP" == *".."* ]]; then
  echo "Invalid TAP (expected owner/repo): $TAP" >&2
  exit 2
fi
TAG="v${VERSION}"
NPM_TARBALL_URL="https://registry.npmjs.org/@sriinnu/fiche/-/fiche-${VERSION}.tgz"
CASK_ZIP_NAME="FicheBar-${VERSION}.zip"
CASK_ZIP_URL="https://github.com/${REPO}/releases/download/v#{version}/FicheBar-#{version}.zip"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

FORMULA_SHA="0000000000000000000000000000000000000000000000000000000000000000"
CASK_SHA="0000000000000000000000000000000000000000000000000000000000000000"

if [[ "$DRY_RUN" -eq 0 ]]; then
  if [[ "$DO_FORMULA" -eq 1 ]]; then
    echo "==> Downloading ${NPM_TARBALL_URL} to compute sha256..."
    curl -fsSL "$NPM_TARBALL_URL" -o "$tmp/fiche-${VERSION}.tgz"
    FORMULA_SHA="$(shasum -a 256 "$tmp/fiche-${VERSION}.tgz" | awk '{print $1}')"
    echo "    formula sha256: ${FORMULA_SHA}"
  fi
  if [[ "$DO_CASK" -eq 1 ]]; then
    echo "==> Downloading ${CASK_ZIP_NAME} and ${CASK_ZIP_NAME}.sha256 from ${REPO} release ${TAG}..."
    gh release download "$TAG" --repo "$REPO" --pattern "$CASK_ZIP_NAME" --pattern "${CASK_ZIP_NAME}.sha256" --dir "$tmp"
    CASK_SHA="$(shasum -a 256 "$tmp/$CASK_ZIP_NAME" | awk '{print $1}' | tr '[:upper:]' '[:lower:]')"
    EXPECTED_SHA="$(awk '{print $1}' "$tmp/${CASK_ZIP_NAME}.sha256" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"
    if [[ ! "$EXPECTED_SHA" =~ ^[0-9a-f]{64}$ ]] || [[ "$CASK_SHA" != "$EXPECTED_SHA" ]]; then
      echo "Checksum verification failed for ${CASK_ZIP_NAME}: computed=${CASK_SHA} expected=${EXPECTED_SHA}" >&2
      exit 1
    fi
    echo "    cask sha256:    ${CASK_SHA} (verified)"
  fi
fi

render_formula() {
  cat <<EOF
class Fiche < Formula
  desc "Cache-safe hybrid optical & deterministic text context compiler + local proxy"
  homepage "https://github.com/${REPO}"
  url "${NPM_TARBALL_URL}"
  sha256 "${FORMULA_SHA}"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/fiche --version")

    request = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":' \\
              '{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"brew","version":"1"}}}'
    assert_match '"serverInfo"', pipe_output(bin/"fiche-mcp", "#{request}\n")
  end
end
EOF
}

render_cask() {
  cat <<EOF
cask "fichebar" do
  version "${VERSION}"
  sha256 "${CASK_SHA}"

  url "${CASK_ZIP_URL}"
  name "FicheBar"
  desc "Menu-bar companion and proxy controller for Fiche context compiler"
  homepage "https://github.com/${REPO}"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "FicheBar.app"

  uninstall quit: "dev.srinivas.fichebar"

  zap trash: [
    "~/.config/fiche",
    "~/.fiche",
    "~/Library/Application Support/dev.srinivas.fichebar",
    "~/Library/Caches/dev.srinivas.fichebar",
    "~/Library/HTTPStorages/dev.srinivas.fichebar",
    "~/Library/LaunchAgents/com.sriinnu.fiche.plist",
    "~/Library/Preferences/dev.srinivas.fichebar.plist",
  ]
end
EOF
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "DRY RUN (${VERSION}):"
  if [[ "$DO_FORMULA" -eq 1 ]]; then
    echo "--- Formula/fiche.rb ---"
    render_formula
  fi
  if [[ "$DO_CASK" -eq 1 ]]; then
    echo "--- Casks/fichebar.rb ---"
    render_cask
  fi
  exit 0
fi

echo "==> Cloning tap ${TAP}..."
gh repo clone "$TAP" "$tmp/tap" -- --depth 1 >/dev/null 2>&1

branch="chore/fiche-${VERSION}"
pr_state="$(gh pr view "$branch" --repo "$TAP" --json state -q .state 2>/dev/null || true)"
if [[ "$pr_state" == "OPEN" ]]; then
  echo "==> Updating existing OPEN PR branch ${branch}..."
  git -C "$tmp/tap" fetch -q origin "$branch"
  git -C "$tmp/tap" checkout -q -B "$branch" "origin/$branch"
else
  git -C "$tmp/tap" switch -q -c "$branch"
fi

mkdir -p "$tmp/tap/Formula" "$tmp/tap/Casks"
if [[ "$DO_FORMULA" -eq 1 ]]; then
  render_formula > "$tmp/tap/Formula/fiche.rb"
fi
if [[ "$DO_CASK" -eq 1 ]]; then
  render_cask > "$tmp/tap/Casks/fichebar.rb"
fi

if [[ -f "$tmp/tap/README.md" ]]; then
  python3 - "$tmp/tap/README.md" "$DO_FORMULA" "$DO_CASK" "$REPO" <<'PY'
import pathlib, sys
readme_path = pathlib.Path(sys.argv[1])
do_formula = sys.argv[2] == "1"
do_cask = sys.argv[3] == "1"
repo = sys.argv[4]
text = readme_path.read_text(encoding="utf-8")
lines = text.splitlines(keepends=True)

def insert_row(lines, marker, row):
    joined = "".join(lines)
    if row.split("|")[1].strip() in joined:
        return lines
    for i, line in enumerate(lines):
        if line.strip().startswith(marker):
            j = i + 1
            while j < len(lines) and (lines[j].strip().startswith("|") or lines[j].strip() == ""):
                if not lines[j].strip():
                    break
                j += 1
            return lines[:j] + [row + "\n"] + lines[j:]
    return lines

if do_cask:
    lines = insert_row(
        lines,
        "| `broom`",
        f"| `fichebar` | FicheBar — native menu-bar control center for Fiche context compiler | [sriinnu/fiche](https://github.com/{repo}) |",
    )
if do_formula:
    lines = insert_row(
        lines,
        "| `kosha`",
        f"| `fiche` | Fiche — cache-safe hybrid optical & deterministic text context compiler + local proxy (`fiche`, `fiche-mcp`) | [sriinnu/fiche](https://github.com/{repo}) |",
    )
readme_path.write_text("".join(lines), encoding="utf-8")
PY
fi

if git -C "$tmp/tap" diff --quiet && [[ -z "$(git -C "$tmp/tap" status --porcelain)" ]]; then
  if [[ "$pr_state" != "OPEN" ]]; then
    echo "==> Tap already matches fiche/fichebar ${VERSION} — nothing to push."
    exit 0
  fi
  echo "==> Open PR ${branch} already matches requested updates."
else
  git -C "$tmp/tap" add -A
  git -C "$tmp/tap" commit -q -S -m "fiche / fichebar ${VERSION}"
  git -C "$tmp/tap" push -q -u origin "$branch"
  if [[ "$pr_state" != "OPEN" ]]; then
    gh pr create --repo "$TAP" --base main --head "$branch" \
      --title "fiche / fichebar ${VERSION}" \
      --body "Updates Formula/fiche.rb and Casks/fichebar.rb to ${VERSION} with verified sha256 checksums from published npm and GitHub Release assets."
  fi
fi

if [[ "$MERGE_PR" -eq 1 ]]; then
  gh pr merge "$branch" --repo "$TAP" --squash --delete-branch
  echo "==> Merged into ${TAP}: brew install ${TAP%/*}/${TAP#*/}/fiche && brew install --cask ${TAP%/*}/${TAP#*/}/fichebar"
else
  echo "==> PR opened on ${TAP} branch ${branch} (--no-merge set)."
fi
