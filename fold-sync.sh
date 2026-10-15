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
    packages/core/src/plugin/fold.ts | packages/core/src/plugin/internal.ts | UPSTREAM.md | fold-sync.sh | fold-install.sh) ;;
    *) leak="${leak}${file}"$'\n' ;;
  esac
done < <(git diff --name-only "${base}"..HEAD)

if [[ -n "$leak" ]]; then
  echo "fold delta left the doorway:" >&2
  printf '%s' "$leak" >&2
  exit 1
fi

deletions=$(git diff --numstat "${base}"..HEAD | awk '{ d += $2 } END { print d + 0 }')
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
