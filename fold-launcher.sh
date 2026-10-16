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

# The launcher never names the content-hashed dev bundle; it activates the running app or starts the stack.
cat > "$app/Contents/MacOS/launcher" <<LAUNCHER
#!/bin/zsh
set -u
REPO="$here"
BUN="$bun_bin"
LOCK="/tmp/opencode-fold-launch.lock"
LOG="\$HOME/Library/Logs/opencode-fold-launch.log"
export PATH="$(dirname "$bun_bin"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

dev_main() { pgrep -f "opencode-dev/.*/OpenCode Dev\.app/Contents/MacOS/Electron" | head -1; }
dev_booting() { pgrep -f "electron-vite.js dev" >/dev/null 2>&1; }

pid="\$(dev_main)"
if [[ -n "\$pid" ]]; then
  exe="\$(ps -o comm= -p "\$pid" 2>/dev/null)"
  bundle="\${exe%/Contents/MacOS/Electron}"
  [[ -n "\$bundle" && -d "\$bundle" ]] && open "\$bundle"
  exit 0
fi
dev_booting && exit 0

# A lock whose owner died (a crashed or killed launch) must not block every later launch.
if [[ -d "\$LOCK" ]] && ! pgrep -f "bun.* run dev" >/dev/null 2>&1; then rmdir "\$LOCK" 2>/dev/null; fi
mkdir "\$LOCK" 2>/dev/null || exit 0
osascript -e 'display notification "Starting the dev stack — the window appears in about a minute." with title "opencode X the fold"' >/dev/null 2>&1
cd "\$REPO/packages/desktop" || { rmdir "\$LOCK"; exit 1; }
"\$BUN" run dev >"\$LOG" 2>&1
rmdir "\$LOCK" 2>/dev/null || true
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
