#!/bin/sh
# fold-door.sh — keep the fold's ground-producer alive for the app.
#
# The desktop app ("foldcode") grounds nothing by itself. Every answer's provenance
# (the `fold facing` row: [S#] grounded, [M] the mouth's own, the standing cell) is computed by
# the fold door — khora's opencode doorway, mounted on the proxy at FOLD_URL, default
# http://127.0.0.1:11436. With the door down the app FAILS OPEN into plain opencode and grounds
# nothing; it cannot tell the user why, because it has no door to ask.
#
# This script is the door's lifecycle, the one dependency the app cannot manage alone:
# probe the contract, start the local stack when it does not answer, and keep watching.
# `install` hands it to launchd so the door survives logout, crash and reboot.
#
#   ./fold-door.sh start       ensure the door answers (provisioning the stack if missing), then exit
#   ./fold-door.sh run         supervise: probe, restart on failure (for launchd; never exits)
#   ./fold-door.sh status      print the current verdict, exit 0/1
#   ./fold-door.sh stack       provision the stack only (clone into a safe location), then exit
#   ./fold-door.sh install     install the launchd agent (macOS) and start it
#   ./fold-door.sh uninstall   stop and remove the launchd agent
#
# Fresh machine: `install` is the whole thing. The agent starts a supervisor that, on first run,
# CLONES the stack (khora) from GitHub into ~/.khora — a location launchd can read — installs its
# one runtime dependency, starts the door, and keeps watching. No dev machine required; only
# git + node + network.
#
# Placement (see the note above): the door must run on the box that holds the workspace bytes —
# groundCheck reads the disk, so a door that cannot see the files flags them `unknown_path`.
# FOLD_STACK_DIR names an existing stack; FOLD_STACK_URL/FOLD_STACK_BRANCH name what to clone.
# FOLD_SIBLINGS_DIR optionally names where the stack's siblings (penelope, janus) live — the door
# reads its fold-note and priors there instead of failing open to an empty note; `install` carries
# it into the agent's environment.
set -eu

# launchd starts this with a near-empty PATH; the stack's tools (node, git, the senses) live in
# Homebrew and the user's bins. Put them on PATH before anything spawns.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"

here="$(cd "$(dirname "$0")" && pwd)"
# Prefer a stack the door agent can actually read: launchd is its own responsible process and
# cannot read ~/Downloads (macOS Files-and-Folders privacy), so ~/.khora (or a GH clone at
# ~/eoreader7) is the location that lets the supervisor restart the door, not just watch it.
if [ -n "${FOLD_STACK_DIR:-}" ]; then
  stack="$FOLD_STACK_DIR"
elif [ -d "$HOME/.khora" ]; then
  stack="$HOME/.khora"
elif [ -d "$HOME/eoreader7" ]; then
  stack="$HOME/eoreader7"
else
  stack="$here/../khora"
fi
[ -d "$stack" ] && stack="$(cd "$stack" && pwd -P)"
door="${FOLD_URL:-http://127.0.0.1:11436}"
host="$(printf '%s' "$door" | sed -E 's#^https?://([^/:]+).*#\1#')"
port="$(printf '%s' "$door" | sed -E 's#^https?://[^/:]+:?([0-9]*).*#\1#' )"
port="${port:-11436}"
label="ai.opencode.fold.door"
stack_url="${FOLD_STACK_URL:-https://github.com/scores-patch-points/khora.git}"
stack_branch="${FOLD_STACK_BRANCH:-}"
# The app needs the DOOR, not the whole model fleet: the doorway is model-free and grounds text
# on its own. `full` hands the job back to the stack's local-up.sh (the whole pipeline: model
# host, mouths, fleet) for operators who want that supervised too.
mode="${FOLD_DOOR_MODE:-doorway}"
# THE CUBE (optional, default off): FOLD_CUBE=1 provisions the python witnesses behind the
# door's 27-cell tool registry — a locked venv (cube-tools/py312, uv) under the door's own
# state dir, launchd-readable, and the door started with FOLD_CUBE=1. Without it the door
# still runs; cube calls answer a typed gap (sidecar-absent), never a silent downgrade.
# FOLD_CUBE_GROUPS chooses the uv groups the venv syncs (default "ci existence": the wired
# witness plus the sense organs; widen to all three domain groups for the whole locked cube).
cube="${FOLD_CUBE:-0}"

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

