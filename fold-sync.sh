#!/usr/bin/env bash
# fold-sync.sh — move the routing fork onto the latest upstream opencode.
#
# The fork's entire delta is the doorway: packages/core/src/plugin/fold.ts plus
# its registration in packages/core/src/plugin/internal.ts (see UPSTREAM.md).
# This script fetches upstream, optionally rebases onto it, and proves the
# delta did not grow: every changed file must be in the list below, and no
# upstream line may be deleted.
#
#   ./fold-sync.sh            fetch + report (no working-tree changes)
#   ./fold-sync.sh --apply    fetch + rebase onto upstream/dev, then guard + typecheck
#   ./fold-sync.sh --install  --apply, then build and swap in the installed opencode
set -euo pipefail

cd "$(dirname "$0")"

mode="${1:-}"
if [[ "$mode" != "" && "$mode" != "--apply" && "$mode" != "--install" ]]; then
  echo "usage: ./fold-sync.sh [--apply|--install]" >&2
  exit 1
fi

git fetch upstream dev

if [[ "$mode" == "--apply" || "$mode" == "--install" ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "working tree not clean; commit or stash before --apply" >&2
    exit 1
  fi
  git rebase upstream/dev
fi

behind=$(git rev-list --count HEAD..upstream/dev)
echo "fold is ${behind} commit(s) behind upstream/dev"

# The fork's delta is measured against the upstream commit it sits on, not the
# moving upstream tip: before a rebase those differ, and only after rebasing
# does the delta read as upstream/dev..HEAD.
base=$(git merge-base HEAD upstream/dev)

leak=""
while IFS= read -r file; do
  case "$file" in
    packages/core/src/plugin/fold.ts | packages/core/src/plugin/internal.ts | packages/core/test/fold-websearch.test.ts | packages/session-ui/package.json | packages/app/src/session/timeline/virtualizer.tsx | packages/app/src/settings/model.tsx | packages/app/src/session/timeline/session-mind.tsx | packages/gui-extensions/src/fold/mind-tree.tsx | packages/gui-extensions/src/fold/plans.tsx | packages/gui-extensions/src/fold/plans-model.ts | packages/gui-extensions/src/fold/plans-model.test.ts | packages/gui-extensions/src/fold/follow.ts | packages/gui-extensions/src/fold/follow.test.ts | packages/app/src/session/timeline/follow-bottom.ts | packages/gui-extensions/src/fold/mind-tree-model.ts | packages/gui-extensions/src/fold/mind-tree-model.test.ts | packages/app/src/session/timeline/session-mind-stage.ts | packages/app/src/session/timeline/session-mind.test.ts | packages/app/src/session/timeline/message-timeline.tsx | packages/gui-extensions/src/fold/remember.tsx | packages/gui-extensions/src/fold/remember-model.ts | packages/gui-extensions/src/fold/remember-model.test.ts | UPSTREAM.md | fold-sync.sh | fold-install.sh | \
    brand/* | README.md | README.*.md | fold-app.sh | fold-launcher.sh | fold-door.sh | \
    packages/ui/src/assets/favicon/* | packages/ui/src/i18n/* | packages/ui/src/components/favicon.tsx | \
    packages/desktop/icons/* | packages/desktop/resources/icons/* | packages/desktop/electron-builder.config.ts | packages/desktop/scripts/dev-electron.ts | \
    packages/desktop/src/main/constants.ts | packages/desktop/src/main/windows/early.ts | packages/desktop/src/main/windows/appearance.ts | \
    packages/desktop/src/renderer/index.html | packages/desktop/src/renderer/startup/splash.tsx | packages/desktop/src/renderer/platform/notifications.ts | \
    packages/app/index.html | packages/app/manifest.json | packages/app/src/runtime/i18n/* | packages/app/src/runtime/platform/web.ts | \
    packages/app/src/shell/titlebar/windows-menu.tsx | packages/app/src/servers/connect/screen.tsx) ;;
    *) leak="${leak}${file}"$'\n' ;;
  esac
done < <(git diff --name-only "${base}"..HEAD)

if [[ -n "$leak" ]]; then
  echo "fold delta left the doorway:" >&2
  printf '%s' "$leak" >&2
  exit 1
fi

# The doorway's own delta allows no deletions. Two reviewed exemptions: the one-line
# default change in settings/model.tsx, and the app-identity surface (brand/, README,
# i18n, icons, the desktop/app shells) where renaming copy replaces an upstream string.
deletions=$(git diff --numstat "${base}"..HEAD | awk '
  $3 == "packages/app/src/settings/model.tsx" { next }
  $3 ~ /^(brand\/|README\.|fold-app\.sh$|fold-launcher\.sh$|fold-door\.sh$|packages\/ui\/src\/assets\/favicon\/|packages\/ui\/src\/i18n\/|packages\/ui\/src\/components\/favicon\.tsx$|packages\/desktop\/icons\/|packages\/desktop\/resources\/icons\/|packages\/desktop\/electron-builder\.config\.ts$|packages\/desktop\/scripts\/dev-electron\.ts$|packages\/desktop\/src\/main\/constants\.ts$|packages\/desktop\/src\/main\/windows\/(early|appearance)\.ts$|packages\/desktop\/src\/renderer\/index\.html$|packages\/desktop\/src\/renderer\/startup\/splash\.tsx$|packages\/desktop\/src\/renderer\/platform\/notifications\.ts$|packages\/app\/index\.html$|packages\/app\/manifest\.json$|packages\/app\/src\/runtime\/i18n\/|packages\/app\/src\/runtime\/platform\/web\.ts$|packages\/app\/src\/shell\/titlebar\/windows-menu\.tsx$|packages\/app\/src\/servers\/connect\/screen\.tsx$)/ { next }
  { d += $2 } END { print d + 0 }')
if [[ "$deletions" != "0" ]]; then
  echo "fold delta deletes ${deletions} upstream line(s); the fork must only add. Rebase by hand and re-check." >&2
  exit 1
fi

echo "delta guard: clean ($(git diff --name-only "${base}"..HEAD | wc -l | tr -d ' ') file(s), 0 deletions)"

if [[ "$behind" != "0" && "$mode" == "" ]]; then
  echo "upstream moved. Run ./fold-sync.sh --apply to rebase."
fi

if [[ "$mode" == "--apply" || "$mode" == "--install" ]]; then
  bun install
  (cd packages/core && bun typecheck)
  echo "fold now at $(git rev-parse --short HEAD), on upstream $(git rev-parse --short upstream/dev), typecheck green"
fi

if [[ "$mode" == "--install" ]]; then
  ./fold-install.sh
fi
