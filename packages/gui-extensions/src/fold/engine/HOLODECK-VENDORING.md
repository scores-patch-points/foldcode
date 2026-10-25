# engine — vendored from the fold (patched)

The pure structure engine, vendored from **the fold** (`holodeck/`), so the app can
detect structure in-process — no server, no model. One copy: the `structure-model`
(app panel and the opencode `discover-structure` tool) imports this.

| file | upstream | local change |
|---|---|---|
| `holodeck-research-null.js` | `holodeck/holodeck-research-null.js` | none (byte-identical) |
| `holodeck-research-read.js` | `holodeck/holodeck-research-read.js` @ `a756cbe` (scores-patch-points/holodeck#22) | **year-sieve patched** |
| `vendor/khora/native/adapters/text/{spans,priors}.js` | khora `native/adapters/text/` @ `b6d0f120` (via holodeck `a756cbe`) | none (byte-identical) — khora's one sentence cut |
| `vendor/khora/native/priors/punctuation-eng.json` | janus `priors/punctuation-eng.json` @ `b6852ea` (via holodeck `a756cbe`) | none (byte-identical) — English's measured abbreviations |
| `holodeck-research-terrain.js` | `holodeck/holodeck-research-terrain.js` | **referent gate on `breaks`** |
| `holodeck-contradiction.js` | — | stand-in (disclosed; the real for-whom engine is the door's) |

## The two patches (falsified first, then fixed)

The first build claimed `breaks` reports real contradictions. It was falsified on
2026-10-17 with two defects, both now patched and held by tests
(`structure-model.test.ts`, cases B / B′ / D / E):

1. **False negative** — `figuresIn` dropped any 4-digit number `1000–2099` as a year,
   even when a unit word followed, so `1200 cameras` vanished and its contradiction was
   invisible. Now only a *bare* year (no following unit word) is dropped.
2. **False positive** — `breaks` fired on any equal *unit string* (`dollar`, `branche`),
   the identity-by-appearance move `FOLD-CONSTITUTION II.7` forbids. Now a break needs the
   differing values to share an **earned referent** (a name both sources witness); a bare
   unit collision is reported under `nominated`, never called a contradiction.

The full for-whom identity decision remains the door's job; the app panel reports
`breaks` (anchored) and `nominated` (unanchored) separately, and never merges them.

## 2026-10-24 — the statement cut is khora's

`splitStatements` no longer carries its own regex cut and typed abbreviation list (`Mr|Mrs|Dr|St|Ltd|Inc|Co|No|…`). Inside each
line it calls khora's `spans.js::splitSentences`, told which dotted tokens are words by English's measured punctuation prior
(janus), the text's own, and any `abbreviations` a caller passes to `readSource(text, { abbreviations })`. Without a caller's
aliases, "St.", "Co." and "U.S." are cut where the typed list held them: only the hyperlexicon settles those, and it is not
in process here. The names (`namesIn`) are still this file's capitalised-run rule — the next piece to move onto khora's reader.
