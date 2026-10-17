/// <reference path="../env.d.ts" />
import { tool } from "@opencode/plugin"
import { readdirSync, statSync } from "node:fs"
import { join, extname, basename, resolve } from "node:path"
import { structureOf, type Source } from "../../packages/gui-extensions/src/fold/structure-model"

// discover-structure — the agent's door onto the ONE pure structure model the openfold app's
// Structure panel also uses (packages/gui-extensions/src/fold/structure-model). Point it at
// material and read back the nine registers the fold MEASURES — model-free. This file adds
// only the parts a dev tool needs and a browser cannot have: reading a path off disk, asking
// the live fold for its ant swarm, and formatting the result as text.

const PROXY = process.env.FOLD_PROXY ?? process.env.FOLD_URL ?? "http://127.0.0.1:11436"
const MAX_FILE_BYTES = 512 * 1024
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tif", ".tiff",
  ".pdf", ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar",
  ".mp3", ".wav", ".ogg", ".m4a", ".flac", ".mp4", ".mov", ".webm", ".mkv",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".wasm", ".node", ".dylib", ".so", ".dll", ".exe", ".class", ".o", ".a",
])
const SKIP_DIR = new Set(["node_modules", ".git", ".svn", ".hg", "dist", "build", ".next", ".cache", "__pycache__"])

async function readMaybeText(path: string): Promise<string | null> {
  const size = statSync(path).size
  if (size === 0 || size > MAX_FILE_BYTES) return null
  try {
    const buffer = new Uint8Array(await Bun.file(path).arrayBuffer())
    const sample = buffer.subarray(0, Math.min(4096, buffer.length))
    if (sample.includes(0)) return null
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer)
  } catch {
    return null
  }
}

/** A path that exists is read from disk (a folder recursively, text-like files only); anything else is the material itself. */
async function resolveSources(material: string): Promise<{ name: string; from: string; sources: Source[]; skipped: string[] }> {
  const path = resolve(material)
  let kind: "dir" | "file" | null = null

  try {
    if (material.length < 4096) {
      const s = statSync(path)
      kind = s.isDirectory() ? "dir" : s.isFile() ? "file" : null
    }
  } catch {
    kind = null
  }

  if (!kind) return { name: "material", from: "inline", sources: [{ id: "material", title: "material (inline)", text: material }], skipped: [] }

  if (kind === "file") {
    const text = await readMaybeText(path)
    if (text == null) return { name: basename(path), from: "file", sources: [], skipped: [basename(path)] }
    return { name: basename(path), from: "file", sources: [{ id: basename(path), title: basename(path), text }], skipped: [] }
  }

  const sources: Source[] = []
  const skipped: string[] = []
  for (const rel of readdirSync(path, { recursive: true })) {
    const id = String(rel).split(/[\\/]/).join("/")
    if (id.split("/").some((seg) => SKIP_DIR.has(seg))) continue
    if (basename(id).startsWith(".")) continue
    if (SKIP_EXT.has(extname(id).toLowerCase())) continue
    const full = join(path, id)
    if (!statSync(full).isFile()) continue
    const text = await readMaybeText(full)
    if (text == null || !text.trim()) {
      skipped.push(id)
      continue
    }
    sources.push({ id, title: id, text })
  }
  sources.sort((a, b) => (a.id < b.id ? -1 : 1))
  return { name: basename(path), from: "folder", sources, skipped }
}

type Swarm = { pointed?: string[]; best?: { ids?: string[]; f?: number }; ants?: { ids?: string[]; f?: number }[]; residue?: { line?: string; untouchedTerrains?: string[]; counted?: Record<string, number> } }

async function foldReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${PROXY}/v1/models`, { signal: AbortSignal.timeout(900) })
    return r.ok
  } catch {
    return false
  }
}

async function runSwarm(name: string, sources: Source[], task: string): Promise<Swarm | { gap: string }> {
  try {
    const r = await fetch(`${PROXY}/v1/swarm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, name, attachments: sources.slice(0, 40).map((s) => ({ name: s.id, text: s.text })) }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!r.ok) return { gap: `fold proxy answered ${r.status}` }
    return (await r.json()) as Swarm
  } catch (error) {
    return { gap: `fold proxy unreachable (${error instanceof Error ? error.message : String(error)})` }
  }
}

const cap = <T,>(xs: T[], n: number): (T | string)[] => (xs.length > n ? [...xs.slice(0, n), `… +${xs.length - n} more`] : xs)

