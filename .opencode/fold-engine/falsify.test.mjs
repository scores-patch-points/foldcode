// falsify.test.mjs — the controls that FALSIFIED the first build, kept as the gate.
// Run: bun test falsify.test.mjs   (from this directory)
//
// The claim under test: the terrain's `breaks` reports REAL contradictions.
// It was falsified on 2026-10-17 with two defects, both now patched:
//   B) a true count in 1000-2099 ("1200 cameras") vanished as if a year → patched in holodeck-research-read.js
//   D/E) a unit-string collision with UNRELATED referents fired as a contradiction → patched in holodeck-research-terrain.js
// A fix that re-breaks any case below fails here.
import { test, expect } from "bun:test"
import { terrainOf } from "./holodeck-research-terrain.js"
import { readSource } from "./holodeck-research-read.js"
import { hash32 } from "./holodeck-research-null.js"

const shapeOf = (docs) => ({
  docs: docs.map((d) => ({ id: d.id, title: d.id })),
  sts: docs.flatMap((d) =>
    readSource(d.text).sts.map((s, i) => ({
      id: `${d.id}:${i}`, doc: d.id, s: s.s, e: s.e, text: s.text,
      names: s.names, figs: s.figs, dates: s.dates, frame: s.frame,
    })),
  ),
})
const run = (docs) => terrainOf(shapeOf(docs), { key: docs.map((d) => `${d.id}:${hash32(d.text)}`).join("|") })
const breakUnits = (t) => t.seeing.paradigm.breaks.map((b) => b.unit)
const nominatedUnits = (t) => t.seeing.paradigm.nominated.map((b) => b.unit)

test("A: a true contradiction, comma-formatted, is a break (detection works)", () => {
  const t = run([
    { id: "a", text: "Metro Nashville operates 1,200 cameras." },
    { id: "b", text: "Metro Nashville operates 1,500 cameras." },
  ])
  expect(breakUnits(t)).toContain("camera")
})

test("B: a true contradiction on an UNFORMATTED 4-digit count is a break (was a false negative)", () => {
  const t = run([
    { id: "a", text: "Metro Nashville operates 1200 cameras." },
    { id: "b", text: "Metro Nashville operates 1500 cameras." },
  ])
  expect(breakUnits(t)).toContain("camera")
})

test("B': a bare year is still not a figure", () => {
  const t = run([
    { id: "a", text: "Metro Nashville operated cameras in 2026." },
    { id: "b", text: "Metro Nashville operated cameras in 2027." },
  ])
  expect(breakUnits(t)).not.toContain("2026")
  expect(breakUnits(t)).not.toContain("2027")
})

test("C: agreement on the same value is not a break", () => {
  const t = run([
    { id: "a", text: "The library budget was 120 dollars." },
    { id: "b", text: "The library budget was 120 dollars." },
  ])
  expect(t.seeing.paradigm.breaks.length).toBe(0)
})

test("D: same unit, UNRELATED referents — nominated, never a break (was a false positive)", () => {
  const t = run([
    { id: "a", text: "The library budget was 120 dollars." },
    { id: "b", text: "Ticket sales reached 340 dollars." },
  ])
  expect(t.seeing.paradigm.breaks.length).toBe(0)
  expect(nominatedUnits(t)).toContain("dollar")
})

test("E: another unit collision with unrelated subjects — nominated, never a break", () => {
  const t = run([
    { id: "a", text: "The library opened 12 branches." },
    { id: "b", text: "The storm damaged 45 branches." },
  ])
  expect(t.seeing.paradigm.breaks.length).toBe(0)
  expect(nominatedUnits(t)).toContain("branche")
})

test("recurrence survives the reshuffle null: planted echoes beat a word-frequency-preserving reshuffle", () => {
  const docs = [
    { id: "p1", text: "Metro Nashville operates 1200 cameras in 2026. Chief Drake said the network grew. Flock Safety supplies Metro Nashville." },
    { id: "p2", text: "Metro Nashville operates 1500 cameras in 2026. Chief Drake said the network grew. Flock Safety supplies Metro Nashville." },
    { id: "p3", text: "Metro Nashville operates 1500 cameras in 2026. Chief Drake said the network grew. Flock Safety supplies Metro Nashville." },
  ]
  const planted = run(docs).seen.link.echoes.length
  const bag = docs.flatMap((d) => d.text.split(/\s+/)).filter(Boolean)
  const seeded = (s) => () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const shuffled = Array.from({ length: 5 }, (_, k) => {
    const r = seeded(1234 + k)
    return run(docs.map((d) => ({ id: d.id, text: d.text.split(/\s+/).filter(Boolean).map(() => bag[Math.floor(r() * bag.length)]).join(" ") }))).seen.link.echoes.length
  })
  expect(planted).toBeGreaterThan(Math.max(...shuffled))
})
