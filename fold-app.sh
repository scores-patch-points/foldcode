#!/usr/bin/env bash
# fold-app.sh — build the fold desktop app (.app/.dmg/.zip) and install it to /Applications.
#
# The desktop package bundles a CLI binary, and for this fork that binary must be the ONE
# fold-install.sh already built (the doorway lives in the CLI), not the upstream `dev` CLI that
# prebuild's dev path downloads. So this script stages the built fold CLI into the desktop
# resources right before packaging — after `bun run build`, because that runs the `prebuild`
# hook whose dev path downloads and overwrites resources/opencode-cli. It then lets
# electron-builder package the app (dev channel: ad-hoc signed, see
# packages/desktop/resources/entitlements.dev.plist) and copies the .app into /Applications.
#
#   ./fold-app.sh                 build and install
#   FOLD_APP_DIR=~/Applications ./fold-app.sh    install somewhere else
#   OPENCODE_CHANNEL=beta ./fold-app.sh          package another channel (needs its own signing)
set -euo pipefail
[ "$(uname -s)" = Darwin ] || { echo "fold-app.sh is macOS-only" >&2; exit 0; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here"

command -v bun >/dev/null || { echo "bun is required: https://bun.sh" >&2; exit 1; }

desktop="packages/desktop"

# Prefer an already-built fold CLI (fold-install.sh leaves one under ~/.cache/openfold);
# build it with fold-install.sh on first use.
cli_dir=""
for candidate in "${FOLD_APP_CLI:-}" "$HOME"/.cache/openfold/cli-*/; do
  [ -n "$candidate" ] || continue
  [ -x "${candidate%/}/bin/opencode" ] && cli_dir="${candidate%/}" && break
done
if [ -z "$cli_dir" ]; then
  echo "no built fold CLI found; running fold-install.sh"
  ./fold-install.sh
  for candidate in "$HOME"/.cache/openfold/cli-*/; do
    [ -x "${candidate%/}/bin/opencode" ] && cli_dir="${candidate%/}" && break
  done
fi
[ -n "$cli_dir" ] || { echo "could not find or build a fold CLI" >&2; exit 1; }

version="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).version)' "$cli_dir/package.json")"

channel="${OPENCODE_CHANNEL:-dev}"
echo "building the desktop bundle ($channel)"
( cd "$desktop" && bun run build && bun ./scripts/copy-icons.ts "$channel" && bun ./scripts/copy-metainfo.ts "$channel" )

# Stage the fold CLI AFTER the build: `bun run build` runs the `prebuild` hook, whose dev path
# downloads the upstream dev CLI and overwrites resources/opencode-cli. Put the fold CLI back.
echo "bundling fold CLI $version from $cli_dir"
cp "$cli_dir/bin/opencode" "$desktop/resources/opencode-cli"
printf '%s' "$version" > "$desktop/resources/opencode-cli.version"
chmod +x "$desktop/resources/opencode-cli"
codesign --force --sign - "$desktop/resources/opencode-cli"

echo "packaging (electron-builder)"
( cd "$desktop" && CSC_IDENTITY_AUTO_DISCOVERY=false bun run package:mac )

app="$desktop/dist/mac-arm64/openfold.app"
[ -d "$app" ] || { echo "packaging produced no app at $app" >&2; exit 1; }
bundled="$(cat "$app/Contents/Resources/opencode-cli.version" 2>/dev/null || echo unknown)"
[ "$bundled" = "$version" ] || { echo "bundled CLI version $bundled != fold CLI $version" >&2; exit 1; }
echo "confirmed bundled fold CLI: $bundled"

# The new build must own the managed port: reap any orphaned service from a previous
# instance (a crash, a kill, or a rebuild that replaced the running bundle).
"$here/fold-reaper.sh" reap || true

dest="${FOLD_APP_DIR:-/Applications}/openfold.app"
echo "installing -> $dest"
rm -rf "$dest"
ditto "$app" "$dest"
xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
codesign --verify --strict "$dest" >/dev/null 2>&1 && echo "seal valid" || echo "warning: seal could not be verified"

# A rebuilt bundle no longer matches its macOS privacy grant: the stale Files-and-Folders
# approval fails SILENTLY (EPERM surfaces as a typed 503 on every location request — the
# agent picker included). Reset the app's folder grants so the next launch re-prompts;
# one Allow per rebuild is the honest price.
bundle_id="$(defaults read "$dest/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || true)"
if [ -n "$bundle_id" ]; then
  for svc in SystemPolicyDownloadsFolder SystemPolicyDocumentsFolder SystemPolicyDesktopFolder; do
    tccutil reset "$svc" "$bundle_id" >/dev/null 2>&1 || true
  done
  echo "folder grants reset for $bundle_id — the next launch re-prompts (click Allow)"
fi

echo "installed: $dest"
