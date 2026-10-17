#!/bin/sh
# fold-reaper.sh — clear orphaned managed services so the app can own its port.
#
# The desktop app keeps its managed service (`opencode serve --service`, fixed port,
# deliberate: a second contender must fail to bind and back off — see
# packages/desktop/src/main/service/background-service.ts) as a CHILD process. When an
# instance dies uncleanly (kill, crash, a rebuild nuking the running bundle), that child
# survives with PPID 1, keeps the port and the 5 GB session db open, and the next instance
# cannot start its own service: "Managed service port ... already in use by another
# process" — the Desktop IPC error. The app cannot clean this up alone; its own
# cleanStages removes stale staged binaries, not running orphans from other builds.
#
# Reap rule: a `serve --service` process whose parent is gone (PPID 1), with no
# ESTABLISHED client connections to any port it listens on, and not one the next boot
# adopts — the CURRENT staged CLI, or the service the state file registers for adoption
# with a matching pid, version and port (client service-probe.ts). No age minimum by
# default (FOLD_REAP_GRACE overrides): a fresh orphan at a boot must die before the
# boot's own service start. A service someone is actually using, or one whose parent
# is alive, is never touched. An intentional unattended service defeats the reaper with:
#   touch ~/.config/opencode/keep-managed-service
#
#   ./fold-reaper.sh reap       reap once and exit (what launchd runs)
#   ./fold-reaper.sh status     list every managed service with its verdict
#   ./fold-reaper.sh install    install the launchd agent (macOS: every 10 s + on app boot)
#   ./fold-reaper.sh uninstall  stop and remove the agent
#   FOLD_REAP_DRY=1 ./fold-reaper.sh reap   print decisions, kill nothing
set -eu

label="ai.opencode.fold.reaper"
home_dir="$HOME/.local/share/fold-reaper"
log="$HOME/Library/Logs/fold-reaper.log"
grace="${FOLD_REAP_GRACE:-0}"

# launchd starts this with a near-empty PATH; ps, pgrep and lsof live in the system bins.
PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export PATH

here="$(cd "$(dirname "$0")" && pwd)"

say() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$log" 2>/dev/null || true; }

# ps etime forms: MM:SS | HH:MM:SS | D-HH:MM:SS. Leading zeros must go: POSIX
# arithmetic would read them as octal.
dec() { v=$(printf '%s' "$1" | sed 's/^0*//'); printf '%s' "${v:-0}"; }
age_seconds() {
  e="$1"; d=0
  case "$e" in *-*) d="${e%%-*}"; e="${e#*-}" ;; esac
  h=0; m=0; s=0
  case "$e" in
    *:*:*) h="${e%%:*}"; e="${e#*:}"; m="${e%%:*}"; s="${e#*:}" ;;
    *:*) m="${e%%:*}"; s="${e#*:}" ;;
    *) s="$e" ;;
  esac
  printf '%s' "$(( $(dec "$d") * 86400 + $(dec "$h") * 3600 + $(dec "$m") * 60 + $(dec "$s") ))"
}

# The staged CLI dirs the running apps would adopt; their services must survive a boot.
current_stages() {
  for app in "${FOLD_APP_DIR:-/Applications}/openfold.app" "$HOME/Applications/openfold.app" /Applications/openfold.app; do
    v=$(cat "$app/Contents/Resources/opencode-cli.version" 2>/dev/null || true)
    [ -n "$v" ] && printf '%s\n' "$v"
  done
}

listen_ports() { lsof -a -p "$1" -iTCP -sTCP:LISTEN -nP -Fn 2>/dev/null | sed -n 's/^n.*://p'; }
clients_on() { lsof -nP -iTCP:"$1" -sTCP:ESTABLISHED 2>/dev/null | tail -n +2 | wc -l | tr -d ' '; }
service_cmd() {
  c=$(ps -o command= -p "$1" 2>/dev/null || true)
  case "$c" in
    *opencode*" serve --service"*|*openfold*" serve --service"*) printf '%s' "$c" ;;
  esac
}

