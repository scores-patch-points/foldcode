// Teaching the mechanical system. When an edit that filled its void was made by something other than the machine (the
// frontier model, after the local one could not), the machine keeps the HOW as a recipe: the ask with its operative
// tokens turned into slots, and the edit as a template over the same slots. The next ask of that shape is answered
// by the machine alone, no model: the recipe is instantiated on the new file, and the result still has to pass every
// guard and fill the void the new ask names. A recipe that cannot do both is not used.
import fs from "node:fs"
import path from "node:path"

export type Recipe = {
  skeleton: string
  kind: "line" | "block"
  /** line: the line starts with `prefix`, ends with `suffix`; what lies between is replaced by `fill`. */
  prefix?: string
  suffix?: string
  fill?: string
  /** block: the exact old and new text. */
  find?: string
  add?: string
  source: string
  at: string
  wins: number
}

const TOKEN = /[A-Za-z_][\w]*|\d+(?:\.\d+)?/g
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const wordRe = (w: string, flags = "g") => new RegExp(`(?<![\\w])${esc(w)}(?![\\w])`, flags)

const templated = (text: string, slots: string[]) => slots.reduce((t, s, k) => t.replace(wordRe(s), `{${k}}`), text)
const filled = (text: string, values: string[]) => text.replace(/\{(\d+)\}/g, (_, k) => values[Number(k)] ?? "")

/** One recipe from one verified edit, or undefined when the edit is not a single local hunk. */
export const learn = (input: { ask: string; file: string; before: string; after: string; source: string }): Recipe | undefined => {
  const x = input.before.split("\n")
  const y = input.after.split("\n")
  let p = 0
  while (p < x.length && p < y.length && x[p] === y[p]) p++
  let s = 0
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++
  const oldLines = x.slice(p, x.length - s)
  const newLines = y.slice(p, y.length - s)
  if (!oldLines.length && !newLines.length) return undefined
  const changed = [...oldLines, ...newLines].join("\n")
  const ask = input.ask.trim().replace(/[.!?]+$/, "")
  // operative tokens: those of the ask that the change itself carries
  const slots = [...new Set(ask.match(TOKEN) ?? [])].filter((t) => wordRe(t, "").test(changed))
  const base = path.basename(input.file)
  const skeleton = templated(ask, slots).split(base).join("{file}").split(input.file).join("{file}")
  const at = new Date().toISOString()
  if (oldLines.length === 1 && newLines.length === 1) {
    const a = oldLines[0]
    const b = newLines[0]
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    let j = 0
    while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++
    const prefix = templated(a.slice(0, i), slots)
    const suffix = templated(a.slice(a.length - j), slots)
    const fill = templated(b.slice(i, b.length - j), slots)
    if (!/\{\d+\}/.test(skeleton + prefix + fill)) return undefined
    return { skeleton, kind: "line", prefix, suffix, fill, source: input.source, at, wins: 0 }
  }
  if (oldLines.length + newLines.length > 40) return undefined
  return { skeleton, kind: "block", find: templated(oldLines.join("\n"), slots), add: templated(newLines.join("\n"), slots), source: input.source, at, wins: 0 }
}

const asker = (r: Recipe) => new RegExp("^" + esc(r.skeleton).replace(/\\\{(\d+|file)\\\}/g, "{$1}").replace(/\{file\}/g, "([\\w./\\-]+)").replace(/\{\d+\}/g, "([\\w.\\-]+)") + "$", "i")

/** Instantiate a recipe on a new ask and file. Undefined unless the ask matches its shape and the template lands exactly once. */
export const apply = (r: Recipe, ask: string, before: string): string | undefined => {
  const m = asker(r).exec(ask.trim().replace(/[.!?]+$/, ""))
  if (!m) return undefined
  const order = [...r.skeleton.matchAll(/\{(\d+|file)\}/g)].map((t) => t[1])
  const values: string[] = []
  for (const [n, name] of order.entries()) {
    if (name === "file") continue
    const k = Number(name)
    if (values[k] !== undefined && values[k] !== m[n + 1]) return undefined
    values[k] = m[n + 1]
  }
  if (r.kind === "block") {
    const find = filled(r.find ?? "", values)
    if (!find || before.split(find).length !== 2) return undefined
    return before.replace(find, () => filled(r.add ?? "", values))
  }
  const prefix = filled(r.prefix ?? "", values)
  const suffix = filled(r.suffix ?? "", values)
  const lines = before.split("\n")
  const hits = lines.flatMap((l, i) => (l.startsWith(prefix) && l.endsWith(suffix) && l.length >= prefix.length + suffix.length ? [i] : []))
  if (hits.length !== 1) return undefined
  lines[hits[0]] = prefix + filled(r.fill ?? "", values) + suffix
  return lines.join("\n")
}

export const load = (file: string): Recipe[] => {
  try {
    return fs.readFileSync(file, "utf8").split("\n").flatMap((l) => (l.trim() ? [JSON.parse(l) as Recipe] : []))
  } catch {
    return []
  }
}

/** Keep a recipe once (same shape, same edit); a repeat only counts as a win. */
export const keep = (file: string, r: Recipe) => {
  const all = load(file)
  const same = all.find((o) => o.skeleton === r.skeleton && o.kind === r.kind && o.prefix === r.prefix && o.fill === r.fill && o.find === r.find && o.add === r.add)
  if (same) same.wins++
  else all.push(r)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, all.map((o) => JSON.stringify(o)).join("\n") + "\n")
  return !same
}

export const won = (file: string, r: Recipe) => {
  const all = load(file)
  const same = all.find((o) => o.skeleton === r.skeleton && o.kind === r.kind && o.prefix === r.prefix && o.fill === r.fill && o.find === r.find && o.add === r.add)
  if (!same) return
  same.wins++
  fs.writeFileSync(file, all.map((o) => JSON.stringify(o)).join("\n") + "\n")
}