# Provision the stack on a fresh machine: the app's door is khora, and khora is public. Only the
# safe locations are provisioned — a stack under ~/Downloads is the developer's own checkout, and
# starting it from here is the TCC case the guard in start_door names.
fetch_stack() {
  [ -f "$stack/opencode-doorway.mjs" ] && return 0

  case "$stack" in
    "$HOME/Downloads/"*|"$HOME/Desktop/"*|"$HOME/Documents/"*)
      say "refusing to provision into a macOS-protected folder: $stack — choose a location launchd can read (default ~/.khora)"
      return 1
      ;;
  esac

  command -v git >/dev/null 2>&1 || { say "git is required to provision the stack"; return 1; }
  command -v node >/dev/null 2>&1 || { say "node is required to run the door"; return 1; }

  say "cloning the fold stack into $stack"
  mkdir -p "$(dirname "$stack")"

  if [ -n "$stack_branch" ]; then
    git clone --depth 1 --branch "$stack_branch" "$stack_url" "$stack" >>"$log" 2>&1 || { say "clone failed ($stack_url)"; return 1; }
  else
    git clone --depth 1 "$stack_url" "$stack" >>"$log" 2>&1 || { say "clone failed ($stack_url)"; return 1; }
  fi

  # khora's runtime dependency is one package (mathjs) and the doorway itself is node-only, so a
  # failed install is disclosed, not fatal.
  if [ -f "$stack/package-lock.json" ]; then
    ( cd "$stack" && (npm ci --omit=dev >>"$log" 2>&1 || npm install --omit=dev >>"$log" 2>&1) ) || say "dependency install failed (doorway may still run)"
  fi

  return 0
}

# THE CUBE'S VENV, provisioned only when asked for (FOLD_CUBE=1). The locked py312 project
# ships in the stack; the venv lives under the door's own state dir (launchd-readable, never
# inside the clone), where the sidecar host hunts for it. A failure is disclosed and the door
# still runs — python stays optional, cube calls answer their typed gap.
provision_cube() {
  [ "$cube" = "1" ] || return 0
  if ! command -v uv >/dev/null 2>&1; then
    say "FOLD_CUBE=1 but uv is not on PATH — the venv was not provisioned (cube calls will answer sidecar-absent)"
    return 0
  fi
  if [ ! -f "$stack/cube-tools/py312/pyproject.toml" ]; then
    say "FOLD_CUBE=1 but the stack at $stack carries no cube-tools/py312 project"
    return 0
  fi
  # Which uv groups to sync. Nothing installs unless a group is named
  # (default-groups=[]), so a bare `uv sync` would build an EMPTY venv — the
  # default here is the wiring's own reach: the wired witness (ci) plus the
  # sense organs' group (existence). The remaining domain groups arrive as
  # their executors are wired — provisioning tracks the wiring, it does not
  # run ahead of it. FOLD_CUBE_GROUPS="existence structure interpretation"
  # widens it to the whole locked cube (sentence-transformers and friends
  # included: expect torch-sized downloads).
  groups="${FOLD_CUBE_GROUPS:-ci existence}"
  args=""
  for g in $groups; do args="$args --group $g"; done
  say "provisioning the cube venv at $home_dir/venv (uv sync$args, cube-tools/py312)"
  if ( cd "$stack/cube-tools/py312" && UV_PROJECT_ENVIRONMENT="$home_dir/venv" uv sync --no-python-downloads $args >>"$log" 2>&1 ); then
    say "cube venv ready: $home_dir/venv"
  else
    say "cube venv provisioning failed — the door still runs; cube calls answer sidecar-absent (see $log)"
  fi
}

start_door() {
  fetch_stack || true

  [ -d "$stack" ] || { say "no fold stack at $stack (set FOLD_STACK_DIR)"; return 1; }
  # launchd's process cannot read a stack inside ~/Downloads (macOS Files-and-Folders privacy):
  # stat succeeds, the read does not. Name the typed reason instead of a silent EPERM.
  if ! head -c 1 "$stack/opencode-doorway.mjs" >/dev/null 2>&1; then
    say "the stack at $stack is unreadable by this process — grant Full Disk Access to the door agent, or move the stack out of ~/Downloads"
    return 1
  fi
  provision_cube
  if [ "$mode" = "full" ] && [ -x "$stack/local-up.sh" ]; then
    say "starting the fold pipeline: $stack/local-up.sh bg"
    ( cd "$stack" && ./local-up.sh bg >>"$log" 2>&1 ) || say "local-up.sh returned non-zero"
  elif [ "$cube" = "1" ]; then
    say "serving the opencode doorway on :$port (cube on; venv $home_dir/venv)"
    ( cd "$stack" && FOLD_CUBE=1 FOLD_CUBE_PYTHON="$home_dir/venv/bin/python" nohup node opencode-doorway.mjs --serve "$port" >>"$log" 2>&1 & ) || return 1
  else
    say "serving the opencode doorway on :$port (FOLD_DOOR_MODE=full runs the whole pipeline)"
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
  siblings_env=""
  [ -n "${FOLD_SIBLINGS_DIR:-}" ] && siblings_env="    <key>FOLD_SIBLINGS_DIR</key><string>$FOLD_SIBLINGS_DIR</string>"
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
    <key>FOLD_CUBE</key><string>$cube</string>
$siblings_env
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
  stack) if fetch_stack; then echo "stack: $stack"; else echo "stack: not provisioned ($stack)" >&2; exit 1; fi ;;
  install) install_agent ;;
  uninstall) uninstall_agent ;;
  *) echo "usage: $0 [start|run|status|install|uninstall]" >&2; exit 1 ;;
esac
