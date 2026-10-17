#!/bin/sh
# fold-door.sh — keep the fold's ground-producer alive for the app.
#
# The desktop app ("opencode X the fold") grounds nothing by itself. Every answer's provenance
# (the `fold facing` row: [S#] grounded, [M] the mouth's own, the standing cell) is computed by
# the fold door — khora's opencode doorway, mounted on the proxy at FOLD_URL, default
# http://127.0.0.1:11436. With the door down the app FAILS OPEN into plain opencode and grounds
# nothing; it cannot tell the user why, because it has no door to ask.
#
# This script is the door's lifecycle, the one dependency the app cannot manage alone:
# probe the contract, start the local stack when it does not answer, and keep watching.
# `install` hands it to launchd so the door survives logout, crash and reboot.
#
#   ./fold-door.sh start       ensure the door answers, then exit (0 = answering, 1 = gave up)
#   ./fold-door.sh run         supervise: probe, restart on failure (for launchd; never exits)
#   ./fold-door.sh status      print the current verdict, exit 0/1
#   ./fold-door.sh install     install the launchd agent (macOS) and start it
#   ./fold-door.sh uninstall   stop and remove the launchd agent
#
# Placement (see the note above): the door must run on the box that holds the workspace bytes —
# groundCheck reads the disk, so a door that cannot see the files flags them `unknown_path`.
# FOLD_STACK_DIR names that box's fold stack (default: the khora checkout beside this repo).
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
stack="${FOLD_STACK_DIR:-$here/../khora}"
door="${FOLD_URL:-http://127.0.0.1:11436}"
host="$(printf '%s' "$door" | sed -E 's#^https?://([^/:]+).*#\1#')"
port="$(printf '%s' "$door" | sed -E 's#^https?://[^/:]+:?([0-9]*).*#\1#' )"
port="${port:-11436}"
label="ai.opencode.fold.door"

if [ "$(uname -s)" = Darwin ]; then log="$HOME/Library/Logs/fold-door.log"; else log="${XDG_STATE_HOME:-$HOME/.local/state}/fold-door.log"; fi
mkdir -p "$(dirname "$log")" 2>/dev/null || true

# launchd is its own responsible process: it cannot read a repo inside ~/Downloads (macOS
# Files-and-Folders privacy), so the agent must run THIS script from a location macOS does not
# guard. `install` copies it here and points the agent at the copy.
home_dir="${FOLD_DOOR_HOME:-$HOME/.local/share/fold-door}"

say() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$log" 2>/dev/null || true; }

# The contract is the handshake: the door answers GET /v1/hooks/opencode with its event list,
# and a fold door lists "ground". A reachable port that does not answer this is not our door.
answering() { curl -s -m 3 "$door/v1/hooks/opencode" 2>/dev/null | grep -q '"ground"'; }

start_door() {
  [ -d "$stack" ] || { say "no fold stack at $stack (set FOLD_STACK_DIR)"; return 1; }
  # launchd's process cannot read a stack inside ~/Downloads (macOS Files-and-Folders privacy):
  # stat succeeds, the read does not. Name the typed reason instead of a silent EPERM.
  if ! head -c 1 "$stack/opencode-doorway.mjs" >/dev/null 2>&1; then
    say "the stack at $stack is unreadable by this process — grant Full Disk Access to the door agent, or move the stack out of ~/Downloads"
    return 1
  fi
  if [ -x "$stack/local-up.sh" ]; then
    say "starting the fold pipeline: $stack/local-up.sh bg"
    ( cd "$stack" && ./local-up.sh bg >>"$log" 2>&1 ) || say "local-up.sh returned non-zero"
  else
    say "no local-up.sh; serving the opencode doorway alone on :$port"
    ( cd "$stack" && nohup node opencode-doorway.mjs --serve "$port" >>"$log" 2>&1 & ) || return 1
  fi
  return 0
}

wait_ready() {
  i=0
  while [ "$i" -lt 30 ]; do
    answering && return 0
    i=$((i + 1)); sleep 2
  done
  return 1
}

status() {
  if answering; then
    echo "door: answering at $door"
    curl -s -m 3 "$door/v1/hooks/opencode" | head -c 300; echo
    return 0
  fi
  echo "door: no contract answer at $door (stack: $stack)"
  return 1
}

run() {
  fails=0
  say "supervisor up (door $door, stack $stack)"
  while :; do
    if answering; then
      fails=0
    else
      fails=$((fails + 1))
      say "door not answering (miss $fails); starting the stack"
      start_door || true
      if wait_ready; then say "door recovered"; fails=0
      else
        back=$((fails < 6 ? fails * 5 : 30))
        say "door still down; retrying in ${back}s"
        sleep "$back"
        continue
      fi
    fi
    sleep 15
  done
}

agent_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>$home_dir/fold-door.sh</string><string>run</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>FOLD_STACK_DIR</key><string>$stack</string>
    <key>FOLD_URL</key><string>$door</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict></plist>
PLIST
}

install_agent() {
  [ "$(uname -s)" = Darwin ] || { echo "launchd install is macOS-only; run './fold-door.sh run' under your init" >&2; return 1; }
  mkdir -p "$home_dir"
  cp "$here/fold-door.sh" "$home_dir/fold-door.sh"
  chmod +x "$home_dir/fold-door.sh"
  dir="$HOME/Library/LaunchAgents"; plist="$dir/$label.plist"
  mkdir -p "$dir"
  agent_plist >"$plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "installed $plist (agent runs $home_dir/fold-door.sh; the door survives logout, crash and reboot)"
}

uninstall_agent() {
  plist="$HOME/Library/LaunchAgents/$label.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "removed $plist"
}

case "${1:-start}" in
  start)
    if answering; then echo "door: answering at $door"; exit 0; fi
    start_door || true
    if wait_ready; then echo "door: answering at $door"; exit 0; fi
    echo "door: gave up starting the stack (see $log)" >&2
    exit 1
    ;;
  run) run ;;
  status) status ;;
  install) install_agent ;;
  uninstall) uninstall_agent ;;
  *) echo "usage: $0 [start|run|status|install|uninstall]" >&2; exit 1 ;;
esac
