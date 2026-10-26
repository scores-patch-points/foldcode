// physics-mech — answer a lookup the machine can settle by reading, with no model reasoning at all. "What is DEFAULT_TIMEOUT_MS in
// packages/core/src/provider.ts?" is a definition in a file: the machine finds it and evaluates the literal. "List the exported
// functions of x.ts" is the file's own `export` lines. Only an exact, unambiguous hit is an answer; everything else is a typed gap and the
// turn takes the normal path. A hit carries its address (`file#Lnn`), so the finding is checkable and the model is only asked to state it.
//
// Pure except for reading the one file the ask names, which must sit inside the workspace.
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** `fact` is the finding on one line (what a ledger mark carries); `sha` is the sha256 of the file's bytes it was read from, the finding's
 *  witness; `value` (a constant) or `names` (exports) is what an answer must state to be faithful to it (see `verify`). */
export type Answer = { ok: true; kind: "const" | "exports"; text: string; at: string; fact: string; sha: string; value?: string; names?: string[] }
export type Gap = { ok: false; gap: string; detail?: string }

const FILE = /((?:[\w@.\-]+\/)+[\w.\-]+\.[A-Za-z0-9]{1,5})/
const SYMBOL = /\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g
// "in the same file", "in that file", "in it": the file is the one the conversation last named
const SAME = /\b(same|that|this|those|the) file\b|\bin it\b/i
const EXPORTS = /\bexport(?:ed|s)?\b/i
const LISTISH = /\b(list|name|names|which|what are)\b/i
// a question mark of any script: Latin/fullwidth ?, Arabic ؟, Armenian ՞, Ethiopic ፧, Greek ; (U+037E), inverted ¿ opening one
const QUESTION_MARK = /[?？؟՞፧;¿]/u

/** A numeric literal or a product of them (`300_000`, `60 * 1000`, `1024 * 1024`), else undefined. Never evaluates anything else. */
export const literal = (rhs: string): string | undefined => {
  const t = rhs.replace(/_/g, "").replace(/\s+/g, "")
  if (!/^\d+(?:\.\d+)?(?:\*\d+(?:\.\d+)?)*$/.test(t)) return undefined
  const v = t.split("*").reduce((n, x) => n * Number(x), 1)
  return Number.isFinite(v) ? String(v) : undefined
}

const named = (ask: string) => ask.match(FILE)?.[1]

/** The file the ask names, or, for "the same file", the one the earlier asks last named (newest first). */
export const fileOf = (ask: string, prior: readonly string[] = []): string | undefined => {
  const own = named(ask)
  if (own) return own
  if (!SAME.test(ask)) return undefined
  for (let i = prior.length - 1; i >= 0; i--) {
    const f = named(prior[i])
    if (f) return f
  }
  return undefined
}

const inside = (root: string, rel: string) => {
  const abs = path.resolve(root, rel)
  return abs === root || abs.startsWith(root + path.sep) ? abs : undefined
}

