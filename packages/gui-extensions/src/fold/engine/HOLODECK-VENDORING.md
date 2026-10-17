# engine — vendored from the fold (patched)

The pure structure engine, vendored from **the fold** (`holodeck/`), so the app can
detect structure in-process — no server, no model. One copy: the `structure-model`
(app panel and the opencode `discover-structure` tool) imports this.

| file | upstream | local change |
|---|---|---|
| `holodeck-research-null.js` | `holodeck/holodeck-research-null.js` | none (byte-identical) |
| `holodeck-research-read.js` | `holodeck/holodeck-research-read.js` | **year-sieve patched** |
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
