# opencode-fold — the routing fork's contract

opencode-fold is **opencode** (`anomalyco/opencode`, MIT) — the tree is
byte-for-byte upstream — plus one thing: the doorway plugin that keeps the
frontier's context to precisely what each ask needs, and records every turn so
the fold learns. No rebrand lives here. Syncing is a rebase, and the fork's
honesty is one diff check.

## What this branch is

- **Upstream**: https://github.com/anomalyco/opencode (branch `dev`)
- **License**: MIT — `LICENSE` is upstream's file, byte-for-byte. The MIT
  copyright notice is the attribution this fork is built on.
- **The Fold context**: per the Adaptive Agent Runtime spec (§1, §12), opencode
  is an execution substrate, never the epistemic architecture. It executes
  filesystem, shell, process, git, and test work behind Machine Doors; the
  doorway decides what a prompt becomes and what a finished turn teaches.
- **No local model anywhere on this path.** The frontier models run through
  opencode exactly as normal; the doorway only curates what they are sent, by
  rule. It answers in milliseconds and costs zero tokens.

## The doorway (the fork's entire delta)

| File | What it is |
|---|---|
| `packages/core/src/plugin/fold.ts` | the doorway client — a thin forwarder to the fold stack's `POST /v1/hooks/opencode` (khora's `opencode-doorway.mjs`). No fold logic lives here, so it does not change when the fold does. |
| `packages/core/src/plugin/internal.ts` | its registration: one import, one entry, added last so it sees the context every other plugin has already shaped. |
| `packages/app/src/session/timeline/session-mind.tsx` | the mind: says in words what the model is doing while a turn runs (stage, step count, polite live announcement, no reliance on motion or colour). The stages are the nine operators (NUL SIG INS SEG CON SYN DEF EVA REC); the one table mapping tool actions to operators is `session-mind-stage.ts`, tested by `session-mind.test.ts`. Mounted by a few added lines in `message-timeline.tsx`; nothing upstream is removed. |
| `fold-sync.sh` | the upstream tracker: rebase, delta guard, typecheck, optional install. |
| `fold-install.sh` | builds this checkout and swaps it in as the machine's `opencode`. |
| `UPSTREAM.md` | this contract. |

What the door does (khora side, `opencode-doorway.mjs` mounted in `proxy.mjs`):

- **`context`** — a new ask is about to reach the frontier model. If this exact
  ask was settled before, the door answers with a `<fold-recall>` system note:
  the plan that worked and how it ended. First asks get nothing.
- **`fold`** — a tool output is about to enter the frontier's context. The door
  scores the ask's content words against the output's lines (rarer terms weigh
  more), keeps the windows the ask needs plus the structural head and tail, and
  receipts every elision with its line range. What is not needed is not sent.
  The frontier can always re-read an exact range on demand; the chars kept out
  are the tokens saved.
- **`title`** — session titles are derived from the ask by rule (first words,
  cleaned). No model, local or frontier, is consulted.
- **`event`** — the turn's events (steps, tools, text, usage, boundary) are
  folded into one instance record the fold learns from; settled turns become
  recall. The record is what makes the fold need the frontier less and less.
- **`GET /v1/hooks/opencode/meter`** — what the frontier cost (first asks vs
  repeats) and what the fold kept out of it: chars, estimated tokens, and
  dollars at the running model's own catalog price.

Environment (fork side): `FOLD_URL` (default `http://127.0.0.1:11436`),
`FOLD_TIMEOUT_MS` (ask/recall, default 1500), `FOLD_FOLD_TIMEOUT_MS` (default
20000), `FOLD_MIN_CHARS` (fold anything larger, default 4000), `FOLD_OFF=1`
removes the plugin's effect entirely. With the door unreachable, slow, or
answering nonsense, opencode behaves exactly as upstream would — the doorway
always fails open. In the TUI, the `/fold` command shows the savings counter.

## Getting updates

```sh
./fold-sync.sh            # fetch upstream/dev, report drift and guard the delta
./fold-sync.sh --apply    # rebase onto upstream/dev, reinstall deps, typecheck
./fold-sync.sh --install  # the above, then build and swap the installed binary
```

`--install` lands the new binary at `~/.opencode/bin/opencode` (override with
`OPENCODE_BIN_DIR`), keeping the replaced binary at `opencode.upstream.bak`.
Log in as normal (`opencode auth login`); auth, config, and providers are
untouched — the fork is upstream.

Fold-repo updates need no app update: the contract is the handshake on
`GET /v1/hooks/opencode`, and the plugin fails open against anything it does
not understand. Restarting the channel (`launchctl kickstart -k
gui/$(id -u)/com.fold.channel`) is what loads a khora doorway update.

The earlier white-label attempt (branded CLI, models pinned to the heimdall
catalog, `brand/manifest.json`) lived on this repo's `dev` branch. This branch
replaces that approach: look identical to upstream, route differently.

## Falsifying control

`./fold-sync.sh` fails if the fork's delta (always measured against the
upstream commit the branch sits on) touches any file outside
`packages/core/src/plugin/fold.ts`, `packages/core/src/plugin/internal.ts`,
`UPSTREAM.md`, `fold-sync.sh`, `fold-install.sh` — or if the delta deletes any
upstream line. The fork only ever adds. If it ever needs a second patch, that
is a contract change: extend the allowed list here first, deliberately.