# The registration file is the boot's discovery contract: a boot reuses a registered
# service only when pid, version and listening port all match. Spare exactly that
# class; any other service holding the port is a collider the boot cannot use.
registered_for_boot() {
  rpid="$1"
  f="${XDG_STATE_HOME:-$HOME/.local/state}/opencode/service.json"
  [ -f "$f" ] || return 1
  rf=$(cat "$f" 2>/dev/null) || return 1
  p=$(printf '%s' "$rf" | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
  v=$(printf '%s' "$rf" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
  u=$(printf '%s' "$rf" | sed -n 's/.*"url":"[^"]*:\([0-9]*\)".*/\1/p')
  [ -n "$p" ] && [ "$p" = "$rpid" ] || return 1
  rv=0
  for x in $2; do [ "$v" = "$x" ] && rv=1; done
  [ "$rv" = 1 ] || return 1
  for lp in $(listen_ports "$rpid"); do [ "$lp" = "$u" ] && return 0; done
  return 1
}

reap() {
  if [ -f "$HOME/.config/opencode/keep-managed-service" ]; then
    [ "${FOLD_REAP_DRY:-0}" = 1 ] && echo "keep marker present; nothing reaped"
    return 0
  fi
  if [ -f "$log" ] && [ "$(wc -c <"$log" 2>/dev/null || echo 0)" -gt 1000000 ]; then
    mv -f "$log" "$log.1" 2>/dev/null || true
  fi
  versions="$(current_stages)"
  pgrep -f ' serve --service' 2>/dev/null | while read -r pid; do
    [ -n "$pid" ] || continue
    cmd=$(service_cmd "$pid"); [ -n "$cmd" ] || continue
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    etime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    [ -n "$ppid" ] && [ -n "$etime" ] || continue
    age=$(age_seconds "$etime")
    if [ "$ppid" != 1 ]; then
      [ "${FOLD_REAP_DRY:-0}" = 1 ] && echo "keep pid $pid (parent $ppid alive): $cmd"
      continue
    fi
    adoptable=0
    for v in $versions; do
      case "$cmd" in *"/cli/$v-arm64/opencode-cli"*) adoptable=1 ;; esac
    done
    if [ "$adoptable" = 1 ]; then
      [ "${FOLD_REAP_DRY:-0}" = 1 ] && echo "keep pid $pid (current staged CLI; the next boot adopts it)"
      continue
    fi
    if registered_for_boot "$pid" "$versions"; then
      [ "${FOLD_REAP_DRY:-0}" = 1 ] && echo "keep pid $pid (registered service the next boot adopts)"
      continue
    fi
    if [ "$age" -lt "$grace" ]; then
      [ "${FOLD_REAP_DRY:-0}" = 1 ] && echo "keep pid $pid (age ${age}s < grace ${grace}s)"
      continue
    fi
    busy=0; ports=""
    for p in $(listen_ports "$pid"); do
      ports="$ports $p"
      [ "$(clients_on "$p")" -gt 0 ] && busy=$((busy + 1))
    done
    if [ "$busy" -gt 0 ]; then
      [ "${FOLD_REAP_DRY:-0}" = 1 ] && echo "keep pid $pid (clients attached on$ports)"
      continue
    fi
    if [ "${FOLD_REAP_DRY:-0}" = 1 ]; then
      echo "would reap pid $pid ppid=1 age=${age}s ports=${ports:-none}: $cmd"
      continue
    fi
    kill -TERM "$pid" 2>/dev/null || true
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 5 ]; do sleep 1; i=$((i + 1)); done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
    say "reaped orphaned service pid $pid ppid=1 age=${age}s ports=${ports:-none}: $cmd"
  done
}

status() {
  found=0
  versions="$(current_stages)"
  for pid in $(pgrep -f ' serve --service' 2>/dev/null); do
    cmd=$(service_cmd "$pid"); [ -n "$cmd" ] || continue
    found=1
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    etime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
    age=$(age_seconds "$etime")
    ports=$(listen_ports "$pid" | tr '\n' ' ')
    adoptable=0
    for v in $versions; do
      case "$cmd" in *"/cli/$v-arm64/opencode-cli"*) adoptable=1 ;; esac
    done
    if [ "$ppid" != 1 ]; then verdict="owned (parent $ppid alive)"
    elif [ "$adoptable" = 1 ]; then verdict="adoptable (current staged CLI)"
    elif registered_for_boot "$pid" "$versions"; then verdict="adoptable (registered for the next boot)"
    else
      busy=0
      for p in $ports; do [ "$(clients_on "$p")" -gt 0 ] && busy=1; done
      if [ "$busy" = 1 ]; then verdict="in use (clients attached)"
      else verdict="ORPHAN — reapable"
      fi
    fi
    echo "pid $pid  ppid $ppid  age ${age}s  ports ${ports:-none}  $verdict"
    echo "  $cmd"
  done
  [ "$found" = 1 ] || echo "no managed services running"
}

agent_plist() {
  cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>$home_dir/fold-reaper.sh</string><string>reap</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>10</integer>
  <key>ThrottleInterval</key><integer>1</integer>
  <key>WatchPaths</key><array>
    <string>$HOME/Library/Application Support/ai.opencode.desktop.dev/logs</string>
  </array>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict></plist>
PLIST
}

install_agent() {
  [ "$(uname -s)" = Darwin ] || { echo "launchd install is macOS-only; run './fold-reaper.sh reap' under your init" >&2; return 1; }
  mkdir -p "$home_dir" "$HOME/Library/LaunchAgents"
  cp "$here/fold-reaper.sh" "$home_dir/fold-reaper.sh"
  chmod +x "$home_dir/fold-reaper.sh"
  plist="$HOME/Library/LaunchAgents/$label.plist"
  agent_plist >"$plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "installed $plist (agent reaps orphaned services every 10 s and on every app boot)"
}

uninstall_agent() {
  plist="$HOME/Library/LaunchAgents/$label.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$plist"
  echo "removed $plist"
}

case "${1:-reap}" in
  reap) reap ;;
  status) status ;;
  install) install_agent ;;
  uninstall) uninstall_agent ;;
  *) echo "usage: $0 [reap|status|install|uninstall]" >&2; exit 1 ;;
esac
