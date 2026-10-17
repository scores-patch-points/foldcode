// structure-model.test.ts — the model both surfaces share, tested against the engine's own
// falsifiers. Run: bun test structure-model.test.ts (from packages/gui-extensions).
import { test, expect } from "bun:test"
import { buildReading, structureOf, structureFromText } from "./structure-model"
import { rng } from "./engine/holodeck-research-null.js"

const sources = [
  { id: "a", title: "a", text: "Metro Nashville searched 227 plates in August 2026. Flock Safety runs the cameras." },
  { id: "b", title: "b", text: "A second record says Metro Nashville searched 340 plates. Flock Safety runs the network." },
]

test("a shared earned referent + differing values is a break", () => {
  const t = structureOf(sources)
  const units = t.seeing.paradigm.breaks.map((b: { unit: string }) => b.unit)

  expect(units).toContain("plate")
})

test("a unit collision with unrelated subjects is nominated, never a break", () => {
  const t = structureOf([
    { id: "a", title: "a", text: "The library budget was 120 dollars." },
    { id: "b", title: "b", text: "Ticket sales reached 340 dollars." },
  ])

  expect(t.seeing.paradigm.breaks.length).toBe(0)
  expect(t.seeing.paradigm.nominated.map((n: { unit: string }) => n.unit)).toContain("dollar")
})

test("a comma-formatted 4-digit count is a break (a year is never 1,200)", () => {
  const t = structureOf([
    { id: "a", title: "a", text: "Metro Nashville operates 1,200 cameras." },
    { id: "b", title: "b", text: "Metro Nashville operates 1,500 cameras." },
  ])

  expect(t.seeing.paradigm.breaks.map((b: { unit: string }) => b.unit)).toContain("camera")
})

test("an unformatted in-range count is ambiguous — nominated, never asserted", () => {
  const t = structureOf([
    { id: "a", title: "a", text: "Metro Nashville operates 1200 cameras." },
    { id: "b", title: "b", text: "Metro Nashville operates 1500 cameras." },
  ])

  expect(t.seeing.paradigm.breaks.length).toBe(0)
  expect(t.seeing.paradigm.nominated.map((n: { unit: string }) => n.unit)).toContain("camera")
})

test("a year plus a noun is not a contradiction (was a false break on 'report')", () => {
  const t = structureOf([
    { id: "a", title: "a", text: "Metro Nashville published the 2026 report." },
    { id: "b", title: "b", text: "Metro Nashville published the 2027 report." },
  ])

  expect(t.seeing.paradigm.breaks.length).toBe(0)
})

test("a currency figure's span does not swallow the next word", () => {
  const t = structureFromText("The budget was $1,200 for the project.")
  const raw = t.seen.field.units[0]?.values[0]?.raw

  expect(raw).toBe("$1,200")
})

test("buildReading cuts statements with their spans, and structure is deterministic", () => {
  const reading = buildReading(sources)

  expect(reading.sts[0]?.id).toBe("a:0")
  expect(JSON.stringify(structureOf(sources))).toBe(JSON.stringify(structureOf(sources)))
})

test("structureFromText reads one inline source", () => {
  const t = structureFromText("Only one source says 5 plates.")

  expect(t.seen.void.notices.some((n: { kind: string }) => n.kind === "single-source")).toBe(true)
})

test("a bare year is not a figure (the year sieve still holds)", () => {
  const t = structureOf([
    { id: "a", title: "a", text: "Metro Nashville operated cameras in 2026." },
    { id: "b", title: "b", text: "Metro Nashville operated cameras in 2027." },
  ])

  const units = t.seeing.paradigm.breaks.map((b: { unit: string }) => b.unit)

  expect(units).not.toContain("2026")
  expect(units).not.toContain("2027")
})

const RECURRENCE = [
  { id: "p1", title: "p1", text: "Metro Nashville operates 1200 cameras in 2026. Chief Drake said the network grew. Flock Safety supplies Metro Nashville." },
  { id: "p2", title: "p2", text: "Metro Nashville operates 1500 cameras in 2026. Chief Drake said the network grew. Flock Safety supplies Metro Nashville." },
  { id: "p3", title: "p3", text: "Metro Nashville operates 1500 cameras in 2026. Chief Drake said the network grew. Flock Safety supplies Metro Nashville." },
]

test("recurrence survives the reshuffle null: planted echoes beat a word-frequency-preserving reshuffle", () => {
  const bag = RECURRENCE.flatMap((d) => d.text.split(/\s+/)).filter(Boolean)
  const planted = structureOf(RECURRENCE).seen.link.echoes.length

  const shuffled = Array.from({ length: 5 }, (_, k) => {
    const r = rng(1234 + k)

    const run = RECURRENCE.map((d) => {
      const words = d.text.split(/\s+/).filter(Boolean).map(() => bag[Math.floor(r() * bag.length)] ?? "")

      return { id: d.id, title: d.title, text: words.join(" ") }
    })

    return structureOf(run).seen.link.echoes.length
  })

  expect(planted).toBeGreaterThan(Math.max(...shuffled))
})
