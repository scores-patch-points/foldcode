// Physics-based tool calling. The model is never told to call a tool and never sees a tool definition: it
// writes what it already writes (prose, a code block holding the changed file, or a pair of blocks holding
// the lines that change and what replaces them), and the machine derives the operation from those bytes.
// The act (cut / admit / recompile) is computed from the shape of the bytes, never from a label the model
// wrote. Ported from the-fold's patch.js and code-scout.js (deriveOp, readOps, applyOps, deltaOps).
//
// Pure except `resolve` (reads the file the ask names) and `commit` (writes it). Every refusal is a typed
// reason; nothing is guessed. A refusal sends the turn down the normal tool path and records why.
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import * as Void from "./physics-void.js"
import * as Learn from "./physics-learn.js"
import * as Gather from "./physics-gather.js"

export { Gather }

// ── the derived act ─────────────────────────────────────────────────────────

export type Act = "SEG" | "INS" | "SYN"
export type Op = { op: Act; find: string; add?: string }
export type Gap = { kind: string; reason: string; count?: number }

/** Which of the three a delta IS, from its own shape: nothing added cuts, find-plus-more admits, else recompiles. */
export const deriveOp = (find: string, add: string): Act => {
  if (add === "") return "SEG"
  if (add !== find && add.includes(find)) return "INS"
  return "SYN"
}

/** The model's bytes as one typed op. INS carries only the admitted bytes; bytes on both sides of the anchor are a recompilation. */
export const readOp = (find: string, add: string): Op | null => {
  if (!find.length) return null
  const op = deriveOp(find, add)
  if (op === "SEG") return { op, find }
  if (op === "INS") {
    const at = add.indexOf(find)
    const before = add.slice(0, at)
    const after = add.slice(at + find.length)
    if (!before && after) return { op: "INS", find, add: after }
    return { op: "SYN", find, add }
  }
  return { op, find, add }
}

/** Overlapping occurrences: "aaa" occurs twice in "aaaa". A non-overlapping count calls that once and the replace then lands on the first. */
const occurrences = (hay: string, needle: string) => {
  if (!needle.length) return 0
  let n = 0
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) n++
  return n
}

/** Exact bytes, exactly once. Ambiguity and absence are gaps, never a best guess. */
export const applyOp = (code: string, o: Op): { ok: true; code: string } | { ok: false; gap: Gap } => {
  const count = occurrences(code, o.find)
  if (count === 0) return { ok: false, gap: { kind: "unlocated", reason: "the bytes to change are not in the file" } }
  if (count > 1) return { ok: false, gap: { kind: "ambiguous", count, reason: `the bytes to change appear ${count} times; widen them until they are unique` } }
  const replacement = o.op === "SEG" ? "" : o.op === "INS" ? o.find + (o.add ?? "") : (o.add ?? "")
  return { ok: true, code: code.replace(o.find, () => replacement) }
}

/** From the file before and the file the model wrote, the one {find, add} op: common prefix and suffix trimmed,
 * then grown symmetrically until `find` occurs exactly once in `before`. */
export const deltaOp = (before: string, after: string): { find: string; add: string; changed: [number, number] } | null => {
  if (before === after) return null
  let p = 0
  const max = Math.min(before.length, after.length)
  while (p < max && before[p] === after[p]) p++
  let s = 0
  const maxS = max - p
  while (s < maxS && before[before.length - 1 - s] === after[after.length - 1 - s]) s++
  let left = p
  let right = before.length - s
  const changed: [number, number] = [p, right]
  let find = before.slice(left, right)
  while (occurrences(before, find) !== 1 && (left > 0 || right < before.length)) {
    left = Math.max(0, left - 8)
    right = Math.min(before.length, right + 8)
    find = before.slice(left, right)
  }
  if (occurrences(before, find) !== 1) return null
  return { find, add: after.slice(left, after.length - (before.length - right)), changed }
}

// ── reading the model's native medium ───────────────────────────────────────

export const fences = (text: string) => [...text.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)].map((m) => m[1])

const endsNl = (s: string) => (s.endsWith("\n") ? s : s + "\n")

/** Whole file: the longest fenced block (or the bare reply). The trailing newline of the original is kept, never invented. */
export const wholeFile = (reply: string, before: string) => {
  const blocks = fences(reply)
  const body = blocks.length ? blocks.reduce((a, b) => (b.length > a.length ? b : a)) : reply
  if (!body.trim()) return undefined
  return before.endsWith("\n") ? endsNl(body) : body.replace(/\n$/, "")
}

