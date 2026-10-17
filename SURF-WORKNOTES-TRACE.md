# surf + worknotes — trace for other sessions (2026-10-15)

Left by the "OCxTF context window limits" session. Append below the line; do not rewrite above it.

## What exists (uncommitted)
- `khora/opencode-surf.mjs` — mechanical ladder over old opencode turns: Figure (newest, ask-term-scored sentences), Kind (older turns sharing a rare-term signature, admitted only when MDL gain > 0 with >= 2 independent grounds), Pattern (past the cap). No model.
- `khora/opencode-doorway.mjs` — `surf` event (listed in the handshake). Writes `~/.fold/worknotes/<sessionID>.md` (`FOLD_WORKNOTES_DIR`); text under `## notes` survives rewrites.
- `openfold/packages/core/src/plugin/fold.ts` — `surfPlan` / `surfApply`; `FOLD_KEEP_TURNS` (default 1, 0 = off); falls back to local truncation when the door is down.
- `khora/opencode-surf.test.mjs` — 4 tests, `node --test`.
- Contract: `openfold/UPSTREAM.md` (`surf` section).

## Evidence (7 turns, gemini-3.5-flash-lite, isolated door on 11466)
- surf off: input tokens 2521, 2547, 2841, 3173, 3465 (about +300/turn)
- surf on: 2578, 2802, 2905, 2977, 3003, 2994, 2833
- planted code word recovered with a non-leading final question
- not shown: flat at 50+ turns; whether the ladder beats a pointer-only note

## Added since (also uncommitted)
- `khora/opencode-worknotes.mjs` — task directory: append-only per-agent marks, atomic claims (O_EXCL, TTL decay, done final).
- `khora/opencode-rec.mjs` — REC: EOT.md + LOG.jsonl, exit 0 keeps / else reverts, fold last-wins. Picks up the holographic-coding skill (`.opencode/skills/holographic-coding`), whose runner already exists as `khora/native/the-fold/code-loop.js` (runVoidLoop). Not yet joined to it.
- Tests: `khora/opencode-{surf,worknotes,rec}.test.mjs`, 15 pass.
- Fork: root-session task default in `fold.ts` (typechecks; installed binary predates it).

## Open questions
1. Does the surf note collide with archons notes (both push onto `event.system` / the head message)?
2. Is there an existing mechanical summarizer (eoreader7 "mechanical summaries") that should replace the ladder's term scoring?
3. Ablation to run: `FOLD_SURF_MODE=pointer` (drop old turns, keep only the worknotes path) vs the ladder.

## Cautions
- The live door on 11436 is the old build (no `surf`); the fork fails open. Restart is the user's call.
- `opencode run` hangs unless stdin is `< /dev/null`.
- A harness door must set `FOLD_OPENCODE_STATE`, or it writes into khora's real `state/opencode`.

---
## Traces from other sessions (append here)
