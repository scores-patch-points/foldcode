# opencode-fold — the routing fork's contract

opencode-fold is **opencode** (`anomalyco/opencode`, MIT) — the tree is
byte-for-byte upstream — plus one thing: the doorway plugin that routes prompts,
titles, and turn records through the fold stack. No rebrand lives here. Syncing
is a rebase, and the fork's honesty is one diff check.

## What this branch is

- **Upstream**: https://github.com/anomalyco/opencode (branch `dev`)
- **License**: MIT — `LICENSE` is upstream's file, byte-for-byte. The MIT
  copyright notice is the attribution this fork is built on.
- **The Fold context**: per the Adaptive Agent Runtime spec (§1, §12), opencode
  is an execution substrate, never the epistemic architecture. It executes
  filesystem, shell, process, git, and test work behind Machine Doors; the
  doorway decides what a prompt becomes and what a finished turn teaches.

## The doorway (the fork's entire delta)

| File | What it is |
|---|---|
| `packages/core/src/plugin/fold.ts` | the doorway client — a thin forwarder to the fold stack's `POST /v1/hooks/opencode` (khora's `opencode-doorway.mjs`). No fold logic lives here, so it does not change when the fold does. |
| `packages/core/src/plugin/internal.ts` | its registration: one import, one entry, added last so it sees the context every other plugin has already shaped. |

What the door does (khora side, `opencode-doorway.mjs` mounted in `proxy.mjs`):

- **`context`** — a new ask is about to reach the frontier model. If this exact
  ask was settled before, the door answers with a `<fold-recall>` system note:
  the plan that worked and how it ended. First asks get nothing.
- **`title`** — session titles are written by the local mouth, so the frontier
  is never consulted for them.
- **`event`** — the turn's events (steps, tools, text, usage, boundary) are
  folded into one instance record the fold learns from; settled turns become
  recall. The record is what makes the fold need the frontier less and less.
- **`GET /v1/hooks/opencode/meter`** — what the frontier cost: first asks vs
  repeat asks, titles served locally, recalls served — rate and health
  together, and the unmeasured listed as unmeasured.

Environment: `FOLD_URL` (default `http://127.0.0.1:11436`), `FOLD_TIMEOUT_MS`
(default 1500), `FOLD_OFF=1` removes the plugin's effect entirely. With the door
unreachable, slow, or answering nonsense, opencode behaves exactly as upstream
would — the doorway always fails open.

## Getting updates

```sh
./fold-sync.sh           # fetch upstream/dev, report drift and guard the delta
./fold-sync.sh --apply   # rebase onto upstream/dev, reinstall, typecheck
```

The earlier white-label attempt (branded CLI, models pinned to the heimdall
catalog, `brand/manifest.json`) lived on this repo's `dev` branch. This branch
replaces that approach: look identical to upstream, route differently.

## Falsifying control

`./fold-sync.sh` fails if the fork's delta (always measured against the
upstream commit the branch sits on) touches any file outside
`packages/core/src/plugin/fold.ts`, `packages/core/src/plugin/internal.ts`,
`UPSTREAM.md`, `fold-sync.sh` — or if the delta deletes any upstream line. The
fork only ever adds. If it ever needs a second patch, that is a contract change:
extend the allowed list here first, deliberately.
