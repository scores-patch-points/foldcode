/// <reference path="../env.d.ts" />
import { tool } from "@opencode/plugin"
import { discoverStructure } from "../fold-engine/discover.mjs"

export default tool({
  description: `Mechanically discover the structure of any material and return it — no model calls.

Point it at inline text or a path (a file, or a whole folder read recursively). A mechanical reader splits the material into statements, each carrying the byte span it came from, and lays them out by the fold's nine registers: Void (sources), Entity (names), Kind (types), Field (figures), Link (statements), Network (connections) / Atmosphere (framing), Lens (views), Paradigm (what recurs across sources and what breaks it). Every tie, echo, group and break is decided against 199 same-size random draws, never a hand-set threshold.

When the live fold (the khora proxy on 127.0.0.1:11436) is up, it also runs the ant swarm on the material so the result carries the residue — the terrains no framing reached and the typed gaps the capacities could not read. Absence is a result: a gap is reported, never filled.

Use this to find hidden structure — recurring arrangements, cross-source agreement, and contradictions ("these two figures differ for the same unit") — with addresses, so every claim descends to the bytes it was read from.`,
  args: {
    material: tool.schema.string().describe("Inline text, or a path to a file or folder on disk (a folder is read recursively, text-like files only)."),
    query: tool.schema.string().optional().describe("The ask, in your words. Names what the ants should point at (e.g. 'swarm everything'). Defaults to 'swarm everything'."),
    ants: tool.schema.boolean().optional().describe("Also run the live fold's ant swarm for the residue. Default true (a typed gap if the fold is not up)."),
    maxRows: tool.schema.number().optional().describe("Cap the rows listed per register. Default 8."),
  },
  execute(args) {
    return discoverStructure(args)
  },
})
