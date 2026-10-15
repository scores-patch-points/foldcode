---
name: holographic-coding
description: Code holographically - append-only EOT log, smallest unit, redefine referents, hunt-first snip-by-address with provenance, mouth-last tiny draws for efficient local-model coding. Use when user says holographic, EOT log, void-chasing, hunt and snip, or asks for local-model efficient coding.
---

# Holographic Coding

Current state = fold(EOT log). Never mutate. Append smallest unit. Redefine referents to update recursively.

## 1. DEF the void first (one reader, one question)

Before any code, declare:
`slot: file#range + behavior | anchor: exact signature + docstring | kind: def-type allowed | extent: what it must cover | cardinality: how many fillers | dependence: test that decides`

Omission = typed gap, never default. Example: `slot: retry.ts#12-30, anchor: retry(fn), kind: async-fn, test: bun test retry`.

## 2. Wald pulls - cheapest first, model last

Order: `BOX compute > thread/local > field hunt > GitHub raw > web raw > MODEL draw`.
- BOX: compute mechanical shape, try apply + test. Green = done.
- HUNT: `scanField` same-name decl (own file excluded) → `raw.githubusercontent` bytes → web raw. Snip verbatim `path#c0-c1`, keep imports. Frame-match spec words, else refuse.
- MODEL only for irreducible residue: one function body from completion anchor (`def name(` + indent + docstring + last failure slice 400 chars). `maxTokens ~512`.

Two bars: possible = 1 witness (structural). Probable = beats test/null + independent witnesses count once.

## 3. Hunt and snip rules

- Needle only LOCATES. Cut verbatim bytes, `<=1500 chars`, strip fences/prose, dedent/re-indent to target.
- Every copied span: `source path + sha256 + c0-c1 + url/fetchedWith`. Unverified quote = typed gap.
- Facing-page: `[S#]` = grounded to snip address, `[M]` = mouth's own bridge. No third kind.
- Retrieved snippets shape the patch, never supply content unchecked. Do not infer exclusivity from co-mention.

## 4. EOT append-only + redefine referent

File: `EOT.md` in repo root or skill dir. One block = one referent + one fact:

```md
### e042 · 2026-10-15 · referent: `retryPolicy`
supersedes: e031
+ maxRetries: 3 -> 5 with jitter
check: `bun test retry`
◼ EOT
```

Rules:
- Never edit prior block. Update = new block with `supersedes:` + new version (`auth@4 supersedes auth@3`).
- Smallest unit: one referent, one behavior, one test.
- Fold = last-wins per referent. Full history preserved.
- Co-partition (disjoint extents) ≠ contest (overlap on functional relation). Arithmetic over extents decides coverage.

## 5. Provenance every line

`LOG.jsonl` append-only, one line per action:
`{"seq":0,"schema":"VoidLog@1","round":0,"file":"...","action":"BOX|HUNT|SPIRAL|done","target":"...","by":"box|hunt|mouth","verdict":"green|reverted","source":"box|field|web-github|web","address":"rel#s-e|https://raw...","model":"box|hunt|<model-id>","basis":"...","dissent":"..."}`

- `model:` disclosed always. `seq` continues from file length.
- Real `testCommand` exit code is only judge. Red names unit = revert before next draw. Red not naming unit = carry. 2 reverts = wall unit, move files. 4x = `hunt_exhausted` disclosed.
- Report `seamDensity=(total-source)/total` + `mouthShare` first. Never as quality — lawful ≠ correct.

## 6. Refuse typed, falsify-or-die

- No filler of asked type in scope → `gap: no filler`, return void shape. Never nearby-fill (Mozart/Vienna rule: namesake ≠ anchor).
- Every artifact carries dissent: scars, refusals, non-convergence, residual.
- No self-grade gate. Frozen sibling test decides, not generator.
- W (thread) is forgeable — salted thread shifts grain (reported) but never raises record standing. Span with no provenance never enters held set.

## Distance (grain x mode)

Distance = share of activated region absent from W. Ground (far: Clearing/Tending/Cultivating = survey), Figure (mid: Dissecting/Binding/Making = argument), Pattern (near: Unraveling/Tracing/Composing = essay/edge).
`shorter/simpler/explain` are distance commands. Clearing runs first, zero seams, no reader.

See `EOT.md` for format demo, `LOG.example.jsonl` for log shape.
