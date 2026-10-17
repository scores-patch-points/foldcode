// discover.test.mjs — the mechanical check, offline (ants off, no proxy).
// Run: bun test .opencode/fold-engine/discover.test.mjs
import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { discoverStructure, readingShape, structureKey } from "./discover.mjs"
import { terrainOf } from "./holodeck-research-terrain.js"

const twoSources = [
  { id: "a", title: "a", text: "Metro Nashville searched 227 plates in August 2026. Flock Safety runs the cameras." },
  { id: "b", title: "b", text: "A second record says Metro Nashville searched 340 plates. Flock Safety runs the network." },
]

test("a planted figure difference across two sources is found as a break", () => {
  const t = terrainOf({ docs: twoSources.map((d) => ({ id: d.id, title: d.title })), sts: readingShape(twoSources).sts }, { key: structureKey(twoSources) })
  const breaks = t.seeing.paradigm.breaks.filter((b) => b.kind === "figures differ")
  expect(breaks.length).toBeGreaterThan(0)
  const plate = breaks.find((b) => b.unit === "plate")
  expect(plate).toBeTruthy()
  const raws = plate.values.map((v) => v.raw)
  expect(raws).toContain("227 plates")
  expect(raws).toContain("340 plates")
})

test("a name two sources say earns standing; the single-source shape notices isolation", () => {
  const t = terrainOf({ docs: twoSources.map((d) => ({ id: d.id, title: d.title })), sts: readingShape(twoSources).sts }, { key: structureKey(twoSources) })
  const earned = Object.values(t.seen.entity.rows).filter((r) => r.standing === "earned").map((r) => r.name)
  expect(earned).toContain("Flock Safety")

  const one = [{ id: "solo", title: "solo", text: "Only one source says 5 plates." }]
  const t1 = terrainOf({ docs: [{ id: "solo", title: "solo" }], sts: readingShape(one).sts }, { key: structureKey(one) })
  expect(t1.seen.void.notices.some((n) => n.kind === "single-source")).toBe(true)
})

test("the terrain is deterministic: same material + key, same structure", () => {
  const shapeOf = (docs) => ({ docs: docs.map((d) => ({ id: d.id, title: d.title })), sts: readingShape(docs).sts, types: {}, echoes: {}, gaps: [] })
  const a = terrainOf(shapeOf(twoSources), { key: structureKey(twoSources) })
  const b = terrainOf(shapeOf(twoSources), { key: structureKey(twoSources) })
  expect(JSON.stringify(a)).toBe(JSON.stringify(b))
})

test("discoverStructure reads a folder offline (ants:false) and finds the structure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "discover-"))
  for (const d of twoSources) writeFileSync(join(dir, d.id + ".txt"), d.text)
  const out = await discoverStructure({ material: dir, ants: false, maxRows: 4 })
  expect(out).toContain("FoldStructure@1")
  expect(out).toContain("source: folder")
  // "Metro Nashville" is shared and earned across the two sources, so the plate counts differ as a break.
  expect(out).toContain("figures differ")
  expect(out).not.toContain("## Ants")
})
