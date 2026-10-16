#!/usr/bin/env bash
# fold-launcher.sh — macOS only: make "opencode X the fold" a double-clickable app.
#
# Builds ~/Applications/opencode X the fold.app, whose launcher brings the running desktop dev app
# to the front or starts the dev stack (`bun run dev` in packages/desktop) from this checkout. If
# the Dock holds a direct shortcut to the cached "OpenCode Dev.app" (which opens a bare Electron
# "how to run an app" screen), that shortcut is repointed at the launcher. Safe to re-run.
set -euo pipefail
[ "$(uname -s)" = Darwin ] || exit 0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun_bin="$(command -v bun)"
app="${FOLD_LAUNCHER_DIR:-$HOME/Applications}/opencode X the fold.app"
icon="$here/brand/the-fold-app-icon-dark-1024.png"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>opencode X the fold</string>
  <key>CFBundleDisplayName</key><string>opencode X the fold</string>
  <key>CFBundleIdentifier</key><string>ai.opencode.fold.launcher</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
PLIST

# The launcher never names the content-hashed dev bundle; it foregrounds the running
# window, waits out a boot already in progress, or starts the stack. It never wedges on
# a lock whose owner is gone, and never no-ops silently when the window has died.
cat > "$app/Contents/MacOS/launcher" <<LAUNCHER
#!/bin/zsh
set -u
REPO="$here"
BUN="$bun_bin"
LOCK="/tmp/opencode-fold-launch.lock"
PIDFILE="\$LOCK/pid"
LOG="\$HOME/Library/Logs/opencode-fold-launch.log"
export PATH="$(dirname "$bun_bin"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

notify() { osascript -e "display notification \\"\$1\\" with title \\"opencode X the fold\\"" >/dev/null 2>&1 || true; }
log() { print -r -- "\$(date '+%Y-%m-%d %H:%M:%S') \$1" >> "\$LOG" 2>/dev/null || true; }

# The dev app's Electron main process, matched on its own path — not a shell that merely names it.
dev_main() { pgrep -f "opencode-dev/.*/OpenCode Dev\.app/Contents/MacOS/Electron" | head -1; }
dev_booting() { pgrep -f "electron-vite" >/dev/null 2>&1 || pgrep -f "scripts/dev\.ts" >/dev/null 2>&1; }

# Bring an already-running window to the front, whatever its content-hashed bundle path.
foreground() {
  local pid exe bundle
  pid="\$(dev_main)"
  [[ -z "\$pid" ]] && return 1
  exe="\$(ps -o comm= -p "\$pid" 2>/dev/null)"
  bundle="\${exe%/Contents/MacOS/Electron}"
  [[ -n "\$bundle" && -d "\$bundle" ]] || return 1
  open "\$bundle"
  return 0
}

foreground && exit 0

# Another launch owns the lock and its process is alive: it is booting. Wait for its
# window; never start a second stack that would fight it for port 3084.
if [[ -d "\$LOCK" ]]; then
  owner="\$(cat "\$PIDFILE" 2>/dev/null || true)"
  if [[ -n "\$owner" ]] && kill -0 "\$owner" 2>/dev/null; then
    for _ in {1..30}; do foreground && exit 0; sleep 2; done
    notify "The dev stack is still starting; see \$LOG"
    exit 0
  fi
  log "clearing stale lock (owner \${owner:-none} is gone)"
  rm -rf "\$LOCK" 2>/dev/null || true
fi

# A watcher is alive but no window is up: booting, or its window died. Wait for the
# window instead of exiting silently as the old guard did; report if it never appears.
if dev_booting; then
  for _ in {1..45}; do foreground && exit 0; sleep 2; done
  notify "The dev stack is running but no window appeared; see \$LOG"
  exit 0
fi

mkdir -p "\$LOCK" 2>/dev/null || exit 0
print -r -- "\$\$" > "\$PIDFILE" 2>/dev/null || true
trap 'rm -rf "\$LOCK" 2>/dev/null || true' EXIT INT TERM

cd "\$REPO" || { log "repo missing: \$REPO"; notify "repo not found: \$REPO"; exit 1; }
notify "Starting the dev stack — the window appears in about a minute."
# Keep the log bounded without losing the last crash: rotate past 4 MB.
if [[ -f "\$LOG" ]] && [[ "\$(wc -c < "\$LOG" 2>/dev/null || echo 0)" -gt 4000000 ]]; then mv -f "\$LOG" "\$LOG.1" 2>/dev/null || true; fi
"\$BUN" run dev:desktop >>"\$LOG" 2>&1
LAUNCHER
chmod +x "$app/Contents/MacOS/launcher"

if [ -f "$icon" ]; then
  set="$(mktemp -d)/AppIcon.iconset"; mkdir -p "$set"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$icon" --out "$set/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$icon" --out "$set/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$set" -o "$app/Contents/Resources/AppIcon.icns"
fi
touch "$app"
echo "launcher: $app"

# Repoint a Dock shortcut that opens the cached dev bundle directly; leave a Dock without one alone.
python3 - "$app" <<'PY'
import plistlib, subprocess, sys, urllib.parse
app = sys.argv[1]
d = plistlib.loads(subprocess.run(["defaults", "export", "com.apple.dock", "-"], capture_output=True).stdout)
n = 0
for it in d.get("persistent-apps", []):
    t = it.get("tile-data", {})
    if "opencode-dev" in t.get("file-data", {}).get("_CFURLString", "") and "OpenCode%20Dev.app" in t["file-data"]["_CFURLString"]:
        # A fresh file-data: the Dock follows the saved bookmark over the URL, so the old one must go.
        t["file-data"] = {"_CFURLString": "file://" + urllib.parse.quote(app) + "/", "_CFURLStringType": 15}
        t.pop("book", None)
        t["file-label"] = "opencode X the fold"
        n += 1
if n:
    p = subprocess.run(["defaults", "import", "com.apple.dock", "-"], input=plistlib.dumps(d))
    subprocess.run(["killall", "Dock"])
    print(f"dock: repointed {n} shortcut(s) at the launcher")
PY
