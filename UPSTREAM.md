# openfold — the routing fork's contract

openfold is **opencode** (`anomalyco/opencode`, MIT) — the tree is
byte-for-byte upstream — plus two things: the doorway plugin that keeps the
frontier's context to precisely what each ask needs and records every turn so
the fold learns, and the app identity (the name *openfold*, the fold's icon,
and the README lockup). The models are upstream's, unpinned; the CLI is
upstream's — this is not the abandoned white-label. Syncing is a rebase, and
the fork's honesty is one diff check.

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
| `packages/core/src/plugin/fold.ts` | the doorway client — a thin forwarder to the fold stack's `POST /v1/hooks/opencode` (khora's `opencode-doorway.mjs`). No fold logic lives here, so it does not change when the fold does. It also registers web search the way opencode's own provider plugins do (`ctx.websearch.transform`): a keyless `This machine` provider whose engine is heimdall's `/api/search` (Brave then DuckDuckGo, from the operator's own address), selected by the normal first-search flow. `FOLD_WEBSEARCH=0` removes it; a down bridge is one provider erroring, never a broken opencode. |
| `packages/core/test/fold-websearch.test.ts` | proves the doorway's web search provider registers alongside the built-ins without forcing a default, and maps the machine's own results. |
| `packages/core/src/plugin/internal.ts` | its registration: one import, one entry, added last so it sees the context every other plugin has already shaped. |
| `packages/app/src/session/timeline/session-mind.tsx` | the mind: says in words what the model is doing while a turn runs (stage, step count, polite live announcement, no reliance on motion or colour). The stages are the nine operators (NUL SIG INS SEG CON SYN DEF EVA REC); the one table mapping tool actions to operators is `session-mind-stage.ts`, tested by `session-mind.test.ts`. Mounted by a few added lines in `message-timeline.tsx`; nothing upstream is removed. |
| `packages/gui-extensions/src/fold/remember.tsx` (+ `remember-model.ts`, tested by `remember-model.test.ts`) | the Remember window — a side tab over the operator's three standing stores: **facts** (memory), **access** (refs), and **system prompts**. It reads each store back from the door and appends to it. Its door backend is `khora/opencode-remember.mjs`; the door injects an entry into a prompt only when an ask's own words bear on it, so nothing here is loaded wholesale (see the `memory` bullet below). |
| `fold-sync.sh` | the upstream tracker: rebase, delta guard, typecheck, optional install. |
| `fold-install.sh` | builds this checkout and swaps it in as the machine's `opencode`. |
| `UPSTREAM.md` | this contract. |

What the door does (khora side, `opencode-doorway.mjs` mounted in `proxy.mjs`):

- **`context`** — a new ask is about to reach the frontier model. If this exact
  ask was settled before, the door answers with a `<fold-recall>` system note:
  the plan that worked and how it ended. First asks get nothing.
- **`memory`** — the operator's standing facts (which repo is canonical, which
  account publishes) from `~/.config/opencode/user-memory.md`, injected only
  when the ask's own words bear on one (mechanical word overlap, stopword-
  folded, capped). The door parses the store and answers the note on the
  `context` call; the fork injects what it is handed and carries no memory
  logic. `GET /v1/hooks/opencode/memory` reads the store back; `POST` appends
  one entry (append-only — a `supersedes:` names an earlier claim to retire,
  never an edit). The Remember window's two sibling stores work the same way
  (`khora/opencode-remember.mjs`): **`refs`** — addresses the system may read
  on demand, the bytes carried only by a `snip` (`GET/POST
  /v1/hooks/opencode/refs`, `~/.config/opencode/user-refs.md`); and
  **`system`** — prompt text injected only when an ask bears on it
  (`GET/POST /v1/hooks/opencode/system`, `~/.config/opencode/system-prompts.json`).
  All three ride the `context` answer (`answer.memory`, `answer.refs`,
  `answer.systemPrompt`); `FOLD_MEMORY=0` / `FOLD_REFS=0` / `FOLD_SYSTEM=0`
  disable one each.
- **`fold`** — **RETIRED** (the line-level fold measured equal to its null, so
  the door answers `{}` and the client no longer posts it; the precompute is a
  no-op). Tool output now leaves the window by address, not by summary: the
  step fold (`<fold-index grain="step">`, `FOLD_KEEP_STEPS`) and the trail
  (`FOLD_TRAIL=1`, opaque handles resolved by `snip`) keep the bytes on disk and
  the frontier re-reads an exact range on demand. The chars kept out are the
  tokens saved.
