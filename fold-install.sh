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

cd "$(dirname "$0")"

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

echo "building opencode-fold for ${target} (this takes a few minutes)"
# Stamp a normal-looking version from this tree's own package.json, with the
# fork's commit as provenance: release gates check semver (>= 1.18.0) and a
# bare dev build reports 0.0.0-<branch>-<ts>, which fails them.
tree_version=$(bun -e 'console.log((await Bun.file("package.json").json()).version)')
OPENCODE_VERSION="${tree_version}-fold.$(git rev-parse --short HEAD)" \
  bun run --cwd packages/cli script/build.ts --single --outdir=dist-fold

built=$(ls packages/cli/dist-fold/cli-*/bin/opencode 2>/dev/null | head -1 || true)
[ -n "$built" ] && [ -x "$built" ] || { echo "build did not produce a binary under packages/cli/dist-fold" >&2; exit 1; }

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
echo "installed $dest/opencode from opencode-fold @ $(git rev-parse --short HEAD) on upstream $(git rev-parse --short upstream/dev)"

# The fold stack: report whether the live doorway answers, and whether it
# speaks this fork's contract (the plugin also checks at startup, logs, and
# fails open either way).
door="${FOLD_URL:-http://127.0.0.1:11436}"
if curl -s -m 2 "$door/v1/hooks/opencode" | grep -q '"fold"'; then
  echo "doorway: live at $door with the fold event"
else
  echo "doorway: no contract answer at $door (opencode still runs as upstream; start the fold stack or set FOLD_URL)"
fi
