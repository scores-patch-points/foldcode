# fold-engine — vendored, and why

Vendored verbatim from **the fold** (the holodeck repo's pure research engine),
so openfold can detect structure in-process, with no server and no model.

| file | upstream | sha256 |
|---|---|---|
| `holodeck-research-null.js` | `holodeck/holodeck-research-null.js` | `da88b2d8e432421c8543f42e273e9955933e754912b7c4270d2f756bba73d04e` |
| `holodeck-research-read.js` | `holodeck/holodeck-research-read.js` | `4e6b51ac932e884f3a9971778fb9bbcce329f0c64c81cf689f595e28b7027743` |
| `holodeck-research-terrain.js` | `holodeck/holodeck-research-terrain.js` | `ae5c097a61409b73c41b5cafbb7b49b0e086cbe81dc761350098b8f44a8bfaed` |

Kept byte-identical **except for two disclosed local patches** (openfold, 2026-10-17), each forced by a falsifier:

| file | upstream sha256 | local change |
|---|---|---|
| `holodeck-research-null.js` | `da88b2d8…` | none (byte-identical) |
| `holodeck-research-read.js` | `4e6b51ac…` | **year-sieve patched** |
| `holodeck-research-terrain.js` | `ae5c097a…` | **referent gate on `breaks`** |

- **reader patch** (`holodeck-research-read.js`, `figuresIn`): upstream dropped any 4-digit number `1000–2099` as a year, even when a unit word followed — so `1200 cameras` vanished and its contradiction was invisible. Now only a *bare* year (no following unit word) is dropped. Falsifier: `falsify.test.mjs` B / B′.
- **terrain patch** (`holodeck-research-terrain.js`, the `field` cell): `breaks` now fire only when the differing values share an **earned referent** (a name both sources witness) — a referent-anchored contradiction. A bare unit collision with no shared referent is reported under `nominated`, never called a contradiction (the identity-by-appearance move II.7 refuses). Falsifier: `falsify.test.mjs` D / E.

Their relative imports (`./holodeck-research-null.js`, `./holodeck-research-read.js`, `./holodeck-contradiction.js`) resolve unchanged in this directory.

## The one substitution

`holodeck-contradiction.js` here is **not** the holodeck's engine — it is a
disclosed stand-in (see its header) so the terrain loads without the engine's
for-whom closure (`for-whom.js → dmd.js`, `identity.js → fold.js +
expectations.js`, `identity-meet.js`, `asserted.js`). The terrain calls it only
when the caller declares an observer (`input.forWhom`); this tool never does, so
the stand-in is never on the default path. The unit-string contradiction
(`differs` — two sources, different values for one figure unit) **is** computed
natively and is what `discover-structure` reports as "breaks". For-whom
contradictions require the live fold, never a guess here.

## Falsifying control

`discover.test.mjs` feeds material with a planted number difference across two
sources and asserts the break is found, and that a single source yields the
`single-source` notice. If the vendored engine drifts, the test fails.
