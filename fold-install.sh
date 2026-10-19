#!/usr/bin/env bash
# fold-install.sh — build this checkout and install it as the machine's opencode.
#
# The update story, in one line: pull the repo, then
#   ./fold-sync.sh --install
# rebases onto upstream, proves the fork's delta did not grow, rebuilds, and
# atomically swaps the binary. The replaced binary is kept at
# ~/.opencode/bin/opencode.upstream.bak.
#
# The app updates with the fold repos, too: the doorway lives in khora
# (opencode-doorway.mjs), spoken over POST /v1/hooks/opencode. A fold update
# needs no app update — the contract is the handshake, and the plugin fails
# open against anything it does not understand.
set -euo pipefail

# One command, from anywhere:
#   curl -fsSL https://raw.githubusercontent.com/scores-patch-points/foldcode/fold/fold-install.sh | bash
# Run from a checkout, it builds that checkout. Run from a pipe, it clones (or
# updates) the fork into ~/.foldcode first, then builds. Override with
# FOLD_REPO_DIR, FOLD_REPO_URL, FOLD_BRANCH.
here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ -z "${here:-}" ] || [ ! -f "$here/packages/cli/script/build.ts" ]; then
  repo="${FOLD_REPO_DIR:-$HOME/.foldcode}"
  url="${FOLD_REPO_URL:-https://github.com/scores-patch-points/foldcode.git}"
  branch="${FOLD_BRANCH:-fold}"
  command -v git >/dev/null || { echo "git is required" >&2; exit 1; }
  if [ -d "$repo/.git" ]; then
    echo "updating $repo ($branch)"
    git -C "$repo" fetch origin "$branch" --depth 1
    git -C "$repo" checkout -q "$branch"
    git -C "$repo" reset --hard "origin/$branch"
  else
    echo "cloning $url ($branch) → $repo"
    git clone --depth 1 --branch "$branch" "$url" "$repo"
  fi
  exec "$repo/fold-install.sh"
fi

cd "$here"
command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }

# Dependencies must exist before the build (it runs with --skip-install). A
# fresh clone has none, so install from the committed lockfile; --frozen-lockfile
# keeps the tree clean for fold-sync's delta guard, with a plain install as a
# fallback when the lock is out of date. Idempotent and cheap when already done.
echo "installing dependencies (bun install)"
bun install --frozen-lockfile || bun install

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac
target="${os}-${arch}"

echo "building foldcode for ${target} (this takes a few minutes)"
# Stamp a normal-looking version from this tree's own package.json, with the
# fork's commit as provenance: release gates check semver (>= 1.18.0) and a
# bare dev build reports 0.0.0-<branch>-<ts>, which fails them.
tree_version=$(bun -e 'console.log((await Bun.file("package.json").json()).version)')
outdir="${FOLD_BUILD_DIR:-$HOME/.cache/foldcode}"
rm -rf "$outdir"
OPENCODE_VERSION="${tree_version}-fold.$(git rev-parse --short HEAD)" \
  bun run --cwd packages/cli script/build.ts --single --skip-install --outdir="$outdir"
# The build's dependency step can reorder a manifest; the tree must stay clean
# for fold-sync's delta guard.
git checkout -- packages/cli/package.json 2>/dev/null || true

built=$(ls "$outdir"/cli-*/bin/opencode 2>/dev/null | head -1 || true)
[ -n "$built" ] && [ -x "$built" ] || { echo "build did not produce a binary under $outdir" >&2; exit 1; }

dest="${OPENCODE_BIN_DIR:-$HOME/.opencode/bin}"
mkdir -p "$dest"
if [ -x "$dest/opencode" ] && [ ! -f "$dest/opencode.upstream.bak" ]; then
  cp "$dest/opencode" "$dest/opencode.upstream.bak"
  echo "kept the replaced binary at $dest/opencode.upstream.bak"
fi
cp "$built" "$dest/opencode.new"
chmod +x "$dest/opencode.new"
mv -f "$dest/opencode.new" "$dest/opencode"

"$dest/opencode" --version
base=$(git rev-parse --short upstream/dev 2>/dev/null || echo unknown)
echo "installed $dest/opencode from foldcode @ $(git rev-parse --short HEAD) (upstream base: $base)"

# macOS: a double-clickable "foldcode" app that starts the desktop dev stack from this checkout.
[ "$os" = darwin ] && ./fold-launcher.sh || true

# The fold stack: report whether the live doorway answers, and whether it
# speaks this fork's contract (the plugin also checks at startup, logs, and
# fails open either way).
door="${FOLD_URL:-http://127.0.0.1:11436}"
if curl -s -m 2 "$door/v1/hooks/opencode" | grep -q '"door"'; then
  echo "doorway: live at $door (the door answers the handshake)"
else
  echo "doorway: no contract answer at $door (opencode still runs as upstream; start the fold stack or set FOLD_URL)"
fi
