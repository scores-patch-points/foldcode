# foldcode is not a coding agent: the machine answers, the model states

**Status:** implemented on branch `register-door`; measured on one live session; not yet run on a wider workload.
**Files:** `packages/core/src/plugin/physics-mech.ts` (new), the hook in `plugin/fold.ts`, `plugin/fold-register.ts`,
`session/compaction.ts`, checker `fold-live-check.mjs`.

## The idea in one paragraph

A normal coding agent gets a big prompt (persona, ~20 tool definitions, history) and reasons its way to an answer through a loop of
tool calls. foldcode is not that. Its window is a **projection of a log the machine already holds**, and the machine should **reason
mechanically first**: find the file, find the line, evaluate the literal, list the exports. The model is called only to *state* what the
machine found, and only when the machine could not settle the question itself. A question the machine can settle costs one small request
instead of a 136-step loop; a question it cannot settle takes the normal path unchanged.

```
ask ─► machine first (physics-mech.resolve)
         ├─ hit ─► window = ONE system block holding the finding and its address,
         │         plus the user's message verbatim. NO tools, NO history, NO persona.
         │         The model states the finding (1 call, ~1k tokens).
         └─ gap ─► the normal fold path (register / gather / tools), exactly as before
```

## Why this exists (measured 2026-10-25/26)

From the usage tap's wire log, `~/.local/share/foldcode/usage.jsonl` (18,610 requests):