const definitions = (lines: string[], name: string) =>
  lines.flatMap((text, i) => {
    const m = text.match(new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${name}\\b[^=]*=\\s*(.+?)\\s*(?:as const)?\\s*(?:\\/\\/.*)?$`))
    return m ? [{ line: i + 1, rhs: m[1] }] : []
  })

const constantAsk = (ask: string, lines: string[], rel: string, sha: string): Answer | Gap => {
  const symbols = [...ask.matchAll(SYMBOL)].map((m) => m[1])
  if (symbols.length) {
    const name = symbols[symbols.length - 1]
    const defs = definitions(lines, name)
    if (defs.length === 0) return { ok: false, gap: "no-definition", detail: name }
    if (defs.length > 1) return { ok: false, gap: "ambiguous", detail: `${name} is defined ${defs.length} times` }
    const v = literal(defs[0].rhs)
    if (!v) return { ok: false, gap: "not-a-literal", detail: `${name} = ${defs[0].rhs}` }
    return { ok: true, kind: "const", text: `${name} = ${v}`, at: `${rel}#L${defs[0].line}`, fact: `${name} = ${v}`, sha, value: v }
  }
  // no symbol named ("the default timeout in shell.ts"): the file's only constant whose name carries the asked word
  const hint = /timeout/i.test(ask) ? /TIMEOUT/ : /\b(max|limit|bytes)\b/i.test(ask) ? /MAX|LIMIT|BYTES/ : undefined
  if (!hint) return { ok: false, gap: "no-symbol" }
  const found = lines.flatMap((text, i) => {
    const m = text.match(/^\s*(?:export\s+)?(?:const|let)\s+([A-Z][A-Z0-9_]+)\s*=\s*(.+?)\s*(?:as const)?\s*(?:\/\/.*)?$/)
    return m && hint.test(m[1]) ? [{ line: i + 1, name: m[1], rhs: m[2] }] : []
  })
  if (found.length !== 1) return { ok: false, gap: found.length ? "several-candidates" : "no-candidate", detail: found.map((f) => f.name).join(", ") }
  const v = literal(found[0].rhs)
  return v ? { ok: true, kind: "const", text: `${found[0].name} = ${v}`, at: `${rel}#L${found[0].line}`, fact: `${found[0].name} = ${v}`, sha, value: v } : { ok: false, gap: "not-a-literal", detail: `${found[0].name} = ${found[0].rhs}` }
}

/** A `const` whose value is a function: an arrow (`(a) =>`, `<T>(a) =>`, `x =>`, a parameter list that continues on the next line),
 *  a function expression, or an Effect function (`Effect.fn(...)`). Read off the value's first line, never evaluated. */
export const isFunctionValue = (rhs: string): boolean => {
  const v = rhs.trim()
  if (/^(?:async\s+)?function\b/.test(v) || /^Effect\.fn(?:Untraced)?\b/.test(v)) return true
  if (/^(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(v)) return true
  if (/^(?:async\s+)?</.test(v)) return true
  if (/^(?:async\s+)?\(/.test(v)) return v.includes("=>") || /[(,]$/.test(v) || !/^\(.*\)\s*[-+*/%]/.test(v)
  return false
}

type Item = { name: string; what: string; line: number }
const exportsOf = (lines: string[]): Item[] =>
  lines.flatMap((text, i): Item[] => {
    let m = text.match(/^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(async\s+function\*?|function\*?|class|const|let|var|type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/)
    if (m && /^(?:const|let|var)$/.test(m[1])) {
      const rhs = text.slice(text.indexOf("=", m.index! + m[0].length) + 1)
      return [{ name: m[2], what: text.includes("=") && isFunctionValue(rhs) ? "function" : m[1], line: i + 1 }]
    }
    if (m) return [{ name: m[2], what: m[1].startsWith("async") ? "function" : m[1].replace("*", ""), line: i + 1 }]
    m = text.match(/^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/)
    if (m) return [{ name: m[1], what: "namespace", line: i + 1 }]
    m = text.match(/^export\s*\{([^}]*)\}/)
    return m ? m[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean).map((name) => ({ name, what: "re-export", line: i + 1 })) : []
  })

const exportsAsk = (ask: string, lines: string[], rel: string, sha: string): Answer | Gap => {
  const all = exportsOf(lines)
  if (all.length === 0) return { ok: false, gap: "no-exports" }
  const wantFn = /\bfunctions?\b/i.test(ask), wantCls = /\bclass(?:es)?\b/i.test(ask)
  const keep = wantFn || wantCls ? all.filter((e) => (wantFn && e.what === "function") || (wantCls && e.what === "class")) : all
  const label = wantFn && wantCls ? "exported functions and classes" : wantFn ? "exported functions" : wantCls ? "exported classes" : "exports"
  const body = keep.map((e) => `- ${e.name}${wantFn || wantCls ? "" : ` (${e.what})`} · L${e.line}`).join("\n")
  // the list is complete for what was asked; a note about the exports left out reads as "partial" and sends the reader off to ask for the file
  return { ok: true, kind: "exports", text: `${rel} — ${label}, all of them:\n${body || "(none)"}`, at: rel, fact: `${rel} ${label}: ${keep.map((e) => e.name).join(", ") || "(none)"}`, sha, names: keep.map((e) => e.name) }
}

/** The workspace and its parents up to the repository root (the first directory holding `.git`): a session opened in a subdirectory still
 *  names files from the project root. Nearest first; never above the repository root, and never beyond the workspace when there is no repo. */
export const roots = (root: string): string[] => {
  const out: string[] = []
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    out.push(dir)
    if (fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) break
  }
  return fs.existsSync(path.join(out[out.length - 1], ".git")) ? out : out.slice(0, 1)
}

/** The machine's answer to a lookup ask, or the typed reason it is not one. `prior` is the earlier asks, oldest first. */
export const resolve = (ask: string, root: string, prior: readonly string[] = []): Answer | Gap => {
  const rel = fileOf(ask, prior)
  if (!rel) return { ok: false, gap: "no-file" }
  const candidates = roots(root).flatMap((r) => {
    const a = inside(r, rel)
    return a ? [a] : []
  })
  if (!candidates.length) return { ok: false, gap: "outside-workspace" }
  const abs = candidates.find((a) => fs.existsSync(a)) ?? candidates[0]
  let text: string
  try {
    if (!fs.statSync(abs).isFile()) return { ok: false, gap: "not-a-file" }
    text = fs.readFileSync(abs, "utf8")
  } catch {
    return { ok: false, gap: "unreadable", detail: rel }
  }
  if (text.includes("\0")) return { ok: false, gap: "binary" }
  const lines = text.split("\n")
  const sha = crypto.createHash("sha256").update(text).digest("hex")
  if (EXPORTS.test(ask) && LISTISH.test(ask)) return exportsAsk(ask, lines, rel, sha)
  // A lookup is a QUESTION. The English question words are English's own reading; any language's question mark is the
  // notation every script shares (? ？ ؟ ՞ ፧ ;). A named symbol alone is not a question: "Change X to 3" / "cambia X a 3" /
  // "X を 3 に変更して" name a symbol and ask for a change, and serving them as a read-only lookup (tools withheld) made the
  // edit impossible (the Isthmus, khora native/docs/THE-ISTHMUS.md: the English codec is never applied to another language,
  // and a symbol is not a reading of the ask). Such an ask is a typed gap and takes the normal path, with its tools.
  if (/\bwhat('s| is| was)\b|\bvalue\b/i.test(ask) || QUESTION_MARK.test(ask)) return constantAsk(ask, lines, rel, sha)
  if (ask.match(SYMBOL)) return { ok: false, gap: "not-a-question", detail: "names a symbol but asks no question (no question mark, no English question word): a change or an instruction is not a lookup" }
  return { ok: false, gap: "not-a-lookup" }
}

/** The ledger mark for a finding: one line, the finding first, then its witness (the address and the file's sha256). The agent that writes it is
 *  `mech`, as the swarm writes as `swarm`: the organ is the author, the model is not. */
export const markText = (a: Answer): string => `${a.fact} [mech-${a.kind} · ${a.at} · sha256:${a.sha.slice(0, 16)}]`

/** Did the answer state the finding? A constant's value (digits may carry `,` `_` or spaces: 300,000), or every exported name as a whole word. This
 *  is the pipeline's verify stage for a mechanical turn: a check on the model's words by the machine's own finding, never the other way round,
 *  and it covers short answers ("300000") that the sentence-level ground check does not grade. */
export const verify = (a: Answer, said: string): { ok: true } | { ok: false; missing: string[] } => {
  if (a.kind === "const") {
    const digits = said.replace(/(?<=\d)[,_\s](?=\d)/g, "")
    return a.value && new RegExp(`(?<![\\d.])${a.value.replace(/\./g, "\\.")}(?!\\d|\\.\\d)`).test(digits) ? { ok: true } : { ok: false, missing: [a.value ?? "?"] }
  }
  const missing = (a.names ?? []).filter((n) => !new RegExp(`(?<![\\w$])${n.replace(/\$/g, "\\$")}(?![\\w$])`).test(said))
  return missing.length ? { ok: false, missing } : { ok: true }
}

/** The task a workspace belongs to in the door's medium: a mirror of khora's `projectKey` (opencode-worknotes.mjs): its git root's basename plus a
 *  short hash of the root's path, so every session in one repository shares one ledger. No key for a home directory or anything above it. The
 *  test cross-checks this against the door's own function, so the two cannot drift without a failing test. */
export const taskKey = (workspace: string): string | undefined => {
  if (!path.isAbsolute(workspace)) return undefined
  try {
    let at = fs.realpathSync(workspace)
    if (!fs.statSync(at).isDirectory()) at = path.dirname(at)
    let root = at
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(path.join(at, ".git"))) {
        root = at
        break
      }
      const up = path.dirname(at)
      if (up === at) break
      at = up
    }
    const home = fs.realpathSync(os.homedir())
    if (root === home || home.startsWith(root + path.sep) || root === path.parse(root).root) return undefined
    const base = path.basename(root).replace(/[^\w.-]+/g, "-").replace(/^\.+/, "") || "root"
    return `proj-${base.slice(0, 40)}-${crypto.createHash("sha1").update(root).digest("hex").slice(0, 6)}`
  } catch {
    return undefined
  }
}