function render(name: string, from: string, t: ReturnType<typeof structureOf>, swarm: Swarm | { gap: string } | null, maxRows: number): string {
  const L: string[] = []
  const c = t.counts
  L.push(`# Discovered structure — ${name}  (FoldStructure@1 · model calls: 0 · source: ${from})`, "")
  L.push(`Counts: sources=${c.sources} statements=${c.statements} referents=${c.referents} earned=${c.earned} ties=${c.ties} echoes=${c.echoes}`, "")
  L.push("## SEEN")
  const v = t.seen.void
  L.push(`- Void (Sources): ${v.sources.length} source(s), ${v.statements} statements, ${v.referents} referents (${v.earned} earned)`)
  for (const notice of v.notices) L.push(`    · notice [${notice.kind}]: ${notice.why}`)
  L.push(`- Entity (Names): ${cap(t.seen.entity.rows.slice(0, maxRows).map((r: { name: string; standing: string }) => `${r.name} [${r.standing}]`), maxRows).join(" · ") || "none"}`)
  L.push(`- Field (Figures): ${cap(t.seen.field.units.slice(0, maxRows).map((u: { unit: string; values: { raw: string }[]; contradicts: boolean; differs: boolean }) => `${u.unit}: ${u.values.map((x) => x.raw).slice(0, 4).join("/")}${u.contradicts ? " ⚠break" : u.differs ? " · differs" : ""}`), maxRows).join(" · ") || "none"}`)
  L.push(`- Network (Connections): ${t.seen.network.edges.length} tie(s) beating chance`)
  for (const edge of t.seen.network.edges.slice(0, maxRows)) L.push(`    · ${edge.a} — ${edge.b} (k=${edge.k}, witnesses=${edge.witnesses})`)
  L.push("")
  L.push("## SEEING")
  const p = t.seeing.paradigm
  L.push(`- Paradigm (Patterns): ${p.groups.length} group(s), ${p.stray.length} stray source(s), echoFloor=${p.echoFloor}`)
  if (p.breaks.length) {
    L.push(`    · breaks (referent-anchored contradictions): ${p.breaks.length}`)
    for (const b of p.breaks.slice(0, maxRows)) L.push(`        - [${b.unit}]${b.anchors?.length ? ` (anchored on ${b.anchors.join(", ")})` : ""}: ${b.values.map((x: { raw: string }) => x.raw).slice(0, 6).join(" vs ")}`)
  }
  if (p.nominated.length) {
    L.push(`    · nominated (unit collisions, NO shared referent — never called contradictions): ${p.nominated.length}`)
    for (const b of p.nominated.slice(0, maxRows)) L.push(`        - [${b.unit}]: ${b.values.map((x: { raw: string }) => x.raw).slice(0, 6).join(" vs ")}`)
  }
  L.push("")
  if (swarm && !("gap" in swarm)) {
    const signal = (swarm.ants ?? []).filter((a) => (a.f ?? 0) > 0).map((a) => `${(a.ids ?? []).join("+")}=${a.f}`)
    L.push(`## Ants (live fold, ${(swarm.pointed ?? []).length} pointed)`)
    L.push(`- best: ${(swarm.best?.ids ?? []).join("+") || "—"} at ${swarm.best?.f ?? 0}`)
    L.push(`- signal: ${cap(signal, maxRows).join(" · ") || "none"}`)
    if (swarm.residue) L.push(`- residue: ${swarm.residue.line}`)
  } else if (swarm) {
    L.push(`## Ants (live fold)`, `- not run: ${swarm.gap} (the terrain above is still the full in-process read)`)
  }
  L.push("", "Every statement id is `<source>:<n>`; every row carries the byte span it stands on. A tie, echo, group or break stands only because it beat every one of 199 same-size random draws.")
  return L.join("\n")
}

export default tool({
  description: `Mechanically discover the structure of any material and return it — no model calls.

Point it at inline text or a path (a file, or a whole folder read recursively). A mechanical reader splits the material into statements, each carrying the byte span it came from, and lays them out by the fold's nine registers: Void (sources), Entity (names), Kind (types), Field (figures), Link (statements), Network (connections) / Atmosphere (framing), Lens (views), Paradigm (what recurs across sources and what breaks it). Every tie, echo, group and break is decided against 199 same-size random draws, never a hand-set threshold. A break is a referent-anchored contradiction; a same-unit collision with no shared referent is reported as nominated, never as a contradiction.

When the live fold (the khora proxy on 127.0.0.1:11436) is up, it also runs the ant swarm so the result carries the residue — the terrains no framing reached and the typed gaps the capacities could not read. Absence is a result: a gap is reported, never filled.

Use this to find hidden structure — recurring arrangements, cross-source agreement, and referent-anchored contradictions — with addresses, so every claim descends to the bytes it was read from.`,
  args: {
    material: tool.schema.string().describe("Inline text, or a path to a file or folder on disk (a folder is read recursively, text-like files only)."),
    query: tool.schema.string().optional().describe("The ask, in your words. Names what the ants should point at (e.g. 'swarm everything'). Defaults to 'swarm everything'."),
    ants: tool.schema.boolean().optional().describe("Also run the live fold's ant swarm for the residue. Default true (a typed gap if the fold is not up)."),
    maxRows: tool.schema.number().optional().describe("Cap the rows listed per register. Default 8."),
  },
  async execute(args) {
    const maxRows = Math.max(1, Math.min(50, args.maxRows ?? 8))
    const { name, from, sources, skipped } = await resolveSources(args.material)
    if (!sources.length) return `# Discovered structure — ${name}\n\nNo readable text was found at the path (binary, empty, or oversize files only). Residue: nothing was read.`
    const structure = structureOf(sources)
    const swarm = args.ants === false ? null : (await foldReachable()) ? await runSwarm(name, sources, args.query ?? "swarm everything") : { gap: `fold proxy not reachable at ${PROXY}` }
    const out = render(name, from, structure, swarm, maxRows)
    return skipped.length ? `${out}\n\nSkipped (unreadable/binary): ${cap(skipped, 20).join(", ")}` : out
  },
})