/** The two-block form: the lines that change, then the lines that replace them. Exactly two blocks, or it is not this form. */
export const findAdd = (reply: string) => {
  const blocks = fences(reply)
  if (blocks.length !== 2) return undefined
  const trim = (s: string) => s.replace(/\n$/, "")
  return { find: trim(blocks[0]), add: trim(blocks[1]) }
}

// ── the resolver: does a derived path serve this turn ───────────────────────

export type Class = "read" | "edit" | "shell" | "search" | "other"

const EDIT = /\b(change|replace|rename|fix|add|insert|remove|delete|update|set|make|edit|modify|rewrite|append|refactor|correct|swap|convert|bump)\b/i
const READ = /\b(read|show|what|which|explain|summari[sz]e|describe|look at|open|print|list|tell me|how does|why)\b/i
const SHELL = /\b(run|execute|install|build|test|compile|start|npm|bun|pip|git|make|curl|brew|ls|cd)\b/i

/** An ask that names the codebase's own things (the code, a repo, a file, a function, a test, a config) or is shaped like code (a backtick, a call, a
 *  camelCase or snake_case identifier): what it wants is in the workspace, and the web has nothing to say about it. */
const WORKSPACE = /\b(?:code|codebase|repo|repos|repository|project|projects|files?|folders?|director(?:y|ies)|functions?|class(?:es)?|methods?|modules?|tests?|specs?|bugs?|errors?|commits?|branch(?:es)?|workspace|src|configs?|configuration|imports?|variables?|symbols?|lint|builds?|compile|usages?|references|dependenc(?:y|ies)|packages?|stack ?trace|logs?)\b/i
const CODEY = /`|\(\)|\b[a-z]+[A-Z][A-Za-z]*\b|\b[A-Za-z]+_[A-Za-z_]+\b|::|=>/
export const workspaceish = (ask: string) => WORKSPACE.test(ask) || CODEY.test(ask)

/** A long piece asked for by its kind and a writing verb ("write me an essay about ..."): written section by section from the pages (opencode-essay.mjs). */
export const essayAsk = (ask: string) => /\b(?:essay|article|report|paper|white ?paper|write-?up|blog post|analysis|long[- ]?form)\b/i.test(ask) && /\b(?:write|draft|compose|produce|prepare|create|make)\b/i.test(ask)

export const classify = (ask: string): Class => {
  if (EDIT.test(ask)) return "edit"
  if (/\b(run|execute|install|npm|bun|pip|git|curl|brew)\b/i.test(ask)) return "shell"
  // a search names no file and none of the workspace's own things: "find the bug in calc.py" is a read of calc.py, "search the codebase for TODO"
  // is the workspace's to search, "find me a corpus for OCR" is a gather. When in doubt it is NOT a search: the tool path can still search the web.
  if (Gather.SEARCH.test(ask) && named(ask).length === 0 && Gather.terms(ask).length >= 2 && !workspaceish(ask)) return "search"
  if (READ.test(ask)) return "read"
  if (SHELL.test(ask)) return "shell"
  return "other"
}

/** Path-shaped words in the ask, in order. */
export const named = (ask: string) => [...ask.matchAll(/(?:^|[\s"'`(])((?:\.{0,2}\/)?[\w@.\-/]*[\w-]\.[A-Za-z0-9]{1,8})(?=\.?(?:$|[\s"'`),:;?!]))/g)].map((m) => m[1])

/** Distinct lines over lines: a highly repetitive source makes "which line" uncertain. */
export const repetitive = (code: string) => {
  const lines = code.split("\n").filter((l) => l.trim())
  return lines.length >= 8 && new Set(lines).size / lines.length < 0.5
}

export type Plan =
  | { kind: "read"; file: string; abs: string; content: string }
  | { kind: "edit"; file: string; abs: string; before: string; form: "file" | "pair" }
  | { kind: "gather"; ask: string; queries: string[] }
  | { kind: "decline"; reason: string }

export const WHOLE_MAX = Number(process.env.FOLD_PHYSICS_WHOLE_MAX ?? 3500)
export const FILE_MAX = Number(process.env.FOLD_PHYSICS_FILE_MAX ?? 14000)

const inside = (root: string, abs: string) => {
  const rel = path.relative(fs.realpathSync(root), abs)
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)
}

/** Decide, from the ask alone, whether a derived path serves the turn. Reads the one file the ask names. */
export const resolve = (ask: string, workspace: string): Plan => {
  const cls = classify(ask)
  if (cls === "shell") return { kind: "decline", reason: "shell-class: the machine does not run a command the model merely wrote" }
  if (cls === "other") return { kind: "decline", reason: "the ask is not read/edit-class" }
  // the queries are the ask's own words; the gather itself (search, fetch) happens where there is IO
  if (cls === "search") return { kind: "gather", ask, queries: Gather.queries(ask) }
  const hits: { file: string; abs: string }[] = []
  for (const w of named(ask)) {
    const abs = path.resolve(workspace, w)
    try {
      const real = fs.realpathSync(abs)
      if (fs.statSync(real).isFile() && inside(workspace, real) && !hits.some((h) => h.abs === real)) hits.push({ file: w, abs: real })
    } catch {}
  }
  if (hits.length === 0) return { kind: "decline", reason: "the ask names no file that exists in the workspace" }
  if (hits.length > 1) return { kind: "decline", reason: `the ask names ${hits.length} files; one derived edit serves one file` }
  const { file, abs } = hits[0]
  let content: string
  try {
    content = fs.readFileSync(abs, "utf8")
  } catch (e) {
    return { kind: "decline", reason: `unreadable: ${(e as Error).message}` }
  }
  if (content.includes("\0")) return { kind: "decline", reason: "binary file" }
  if (content.length > FILE_MAX) return { kind: "decline", reason: `file is ${content.length} chars, over the ${FILE_MAX} the window carries whole` }
  if (cls === "read") return { kind: "read", file, abs, content }
  return { kind: "edit", file, abs, before: content, form: content.length <= WHOLE_MAX ? "file" : "pair" }
}

// ── the model-facing text: a person pasting a file and asking ────────────────

const lang = (file: string) => path.extname(file).slice(1)

export const present = (plan: Exclude<Plan, { kind: "decline" | "gather" }>, ask: string) => {
  const block = (plan.kind === "read" ? plan.content : plan.before).replace(/\n$/, "")
  const shown = `${plan.file}:\n\`\`\`${lang(plan.file)}\n${block}\n\`\`\``
  if (plan.kind === "read") return `${ask}\n\n${shown}`
  return plan.form === "file"
    ? `${ask}\n\n${shown}\n\nGive me the whole updated file in one code block.`
    : `${ask}\n\n${shown}\n\nGive me the lines that change in one code block, then the lines that replace them in a second code block.`
}

// ── the derived operation ───────────────────────────────────────────────────

export type Derived =
  | { ok: true; op: Op; after: string; touched: number; checked: number }
  | { ok: false; gap: Gap }

const refuse = (kind: string, reason: string, count?: number): Derived => ({ ok: false, gap: { kind, reason, ...(count ? { count } : {}) } })

const STOP = new Set("the a an in of to and or for with that this it is be as on at by from into so instead function method class file line lines code fix change update make add set replace rename delete remove please then also new old".split(" "))
const words = (t: string) => t.match(/[A-Za-z_][\w]*|\d+/g) ?? []

/** Fraction of the old file's words the new file still holds (multiset). An unrelated rewrite scores near zero. */
export const retained = (before: string, after: string) => {
  const have = new Map<string, number>()
  for (const w of words(after)) have.set(w, (have.get(w) ?? 0) + 1)
  const old = words(before)
  if (!old.length) return 1
  let kept = 0
  for (const w of old) {
    const n = have.get(w) ?? 0
    if (n > 0) {
      kept++
      have.set(w, n - 1)
    }
  }
  return kept / old.length
}

/** Words the change introduces that neither the old file nor the ask holds. A model that "fixes" a line by inventing
 * a class, a comment and an import has said much the ask never asked for; a real fix introduces a number or a name. */
export const novel = (before: string, after: string, ask: string) => {
  const known = new Set([...words(before), ...words(ask)].map((w) => w.toLowerCase()))
  return [...new Set(words(after).map((w) => w.toLowerCase()).filter((w) => !known.has(w)))]
}

/** The ask's own identifiers that the file holds must sit near the change: an edit of f7 is not an edit of f77. */
export const near = (before: string, changed: [number, number], ask: string, radius = 1) => {
  const held = [...new Set(words(ask))].filter((w) => w.length >= 2 && !STOP.has(w.toLowerCase()) && new RegExp(`(?<![\\w])${w}(?![\\w])`).test(before))
  const lines = before.split("\n")
  // a word on many lines (return, self) names nothing in particular; only the ask's discriminating words locate the change
  const sharp = held.filter((w) => lines.filter((l) => new RegExp(`(?<![\\w])${w}(?![\\w])`).test(l)).length <= 3)
  if (!sharp.length) return true
  const at = (i: number) => before.slice(0, i).split("\n").length - 1
  const lo = Math.max(0, at(changed[0]) - radius)
  const hi = Math.min(lines.length - 1, at(changed[1]) + radius)
  const zone = lines.slice(lo, hi + 1).join("\n")
  return sharp.some((w) => new RegExp(`(?<![\\w])${w}(?![\\w])`).test(zone))
}

/** A language gate for the formats whose parser is at hand: a file that does not parse is never written. */
export const broken = (file: string, code: string): string | undefined => {
  const ext = path.extname(file).toLowerCase()
  try {
    if (ext === ".json") JSON.parse(code)
    else if (ext === ".py") {
      const r = spawnSync("python3", ["-c", "import sys,ast;ast.parse(sys.stdin.read())"], { input: code, timeout: 5000 })
      if (r.status !== 0 && r.error === undefined) return `the file does not parse as Python: ${String(r.stderr).trim().split("\n").at(-1)}`
    }
  } catch (e) {
    return `the file does not parse: ${(e as Error).message}`
  }
  return undefined
}

/** The checks any derived file passes before it is written, whichever form the model answered in. */
const judge = (before: string, after: string, ask: string, op: Op, file = ""): Derived => {
  const wants = /\b(remove|delete|drop|rewrite|replace everything)\b/i.test(ask)
  const broad = /\b(all|every|each|everywhere|throughout|both|rename|renames)\b/i.test(ask)
  const delta = deltaOp(before, after)
  if (!delta) return refuse("unlocated", "no unique anchor derives from the two files")
  const keep = retained(before, after)
  if (keep < (wants ? 0.3 : 0.6)) return refuse("unrelated", `the new file keeps ${Math.round(keep * 100)}% of the old one's words; that is not this file edited`)
  if (!wants && !broad) {
    // a one-change edit leaves most lines as they were
    const old = before.split("\n").map((l) => l.trim()).filter(Boolean)
    const now = new Map<string, number>()
    for (const l of after.split("\n")) now.set(l.trim(), (now.get(l.trim()) ?? 0) + 1)
    const kept = old.filter((l) => {
      const n = now.get(l) ?? 0
      if (n > 0) now.set(l, n - 1)
      return n > 0
    }).length
    if (old.length >= 3 && kept / old.length < 0.5) return refuse("restructured", `only ${kept} of ${old.length} lines survive as they were; that is a restructuring, not one change`)
  }
  const removing =/\b(delete|remove|drop)\b/i.test(ask) && !/\b(add|insert|replace|change|rename|write|create|make|fix|rewrite|update)\b/i.test(ask)
  if (removing) {
    // a removal only removes: every line that remains was already there
    const had = new Map<string, number>()
    for (const l of before.split("\n")) had.set(l.trim(), (had.get(l.trim()) ?? 0) + 1)
    const extra = after.split("\n").filter((l) => {
      const left = had.get(l.trim()) ?? 0
      if (!l.trim() || left === 0) return !!l.trim()
      had.set(l.trim(), left - 1)
      return false
    })
    if (extra.length) return refuse("invented", `the ask removes, and the file gained ${extra.length} line(s) that were not there (${extra[0].trim().slice(0, 40)})`, extra.length)
  }
  if (!/\b(comment|comments|document|docstring|explain|annotate)\b/i.test(ask)) {
    const seen = new Set(before.split("\n").map((l) => l.trim()))
    const added = after.split("\n").filter((l) => /(^|\s)(#|\/\/|\/\*)/.test(l) && !seen.has(l.trim()))
    if (added.length) return refuse("comment", `the change added a comment line the ask did not ask for (${added[0].trim().slice(0, 40)})`, added.length)
  }
  const shrink = before.length - after.length
  if (!wants && before.length >= 200 && shrink > before.length * 0.25) return refuse("loss", `the file shrinks ${shrink} of ${before.length} chars and the ask did not ask for removal`)
  const span = delta.changed[1] - delta.changed[0]
  if (!wants && !broad && before.length >= 40 && span > before.length * 0.6) return refuse("rewrite", "the change spans most of the file; that is a rewrite, not an edit")
  // a singular ask is one change: edits in several separate places (an added import, a header comment beside the fix) are refused
  const places = hunkCount(before, after)
  if (!broad && !wants && places > 1) return refuse("scatter", `the file differs in ${places} separate places and the ask names one change`, places)
  const fresh = novel(before, after, ask)
  if (!wants && !broad && fresh.length > 2) return refuse("novel", `the change introduces ${fresh.length} words neither the file nor the ask holds (${fresh.slice(0, 4).join(", ")})`, fresh.length)
  const bad = broken(file, after)
  if (bad) return refuse("syntax", bad)
  // the void the ask names must be filled in the file as written, or the answer is a bad one
  const checks = Void.derive(ask)
  const open = Void.open(checks, before, after)
  if (open.length) return refuse("void", `the ask is not satisfied: ${open.join("; ")}`, open.length)
  if (!broad && !near(before, delta.changed, ask)) return refuse("locus", "the change is not near anything the ask names")
  if (repetitive(before)) {
    // in repetitive source "which line" is the whole question: demand one contiguous hunk, and refuse when the
    // changed span's bytes also occur elsewhere unchanged
    const core = before.slice(delta.changed[0], delta.changed[1])
    if (places !== 1) return refuse("ambiguous", `repetitive source and the file differs in ${places} places; the locus of each is not pinned`, places)
    if (core.trim() && occurrences(before, core) > 1) return refuse("ambiguous", "repetitive source: the changed lines also occur elsewhere, so which one was meant is not pinned", occurrences(before, core))
  }
  return { ok: true, op, after, touched: 1, checked: checks.length }
}

/** From the file as read and the model's reply, derive the one op and prove it: applying it to `before` must give
 * exactly the file the model wrote (whole form), and its bytes must be located exactly once (pair form). */
export const derive = (plan: Extract<Plan, { kind: "edit" }>, reply: string, ask = ""): Derived => {
  const { before } = plan
  if (plan.form === "pair") {
    const pair = findAdd(reply)
    if (!pair) return refuse("unreadable", "the reply is not two code blocks (what changes, what replaces it)")
    const op = readOp(pair.find, pair.add)
    if (!op) return refuse("malformed", "the lines that change are empty")
    const r = applyOp(before, op)
    if (!r.ok) return { ok: false, gap: r.gap }
    if (r.code === before) return refuse("no-change", "the replacement equals what was there")
    return judge(before, r.code, ask, op, plan.file)
  }
  const after = wholeFile(reply, before)
  if (after === undefined) return refuse("unreadable", "the reply holds no file")
  if (after === before) return refuse("no-change", "the file the model wrote equals the file as it was")
  const delta = deltaOp(before, after)
  if (!delta) return refuse("unlocated", "no unique anchor derives from the two files")
  const op = readOp(delta.find, delta.add)
  if (!op) return refuse("malformed", "the derived span is empty")
  const r = applyOp(before, op)
  if (!r.ok) return { ok: false, gap: r.gap }
  if (r.code !== after) return refuse("roundtrip", "the derived op does not reproduce the file the model wrote")
  return judge(before, after, ask, op, plan.file)
}

/** Number of separated differing regions, by lines. */
export const hunkCount = (a: string, b: string) => {
  const x = a.split("\n")
  const y = b.split("\n")
  let p = 0
  while (p < x.length && p < y.length && x[p] === y[p]) p++
  let s = 0
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++
  const mx = x.slice(p, x.length - s)
  const my = y.slice(p, y.length - s)
  // inside the trimmed span, count blocks of lines that differ from a common-line walk
  let regions = 0
  let i = 0
  let j = 0
  let diff = false
  while (i < mx.length || j < my.length) {
    if (i < mx.length && j < my.length && mx[i] === my[j]) {
      if (diff) regions++
      diff = false
      i++
      j++
    } else {
      diff = true
      const nj = my.indexOf(mx[i], j)
      const ni = mx.indexOf(my[j], i)
      if (i < mx.length && nj !== -1 && (ni === -1 || nj - j <= ni - i)) j = nj
      else if (j < my.length && ni !== -1) i = ni
      else {
        i++
        j++
      }
    }
  }
  if (diff) regions++
  return Math.max(regions, mx.length || my.length ? 1 : 0)
}

/** Write the derived file. Atomic (temp then rename); refuses if the file changed on disk since it was read. */
export const commit = (plan: Extract<Plan, { kind: "edit" }>, after: string): { ok: true } | { ok: false; gap: Gap } => {
  try {
    if (fs.readFileSync(plan.abs, "utf8") !== plan.before) return { ok: false, gap: { kind: "stale", reason: "the file changed on disk after it was read" } }
    const tmp = `${plan.abs}.physics-${process.pid}`
    fs.writeFileSync(tmp, after, { mode: fs.statSync(plan.abs).mode })
    fs.renameSync(tmp, plan.abs)
    return { ok: true }
  } catch (e) {
    return { ok: false, gap: { kind: "io", reason: (e as Error).message } }
  }
}

/** What the person sees on a derived apply or refusal (a person notice, never sent to the model). */
export const notice = (file: string, d: Derived) =>
  d.ok
    ? `fold physics · ${file}: ${d.op.op} derived from the bytes and applied (${d.op.find.length}→${d.op.op === "SEG" ? 0 : (d.op.add ?? "").length} chars)`
    : `fold physics · ${file}: refused (${d.gap.kind}) ${d.gap.reason}; nothing was written`

/** A file produced by something other than the local model (a recipe, the frontier) goes through the same guards. */
export const accept = (plan: Extract<Plan, { kind: "edit" }>, after: string, ask: string, needChecks = false): Derived => {
  const { before } = plan
  if (after === before) return refuse("no-change", "the file equals the file as it was")
  const delta = deltaOp(before, after)
  const op = delta && readOp(delta.find, delta.add)
  if (!op) return refuse("unlocated", "no unique anchor derives from the two files")
  const r = applyOp(before, op)
  if (!r.ok) return { ok: false, gap: r.gap }
  if (r.code !== after) return refuse("roundtrip", "the derived op does not reproduce the file")
  const d = judge(before, after, ask, op, plan.file)
  if (d.ok && needChecks && d.checked === 0) return refuse("unchecked", "the ask names nothing the machine can test, so a taught edit is not trusted")
  return d
}

/** Answer the ask from what the machine has been taught, with no model. The first recipe whose edit passes every guard
 * and fills the void wins. */
export const taught = (plan: Extract<Plan, { kind: "edit" }>, ask: string, recipes: Learn.Recipe[]) => {
  for (const recipe of recipes) {
    const after = Learn.apply(recipe, ask, plan.before)
    if (after === undefined) continue
    const d = accept(plan, after, ask, true)
    if (d.ok) return { derived: d, recipe }
  }
  return undefined
}

/** Keep the how of a verified edit made by something other than the machine. */
export const teach = (plan: Extract<Plan, { kind: "edit" }>, ask: string, after: string, source: string) =>
  Learn.learn({ ask, file: plan.file, before: plan.before, after, source })

const fileBlock = (plan: Extract<Plan, { kind: "edit" }>, text: string) => `${plan.file}:\n\`\`\`${lang(plan.file)}\n${text.replace(/\n$/, "")}\n\`\`\``

/** The same ask again after an answer failed, as a person would write it: what was tried, why it does not stand. */
export const restate = (plan: Extract<Plan, { kind: "edit" }>, ask: string, reply: string, reason: string, form: "file" | "pair") => {
  const tried = (fences(reply)[0] ?? reply).trim().slice(0, 1200)
  const want =
    form === "file"
      ? "Give me the whole updated file in one code block."
      : "Give me the lines that change in one code block, then the lines that replace them in a second code block."
  return `${ask}\n\n${fileBlock(plan, plan.before)}\n\nI tried this:\n\`\`\`\n${tried}\n\`\`\`\nIt does not work: ${reason}.\n\n${want}`
}

/** When the machine made the edit itself the model is only asked to say what happened, over the file as it now stands. */
export const presentDone = (plan: Extract<Plan, { kind: "edit" }>, ask: string, after: string) =>
  `${ask}\n\nThe file now reads:\n${fileBlock(plan, after)}\n\nSay in one sentence what changed.`