| finding | number |
|---|---|
| compaction calls | 5,697 = 32% of requests, 39% of prompt tokens, 63% of output tokens |
| one "what is DEFAULT_TIMEOUT_MS" session | 136 steps and 136 compactions, about $0.29 |
| one request for a 217-character question | 50.5k chars: 33.6k system, 16.5k tool definitions, 217 the question |
| tool set changing between step 1 and step 2 | 71 of 342 multi-step sessions (this breaks the provider's cache) |
| an unattended job (`com.fold.suite.resume`, since disabled) | 41-step Haiku sessions every 2 hours, about 15M prompt tokens a day |

Cause of the compaction storm: the POC harness sets the model's native window to 32k (`foldcode-poc/run.mjs`), so native automatic
compaction's ceiling was 16k tokens, below the fold's own fixed floor (about 18.6k). It fired after every step even though the fold
already bounds the window. This is an inference from the code and the numbers; the harness's env var could not be read back.

## What changed

1. **`foldOwnsWindow`** (`fold-register.ts`, `session/compaction.ts`). While the fold is active, native *automatic* compaction is skipped.
   Provider-overflow recovery and manual `/compact` still run. `FOLD_OFF=1` hands the window back to upstream. `FOLD_NATIVE_COMPACT=1`
   re-enables the automatic trigger beside the fold. The upstream trigger tests opt in with `FOLD_NATIVE_COMPACT=1`.
2. **`gateTurn`** (`fold-register.ts`, `fold.ts`). The tool gate is decided on the step that opens a turn and held for every later step of
   that ask, so the tool set (and the provider's cached prefix) stays constant within a turn.
3. **`physics-mech.ts`** and its hook in `fold.ts`. The mechanical resolver and the branch that serves its answer (this document).

## Where it sits in the universal pipeline (`~/.khora/ONE-PIPELINE.md`)

The pipeline's skeleton is: read the request, source each part (snip or reason from a source, else ask the mouth), hear every claim into
the notes ledger with its witness, reason with no model, assemble, verify. A mechanical turn runs that skeleton with the machine doing
everything except the last sentence:

| stage | on a mechanical turn |
|---|---|
| read the request | `Mech.resolve(ask, workspace, earlier asks)` |
| source each part | the file itself, read from disk; the witness is `file#Lnn` plus the file's **sha256** |
| hear | a `fact` mark from agent `mech` (the organ is the author, as the swarm writes as `swarm`) in the task's notes and EOT log, through the door's `mark` event. Other sessions and later turns read it from the task. The door types it itself (observed: `cell=DEF·Figure`). |
| reason | none: the machine's finding is the reasoning |
| assemble | the model states it: finding in the system block, the user's message verbatim and last |
| verify | `Mech.verify`: the answer must state the constant's value (any digit grouping) or every exported name as a whole word. The result is a mark in the same ledger (`fact verified: …` or `block`), and a `mech-verify` row in `physics.jsonl`. The door's sentence-level ground check also grades the answer against the finding (it skips answers under 8 characters, which `verify` covers). |

The **register still hears the ask** on a mechanical turn, so a fact stated beside a lookup is registered ("Our mascot is Orbit. What is X in
file.ts?" registers Orbit); it just never answers the turn, because the file did. Checked live: the next turn recalled "Orbit".

The task name is computed in the plugin by `taskKey` (a mirror of khora's `projectKey`: git root basename plus a hash of its path). A test
cross-checks it against the door's own function, so the two cannot drift silently; it is skipped on a machine without `~/.khora`. A workspace
with no project key (a home directory) writes no marks. The door process is not modified and needs no restart.

## What the resolver answers today

A pure module. It reads only the one file the ask names, which must resolve inside the workspace or its repository root (found by walking
up to the first `.git`), so a session opened in a subdirectory still finds files named from the repo root.

| ask shape | the machine's answer | gap (normal path) |
|---|---|---|
| "what is `NAME` in `path/file.ts`?" | `NAME = 300000` at `file.ts#L170` (a numeric literal or a product of them; `_` allowed) | not a literal, defined twice, not defined |
| "the default timeout in `file.ts`" (no symbol) | the file's only constant whose name has `TIMEOUT`, or `MAX`/`LIMIT`/`BYTES` | several or none |
| "list the exported functions/classes of `file.ts`" | the file's own `export` lines, including `export const f = (…) =>` and `Effect.fn(...)` | no exports |
| "and `X` in the **same file**?" | the file the earlier asks last named | no earlier file |

Anything else is a typed gap, logged to `~/.local/share/foldcode/physics.jsonl` as `served:false, reason:"mech: <gap>"`.
A hit is logged as `kind: mech-const | mech-exports` with `modelCalls: 1`.

## How to use it

On by default. `FOLD_MECH=0` turns the mechanical path off. Nothing else is needed: start foldcode and ask
`In packages/core/src/provider.ts, what is DEFAULT_TIMEOUT_MS? Reply with the number only.`

From a source checkout, run from `packages/cli` (from the repo root the TUI import of `react/jsx-dev-runtime` fails):

```sh
cd packages/cli
ANTHROPIC_API_KEY=… bun run src/index.ts run --standalone --auto -m anthropic/claude-haiku-5-5 "<ask>"
```

## How to check it works (do this after any change)

```sh
cd packages/core
bun test test/fold-physics-mech.test.ts test/fold-register.test.ts test/session-compaction.test.ts
N=$(wc -l < ~/.local/share/foldcode/usage.jsonl)     # note the line count, run a session, then:
node fold-live-check.mjs --from $N                    # exit 0 iff there are no compaction rows after line N
```

Pass looks like: `compaction rows: 0 ok`; a served mechanical turn shows `tools 2` (not 16,269) and a prompt around 1k tokens in the usage
log. The checker's tool-size line is a warning, not a gate: the log has no turn id, so a session that mixes asks legitimately changes
tool size. Judge it on a single-ask session. Set `FOLD_RULER_FILE=/tmp/ruler.jsonl` to see where the bytes of each request are.

## Measured results

* **Replay of 23 real questions** from the 136-step session: 17 answered mechanically (about 1 ms, no reasoning); 6 are conversation-recall
  questions that still take the register path. The 5 constant answers equal what Haiku said. The export lists were compared with the
  TypeScript compiler as an independent truth: 12 of 12 files exact, and 150 of 150 held-out repo files. The arrow-function rule was tuned
  on the first 12, so only the 150 are independent. The compiler's notion of "function" here is arrow, function expression, or `Effect.fn`.
* **Live, four questions on Haiku in one session:** 4 requests, 3,699 prompt tokens, no tool calls, correct answers (300000, 900000, and
  two export lists). The same three kinds of question on the unmodified path took 7 requests and 130,686 prompt tokens, and its second and
  third answers were wrong (300000 where the file says 900000; the export question was answered about the wrong file).
* **Tool gating by a classifier was tried and shelved** (`foldcode-poc/shotgun/`, pre-registered, not in this repo). 63% of real turns used
  the full toolset and 29% used none. A local embedding classifier is safe (0.64% unsafe) but withholds only about 7% of tool characters
  (bar 20%; a perfect Haiku backup caps at 11.7%). Zero-shot qwen2.5-coder:1.5b and gemma2:2b agreed on wrong answers. The lever is not
  "which tools"; it is "no model reasoning where the machine can settle it", which is why this resolver exists.

## Known limits (read before relying on it)

* It is **on by default**, and a wrong mechanical answer would be served confidently. It fires only on exact single-definition numeric
  literals and on `export` lines, and any doubt is a gap. Set `FOLD_MECH=0` if you want it opt-in while you evaluate it.
* Coverage is narrow (constants, exports). The 23 questions came from one session built to test the fold, so real coverage will be lower.
* **Recall questions** ("from our conversation, what value did you report…") still take the heavy path. The register knows the answer, but a
  register hit only withholds research tools; it does not yet use this thin window (measured: 2 requests of about 18.7k tokens each).
* The `verify` mark is posted off the request path. In a one-shot CLI run the process can exit before it lands (seen once in six runs);
  the local `physics.jsonl` row is written first, so the check is never lost, only its ledger mark.
* `verify` checks that the answer states the finding, not that the answer says nothing else. It cannot catch an extra wrong claim.
* The model still makes one call to state the finding. A zero-call answer on Anthropic needs a model-shaped responder; the door's
  `/v1/gather` redirect speaks only OpenAI-chat.
* Wording matters. Put the finding in the system block, keep the user's message verbatim and last, and do not say "it is your own reading":
  the `<fold-openness>` block ("credit whose it is") then makes the model hedge or credit the finding to the user.
* The sealwall (`:8791`) returned 404 for every Anthropic model during this work. The app itself calls `api.anthropic.com` directly.
* `fold.ts` still fails `tsc` at one `capContext(...)` argument (a `Message[]` type mismatch). It was there before these changes.

## How to extend it

Add a resolver to `physics-mech.ts`: a pure function from `(ask, root, prior)` to
`{ ok: true, kind, text, at } | { ok: false, gap }`. Rules: answer only when exactly one reading exists; carry an address in `at`; never
guess (a gap is the correct answer to doubt); test against temp files; and check it against an independent truth (a compiler, `grep`, the
file itself) on files you did not tune on. Candidates: register recall, git-state lookups, "where is X defined", line counts.
