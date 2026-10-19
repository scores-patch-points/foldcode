// The pure structure model — one model, both surfaces. The foldcode app's Structure panel
// and the opencode `discover-structure` tool both call THIS, so there is one definition of
// "what structure is here". Browser-safe: no node:fs, no network, no model. A mechanical
// reader splits material into statements (each carrying the byte span it came from) and the
// vendored terrain engine lays them out by the nine registers — every tie, echo, group and
// break decided against 199 drawn nulls.
//
// The engine is vendored (patched) from the fold; see engine/HOLODECK-VENDORING.md for the
// two disclosed local patches and their falsifiers.
import { terrainOf } from "./engine/holodeck-research-terrain.js"
import { readSource } from "./engine/holodeck-research-read.js"
import { hash32 } from "./engine/holodeck-research-null.js"

/** One source of material: an id (its address), a title, and its text. */
export type Source = { id: string; title: string; text: string }

/** A statement the reader cut, carrying the span `[s, e)` it came from in its source. */
export type Statement = {
  id: string
  doc: string
  s: number
  e: number
  text: string
  names: string[]
  figs: ReadonlyArray<{ raw: string; value: number; unit: string; s: number; e: number }>
  dates: ReadonlyArray<{ raw: string; year: number | null; s: number; e: number }>
  frame: string
}

/** The reading shape the terrain engine consumes. */
export type Reading = { docs: ReadonlyArray<{ id: string; title: string }>; sts: ReadonlyArray<Statement> }

// The engine is plain JS, so its output is untyped here. `Structure` is the honest name for
// "the terrain the engine measured"; callers read its named cells. Not `any`: it is opaque.
export type Structure = ReturnType<typeof terrainOf>

/** Cut `sources` into statements. Pure. */
export function buildReading(sources: ReadonlyArray<Source>): Reading {
  const docs = sources.map((source) => ({ id: source.id, title: source.title }))

  const sts: Statement[] = sources.flatMap((source) =>
    readSource(source.text).sts.map((statement, i) => ({
      id: `${source.id}:${i}`,
      doc: source.id,
      s: statement.s,
      e: statement.e,
      text: statement.text,
      names: statement.names,
      figs: statement.figs,
      dates: statement.dates,
      frame: statement.frame,
    })),
  )

  return { docs, sts }
}

/** A stable key over the material, so the nulls are seeded from it — same material, same structure. */
export function structureKey(sources: ReadonlyArray<Source>): string {
  return sources.map((source) => `${source.id}:${hash32(source.text)}`).join("|")
}

/** The terrain of a set of sources: the nine registers, the paradigm cell, and the residue. */
export function structureOf(sources: ReadonlyArray<Source>): Structure {
  return terrainOf(buildReading(sources), { key: structureKey(sources) })
}

/** The terrain of a single piece of text, as one source. */
export function structureFromText(text: string, name = "material"): Structure {
  return structureOf([{ id: name, title: name, text }])
}

/** The nine registers, in their three rows, with the surface's plain names. */
export const REGISTERS = [
  { key: "void", plain: "Sources" },
  { key: "entity", plain: "Names" },
  { key: "kind", plain: "Types" },
  { key: "field", plain: "Figures" },
  { key: "link", plain: "Statements" },
  { key: "network", plain: "Connections" },
  { key: "atmosphere", plain: "Framing" },
  { key: "lens", plain: "Views" },
  { key: "paradigm", plain: "Patterns" },
] as const