- **`surf`** — the window must not grow per prompt. Turns older than the last
  `FOLD_KEEP_TURNS` (default 1; 0 disables) go to the door as `{ask, answer,
  grounds}`; it answers one note: a compression ladder (Figure for the newest,
  Kind for older turns sharing a rare-term signature admitted only when the MDL
  gain is positive with independent grounds, Pattern past the cap), no model.
  The same call is how agents coordinate **stigmergically**: a task directory
  (`~/.fold/worknotes/<task>/`, `FOLD_WORKNOTES_DIR`; `task` is `FOLD_TASK`,
  default the sessionID) holds one append-only marks file per agent
  (`<iso> · <agent> · fact|claim|done|block · <text>`, no writer contention),
  atomic claims (`claims/<slug>.json`, O_EXCL; decay after `FOLD_CLAIM_TTL_MS`,
  default 15 min; `done` is final), and each agent's own turns file. The
  context note carries the ladder plus what others hold and the latest facts,
  so parallel agents share a medium, not a window. The door also answers
  `mark`, `claim`, `done` and `notes` events for agents that are not this
  fork. Door down: local truncation answers, and no marks are shared.
  **Step fold** (`FOLD_KEEP_STEPS=N`, default 0 = off; `FOLD_VIEW_CHARS`, default 40000): `surf` cuts at user
  prompts, so one prompt that runs 60 tool steps never shrank. With N > 0 the plugin keeps the last N steps (an
  assistant message plus its tool results) verbatim and collapses older whole steps into one note appended to the
  turn's ask: one receipt per step, each `snip`-able to its exact bytes (handles `r[0-9a-z]+`, resolved locally),
  plus a bounded **workspace view** (the latest bytes of files those steps read or wrote; an edited file is left out,
  not shown stale). The view is what made it work: without it an agent re-read files instead of writing (329 reads vs
  8 writes, stalled); with it, 37-40 steps at ~22k input tokens/step (full history ~64k) reached 197/197 on a
  regex-engine task. Measured on one model and one task, not on the live app; keep it opt-in until it is.
  One vocabulary: `surf` is the general term for seeking — the surfer snipped the segment the words address
  (byte-accurate, typed gap, never a guess); read, grep, glob and the rest are each a declared surf subtype
  on a cube cell (read SEG·Ground, grep SEG·Figure; the 27 cells live in khora `native/the-fold/surf-types.js`);
  their results enter as ordinary steps and their files join the view.
  **REC** (`rec` / `record` events): the only way a change enters the task's
  verified record. DEF a referent and a real check; EVA is the check's exit
  code; exit 0 appends one EOT block to `EOT.md` (last-wins per referent,
  `supersedes:` chain), anything else is reverted and logged in `LOG.jsonl`
  (`VoidLog@1`, with the judge disclosed: `box` when the door ran the check,
  opt-in `FOLD_REC_EXEC=1`, else `reported`; no judge, no keep). The surf note
  carries the folded record, so the window holds verified state, not the
  conversation that produced it. Same-tab subagents share one task: `task`
  defaults to the root of the session's `parentID` chain.
  **Provenance**: every judged action in `LOG.jsonl` also carries the byte
  chain (`before`/`after`, sha256-16 of the file), the REC rungs and ground
  digest it stood on (`rungs`, `def`), the draw itself (`draw`) and the draw it
  follows for that referent (`parent`). The door's `provenance` event walks the
  chain: a `break` is an action whose `before` is not the last kept `after`
  (bytes changed outside the log), a `regression` is a referent refuted after
  it was green. A unit's refuted bodies are shared across every agent of the
  task: a later agent's `refusals` rung is seeded from them.
  **One store, a firewall, and snip.** The task's log is `eot/<agent>.jsonl`
  (Provenance@2 shape, penelope's id derivation; union of writers); the note,
  commons, record, claims and provenance are projections of it. Every row has an
  origin: `mechanical` (a file span, tool result or test the system observed)
  or `model` (anything an agent said). A model-origin source cannot author a
  mechanical stage (`verify`/`admit`/`read`/`contend`), its text is stored
  defanged of the markers that would let it pass for a snip, and an `admit`
  needs a witnessed exit-0 `verify` parent. The injected note keeps two
  sections that never mix: `<fold-mechanical>` and `<fold-said>`. The model
  composes by reference with the `snip` tool (address to verbatim bytes plus
  standing); its final text is typed against the log and the disk, and what
  doesn't resolve comes back as a mechanical `unverified in your last answer`
  line. Budget: `FOLD_NOTE_CHARS` (700), `FOLD_COMMONS_CHARS` (600).
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
upstream commit the branch sits on) touches any file outside its allowed list —
the doorway (`packages/core/src/plugin/fold.ts`, its registration in
`internal.ts`), the fold UI extensions under `packages/gui-extensions/src/fold/`
(including `remember.tsx`, `remember-model.ts`, `remember-model.test.ts`), the
mind and its mount, the doorway's web search test
(`packages/core/test/fold-websearch.test.ts`), the scripts (`UPSTREAM.md`,
`fold-sync.sh`, `fold-install.sh`, `fold-app.sh`, `fold-launcher.sh`,
`fold-door.sh`), and the app identity — the openfold name and the fold's icon
across the READMEs, `brand/`, the app/ui i18n bundles, the favicons/icons, and
the desktop/app shells — or if the delta deletes any upstream line outside the
two reviewed exemptions (`settings/model.tsx` and the app-identity surface). The
authoritative allowed list is the `case` in `fold-sync.sh`. The fork only ever
adds. If it ever needs another patch, that is a contract change: extend the
allowed list first, deliberately.
