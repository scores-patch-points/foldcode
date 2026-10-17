// discover.mjs — the mechanical structure discovery, with no opencode
// dependency, so it can be run and tested on its own:
//
//   node -e 'import("./.opencode/fold-engine/discover.mjs").then(m=>m.discoverStructure({material:"/path"}).then(console.log))'
//
// Point it at inline text or a path (file, or folder read recursively). A
// mechanical reader splits the material into statements, each carrying the byte
// span it came from; the pure terrain engine lays them out by the nine
// registers; the live fold's ant swarm (if the khora proxy is up) supplies the
// residue. Model calls: 0.

import { readdirSync, statSync } from "node:fs"
import { join, extname, basename, resolve } from "node:path"
import { terrainOf } from "./holodeck-research-terrain.js"
import { readSource } from "./holodeck-research-read.js"
import { hash32 } from "./holodeck-research-null.js"

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

const isProbablyTextFile = (path) => !SKIP_EXT.has(extname(path).toLowerCase())

async function readMaybeText(path) {
  const size = statSync(path).size
  if (size === 0 || size > MAX_FILE_BYTES) return null
  try {
    const buf = new Uint8Array(await Bun.file(path).arrayBuffer())
    const sample = buf.subarray(0, Math.min(4096, buf.length))
    if (sample.includes(0)) return null
    return new TextDecoder("utf-8", { fatal: false }).decode(buf)
  } catch {
    return null
  }
}

/** Resolve `material` into a name and text docs. A path that exists is read
 *  from disk (a folder recursively, text-like files only); anything else is
 *  the material itself, inline. */
export async function resolveDocs(material) {
  const p = resolve(material)
  let kind = null
  try {
    if (material.length < 4096) {
      const s = statSync(p)
      kind = s.isDirectory() ? "dir" : s.isFile() ? "file" : null
    }
  } catch {
    kind = null
  }
  if (!kind) return { name: "material", from: "inline", docs: [{ id: "material", title: "material (inline)", text: material }], skipped: [] }
  if (kind === "file") {
    const text = await readMaybeText(p)
    if (text == null) return { name: basename(p), from: "file", docs: [], skipped: [basename(p)] }
    return { name: basename(p), from: "file", docs: [{ id: basename(p), title: basename(p), text }], skipped: [] }
  }
  const docs = []
  const skipped = []
  for (const rel of readdirSync(p, { recursive: true })) {
    const id = String(rel).split(/[\\/]/).join("/")
    if (id.split("/").some((seg) => SKIP_DIR.has(seg))) continue
    if (basename(id).startsWith(".")) continue
    if (!isProbablyTextFile(id)) continue
    const full = join(p, id)
    if (!statSync(full).isFile()) continue
    const text = await readMaybeText(full)
    if (text == null || !text.trim()) {
      skipped.push(id)
      continue
    }
    docs.push({ id, title: id, text })
  }
  docs.sort((a, b) => (a.id < b.id ? -1 : 1))
  return { name: basename(p), from: "folder", docs, skipped }
}

export function readingShape(docs) {
  const outDocs = docs.map((d) => ({ id: d.id, title: d.title }))
  const sts = []
  for (const d of docs) {
    const parsed = readSource(d.text)
    parsed.sts.forEach((s, i) => {
      sts.push({ id: `${d.id}:${i}`, doc: d.id, s: s.s, e: s.e, text: s.text, names: s.names, figs: s.figs, dates: s.dates, frame: s.frame })
    })
  }
  return { docs: outDocs, sts }
}

export function structureKey(docs) {
  return docs.map((d) => `${d.id}:${hash32(d.text)}`).join("|")
}

export async function foldReachable() {
  try {
    const r = await fetch(`${PROXY}/v1/models`, { signal: AbortSignal.timeout(900) })
    return r.ok
  } catch {
    return false
  }
}

export async function runSwarm(name, docs, task) {
  try {
    const r = await fetch(`${PROXY}/v1/swarm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task, name, attachments: docs.slice(0, 40).map((d) => ({ name: d.id, text: d.text })) }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!r.ok) return { gap: `fold proxy answered ${r.status}` }
    return await r.json()
  } catch (e) {
    return { gap: `fold proxy unreachable (${e instanceof Error ? e.message : String(e)})` }
  }
}

const cap = (xs, n) => (xs.length > n ? [...xs.slice(0, n), `… +${xs.length - n} more`] : xs)

export function render(name, from, t, swarm, maxRows) {
  const L = []
  const c = t.counts
  L.push(`# Discovered structure — ${name}  (FoldStructure@1 · model calls: 0 · source: ${from})`)
  L.push("")
  L.push(`Counts: sources=${c.sources} statements=${c.statements} referents=${c.referents} earned=${c.earned} ties=${c.ties} echoes=${c.echoes}`)
  L.push("")
  L.push("## SEEN")
  const v = t.seen.void
  L.push(`- Void (Sources): ${v.sources.length} source(s), ${v.statements} statements, ${v.referents} referents (${v.earned} earned, ${v.heardOnce} heard once)`)
  for (const n of v.notices) L.push(`    · notice [${n.kind}]: ${n.why}`)
  L.push(`- Entity (Names): ${cap(t.seen.entity.rows.slice(0, maxRows).map((r) => `${r.name} [${r.standing}; ${r.sources.length} src; at ${r.at[0]?.doc ?? "?"}:${r.at[0]?.s ?? "?"}]`), maxRows).join(" · ") || "none"}`)
  L.push(`- Kind (Types): ${cap(t.seen.kind.kinds.slice(0, maxRows).map((k) => `${k.kind}×${k.n}`), maxRows).join(" · ") || "none"}`)
  L.push(`- Field (Figures): ${cap(t.seen.field.units.slice(0, maxRows).map((u) => `${u.unit}: ${u.values.map((x) => x.raw).slice(0, 4).join("/")}${u.differs ? " ⚠differs" : ""}`), maxRows).join(" · ") || "none"}`)
  L.push(`- Link (Statements): ${t.seen.link.statements.length} statement(s); ${t.seen.link.echoes.length} echo(es) across sources`)
  L.push(`- Network (Connections): ${t.seen.network.edges.length} tie(s) beating chance${t.seen.network.beatChance ? ` (${t.seen.network.beatChance} beat, ${t.seen.network.earned} witnessed by ≥2 sources)` : ""}`)
  for (const e of t.seen.network.edges.slice(0, maxRows)) L.push(`    · ${e.a} — ${e.b}  (k=${e.k}, null≤${e.nullMax}, witnesses=${e.witnesses})`)
  L.push("")
  L.push("## SEEING")
  const frames = Object.entries(t.seeing.atmosphere.frames).filter(([, ids]) => ids.length).map(([f, ids]) => `${f}:${ids.length}`)
  L.push(`- Atmosphere (Framing): ${frames.join(" · ") || "none"}`)
  const lens = t.seeing.lens
  L.push(`- Lens (Views): ${lens.bySource.map((s) => `${s.doc}(${s.statements})`).join(" · ")}${lens.byYear.length ? ` · years ${lens.byYear.map((y) => y.year).join(",")}` : ""}`)
  const p = t.seeing.paradigm
  L.push(`- Paradigm (Patterns): ${p.groups.length} group(s), ${p.stray.length} stray source(s), echoFloor=${p.echoFloor}`)
  for (const g of p.groups.slice(0, maxRows)) L.push(`    · group [${g.docs.join(", ")}] — shared: ${g.label || "—"}`)
  if (p.stray.length) L.push(`    · stray (in no group): ${cap(p.stray, maxRows).join(", ")}`)
  if (p.recurs.length) L.push(`    · recurs: ${cap(p.recurs.map((e) => `${e.a.doc}:${e.a.s}≈${e.b.doc}:${e.b.s} (sim ${e.sim})`), maxRows).join(" · ")}`)
  if (p.breaks.length) {
    L.push(`    · breaks (referent-anchored contradictions): ${p.breaks.length}`)
    for (const b of p.breaks.slice(0, maxRows)) L.push(`        - ${b.kind} [${b.unit}]${b.anchors?.length ? ` (anchored on ${b.anchors.join(", ")})` : ""}: ${b.values.map((x) => `${x.raw} (${x.sources.join("/")})`).join(" vs ")}`)
  }
  if (p.nominated?.length) {
    L.push(`    · nominated (unit collisions with NO shared referent — reported, never called contradictions): ${p.nominated.length}`)
    for (const b of p.nominated.slice(0, maxRows)) L.push(`        - [${b.unit}]: ${b.values.map((x) => `${x.raw} (${x.sources.join("/")})`).join(" vs ")}`)
  }
  L.push("")
  if (swarm && !("gap" in swarm)) {
    const sig = (swarm.ants ?? []).filter((a) => (a.f ?? 0) > 0).map((a) => `${(a.ids ?? []).join("+")}=${a.f}`)
    L.push(`## Ants (live fold, ${(swarm.pointed ?? []).length} pointed)`)
    L.push(`- best: ${(swarm.best?.ids ?? []).join("+") || "—"} at ${swarm.best?.f ?? 0}`)
    L.push(`- signal: ${cap(sig, maxRows).join(" · ") || "none"}`)
    const r = swarm.residue
    if (r) {
      L.push(`- residue: ${r.line}`)
      if (r.untouchedTerrains?.length) L.push(`    · untouched terrains: ${r.untouchedTerrains.join(", ")}`)
      if (r.counted) L.push(`    · counted: touched=${r.counted.touched} untouched=${r.counted.untouched} questions=${r.counted.questions} unplaced=${r.counted.unplaced} personaGaps=${r.counted.personaGaps}`)
    }
  } else if (swarm && "gap" in swarm) {
    L.push(`## Ants (live fold)`)
    L.push(`- not run: ${swarm.gap} (the terrain above is still the full in-process read)`)
  }
  L.push("")
  L.push("## Residue / gaps")
  if (t.gaps.length) for (const g of t.gaps.slice(0, maxRows)) L.push(`- [${g.kind}] ${g.why}${g.url ? ` (${g.url})` : ""}`)
  else L.push("- none recorded (no unread/refused source was declared)")
  L.push("")
  L.push("Every statement id is `<source>:<n>`; every row carries the source and byte span it stands on. A tie, echo, group or break stands only because it beat every one of 199 same-size random draws.")
  return L.join("\n")
}

export async function discoverStructure({ material, query, ants = true, maxRows = 8 } = {}) {
  const n = Math.max(1, Math.min(50, maxRows))
  const { name, docs, from, skipped } = await resolveDocs(String(material ?? ""))
  if (!docs.length) return `# Discovered structure — ${name}\n\nNo readable text was found at the path (binary, empty, or oversize files only). Residue: nothing was read.`
  const t = terrainOf(readingShape(docs), { key: structureKey(docs) })
  let swarm = null
  if (ants !== false) swarm = (await foldReachable()) ? await runSwarm(name, docs, query ?? "swarm everything") : { gap: `fold proxy not reachable at ${PROXY}` }
  const out = render(name, from, t, swarm, n)
  return skipped.length ? `${out}\n\nSkipped (unreadable/binary): ${cap(skipped, 20).join(", ")}` : out
}
