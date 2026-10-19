#!/usr/bin/env bun
// fold-tokens verify — checks the usage tap's log and, given the session DB, checks what the app claims
// against what the provider sent. Exit 0 only when every check holds.
//
//   bun fold-tokens.ts [usage.jsonl] [--db ~/.local/share/opencode/opencode.db] [--session ses_...]
//
// Checks, per line: the hash chain is unbroken (nothing deleted, reordered or edited); the response stream
// reached its terminal event with a usage block (`complete`); the provider's own total equals
// prompt + output (`consistent`). Per session, with --db: the session row's tokens equal the sum of the
// tap's lines for that session (primary requests, 2xx). A request the app retried shows here as more
// wire tokens than the app recorded: that is a real cost the app did not count, so it fails.
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

type Usage = { prompt: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; total: number | null }
type Win = { before: number; after: number; tools: number; withheld?: number }
type Line = { v: number; ts: number; sid: string; seq: number; kind: string; status: number; requestChars?: number; window?: Win | null; protocol: string; complete: boolean; consistent: boolean | null; usage: Usage | null; prev: string; hash: string }

const args = process.argv.slice(2)
const flag = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args.splice(i, 2)[1] : undefined
}
const bool = (name: string) => {
  const i = args.indexOf(name)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}
const ledgerMode = bool("--ledger")
const fromLine = Number(flag("--from") ?? 1)
const ratio = Number(flag("--ratio") ?? 0.1)
const db = flag("--db")
const only = flag("--session")
const file = args[0] ?? process.env.FOLD_USAGE_FILE ?? path.join(os.homedir(), ".local/share/foldcode/usage.jsonl")

// `from`: first line (1-based) to check. The chain is trusted from there on without asking where it came from, so
// the part of a log written after a fix can be verified apart from the part written before it.
export const verify = (text: string, from = 1) => {
  const problems: string[] = []
  const lines: Line[] = []
  let prev = "genesis"
  const breaks: number[] = []
  text
    .split("\n")
    .filter(Boolean)
    .forEach((raw, i) => {
      if (i + 1 < from) return
      const line = JSON.parse(raw) as Line
      const { hash, ...rest } = line
      if (from > 1 && i + 1 === from) prev = line.prev // only a requested start trusts its own parent; line 1 must chain to genesis
      if (line.prev !== prev) breaks.push(i + 1)
      if (createHash("sha256").update(line.prev + JSON.stringify(rest)).digest("hex") !== hash) problems.push(`line ${i + 1}: hash mismatch (edited)`)
      prev = hash
      const ok = line.status >= 200 && line.status < 300
      if (ok && !line.complete) problems.push(`line ${i + 1} ${line.sid}#${line.seq}: incomplete (${line.protocol}, no terminal usage)`)
      if (line.consistent === false) problems.push(`line ${i + 1} ${line.sid}#${line.seq}: provider total ≠ prompt + output`)
      lines.push(line)
    })
  // A run of breaks is one event (writers sharing a file without sharing a head), not a hundred.
  if (breaks.length) problems.push(`chain broken at ${breaks.length} line(s), lines ${breaks[0]}-${breaks.at(-1)} (two writers sharing one log; check with --from ${breaks.at(-1)! + 1})`)
  const sessions = new Map<string, Usage & { requests: number; failed: number }>()
  for (const l of lines) {
    const s = sessions.get(l.sid) ?? { prompt: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: null, requests: 0, failed: 0 }
    sessions.set(l.sid, s)
    // Every request the provider billed counts: the app's session totals include the small title and summary
    // calls, so comparing only the primary requests would blame the app for tokens the tap simply skipped.
    s.requests++
    if (!(l.status >= 200 && l.status < 300)) s.failed++
    if (!l.usage) continue
    s.prompt += l.usage.prompt
    s.cacheRead += l.usage.cacheRead
    s.cacheWrite += l.usage.cacheWrite
    s.output += l.usage.output
    s.reasoning += l.usage.reasoning
  }
  return { problems, lines, sessions }
}


// THE LEDGER — tokens spent against tokens saved, per session and in total.
//   spent     what the provider counted (the tap), billed-equivalent = uncached + ratio * cached.
//   saved     MODELLED, and said so: what the same session would have cost with no fold, same behaviour, an
//             append-only conversation. Each request carries the fold's own before/after window size; the
//             difference becomes tokens at THIS SESSION's measured chars-per-token (body chars / prompt tokens).
//             The no-fold cache is assumed to hit the whole previous request (an append-only prefix), which is
//             the best case for not folding, so the saving is not flattered. Tool definitions the turn did
//             not send (the fullest set seen minus what was sent) are a separate line.
// What this cannot see: the model behaving differently without the fold (the dolphin loop). Settling that takes
// the same prompt run with FOLD_OFF=1; the ledger will take that session as the measured baseline.
export type Ledger = {
  sid: string
  requests: number
  unmeasured: number
  cpt: number
  implausible: boolean
  capped: number
  spent: { prompt: number; cached: number; uncached: number; output: number; billed: number }
  nofold: { prompt: number; billed: number }
  saved: { raw: number; billed: number; window: number; tools: number }
}
export const ledger = (lines: Line[], r = 0.1, windowCap = 128_000): Ledger[] => {
  const bySid = new Map<string, Line[]>()
  const other = new Map<string, Line[]>()
  for (const l of lines) {
    if (!(l.status >= 200 && l.status < 300 && l.usage)) continue
    const into = l.kind === "primary" ? bySid : other
    into.set(l.sid, [...(into.get(l.sid) ?? []), l])
  }
  return [...bySid].map(([sid, ls]) => {
    // The ratio comes only from requests that recorded their size: a line from an older build has no
    // requestChars, and counting it as 0 characters against its real tokens understates the ratio.
    const sized = ls.filter((l) => (l.requestChars ?? 0) > 0)
    const chars = sized.reduce((n, l) => n + l.requestChars!, 0)
    const tokens = sized.reduce((n, l) => n + l.usage!.prompt, 0)
    const cpt = tokens > 0 && chars > 0 ? chars / tokens : 4
    // Code and prose run 2.5-6 chars/token. Outside that the char measure is not describing the tokens the
    // provider counted (a local runtime that truncates the prompt to its context size does exactly this), and
    // converting the fold's char savings at that ratio would invent a number: count nothing saved.
    const plausible = cpt >= 2 && cpt <= 6
    const fullTools = Math.max(0, ...ls.map((l) => (l.window?.tools ?? 0) + (l.window?.withheld ?? 0)))
    const out: Ledger = { sid, requests: ls.length, unmeasured: 0, cpt, implausible: !plausible, capped: 0, spent: { prompt: 0, cached: 0, uncached: 0, output: 0, billed: 0 }, nofold: { prompt: 0, billed: 0 }, saved: { raw: 0, billed: 0, window: 0, tools: 0 } }
    let prevNo = 0
    ls.forEach((l, i) => {
      const u = l.usage!
      const w = l.window
      if (!w) out.unmeasured++
      let windowSaved = w && plausible ? (w.before - w.after) / cpt : 0
      let toolsSaved = w && fullTools && plausible ? (fullTools - w.tools) / cpt : 0
      // The no-fold twin cannot be bigger than the window the model could take: past it the harness compacts
      // or the request fails, so the saving is bounded by what the model could actually have been sent.
      const room = Math.max(0, windowCap - u.prompt)
      if (windowSaved + toolsSaved > room) {
        out.capped++
        const k = room / (windowSaved + toolsSaved)
        windowSaved *= k
        toolsSaved *= k
      }
      const promptNo = u.prompt + windowSaved + toolsSaved
      // A request with no window record has nothing to model: its no-fold twin is the request itself.
      // Where nothing is modelled (no window record, or a ratio that cannot be trusted) the twin is the request
      // itself, cache included: assuming a perfect cache against a session that did not have one invents a saving
      // or a loss out of nothing.
      const modelled = !!w && plausible
      const cachedNo = !modelled || i === 0 ? u.cacheRead : Math.min(prevNo, promptNo)
      const billed = u.prompt - u.cacheRead + r * u.cacheRead
      const billedNo = promptNo - cachedNo + r * cachedNo
      out.spent.prompt += u.prompt
      out.spent.cached += u.cacheRead
      out.spent.uncached += u.prompt - u.cacheRead
      out.spent.output += u.output
      out.spent.billed += billed
      out.nofold.prompt += promptNo
      out.nofold.billed += billedNo
      out.saved.window += windowSaved
      out.saved.tools += toolsSaved
      prevNo = promptNo
    })
    // The small requests the fold does not touch (titles, summaries) cost the same either way.
    for (const l of other.get(sid) ?? []) {
      const u = l.usage!
      const b = u.prompt - u.cacheRead + r * u.cacheRead
      out.spent.prompt += u.prompt
      out.spent.cached += u.cacheRead
      out.spent.uncached += u.prompt - u.cacheRead
      out.spent.output += u.output
      out.spent.billed += b
      out.nofold.prompt += u.prompt
      out.nofold.billed += b
    }
    out.saved.raw = out.nofold.prompt - out.spent.prompt
    out.saved.billed = out.nofold.billed - out.spent.billed
    return out
  })
}
const n0 = (x: number) => Math.round(x).toLocaleString()
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((100 * a) / b)}%` : "-")
const showLedger = (rows: Ledger[], r: number) => {
  const sum = (f: (l: Ledger) => number) => rows.reduce((n, l) => n + f(l), 0)
  for (const l of rows)
    console.log(
      `\n${l.sid}  ${l.requests} requests · ${l.cpt.toFixed(2)} chars/token${l.implausible ? " · IMPLAUSIBLE ratio, savings not computed (a runtime that truncates the prompt?)" : ""}${l.unmeasured ? ` · ${l.unmeasured} without a window record (counted as 0 saved)` : ""}${l.capped ? ` · ${l.capped} requests capped at the window` : ""}\n` +
        `  spent    prompt ${n0(l.spent.prompt)} (cached ${pct(l.spent.cached, l.spent.prompt)}) · output ${n0(l.spent.output)} · billed-equivalent ${n0(l.spent.billed)}\n` +
        `  no fold  prompt ${n0(l.nofold.prompt)} · billed-equivalent ${n0(l.nofold.billed)}   (modelled)\n` +
        `  saved    raw ${n0(l.saved.raw)} (${pct(l.saved.raw, l.nofold.prompt)}) · billed ${n0(l.saved.billed)} (${pct(l.saved.billed, l.nofold.billed)}) · from the window ${n0(l.saved.window)}, from tool definitions ${n0(l.saved.tools)}`,
    )
  console.log(
    `\nALL  ${rows.length} sessions · spent ${n0(sum((l) => l.spent.billed))} billed-equivalent (${n0(sum((l) => l.spent.prompt))} prompt, ${n0(sum((l) => l.spent.output))} output) · saved ${n0(sum((l) => l.saved.billed))} billed-equivalent (${pct(sum((l) => l.saved.billed), sum((l) => l.nofold.billed))}), ${n0(sum((l) => l.saved.raw))} raw tokens\n` +
      `cache read priced at ${r}x input; the no-fold twin is capped at the model window (--window, default 128,000 tokens). "saved" is modelled against an append-only no-fold run; it assumes the model would act the same without the fold. Sessions with no window record count as 0 saved.`,
  )
}

if (import.meta.main && ledgerMode) {
  if (!fs.existsSync(file)) {
    console.log(`UNVERIFIED — no usage log at ${file}.`)
    process.exit(2)
  }
  const { problems, lines } = verify(fs.readFileSync(file, "utf8"), fromLine)
  showLedger(ledger(lines, ratio, Number(flag("--window") ?? 128_000)), ratio)
  if (problems.length) console.log(`\nnote: the log has ${problems.length} integrity problem(s); run without --ledger to see them`)
  process.exit(0)
}

if (import.meta.main) {
  // No log means no tap ran: the service is a build without usage-tap, or FOLD_USAGE_FILE points elsewhere.
  // That is not a pass — nothing the app claims has been checked.
  if (!fs.existsSync(file)) {
    console.log(`UNVERIFIED — no usage log at ${file}. The running service has no usage tap (an older build), or FOLD_USAGE_FILE is set elsewhere.`)
    process.exit(2)
  }
  const { problems, lines, sessions } = verify(fs.readFileSync(file, "utf8"), fromLine)
  console.log(`${file}: ${lines.length} responses, ${sessions.size} sessions`)
  const claims = new Map<string, { input: number; output: number; reasoning: number; read: number; write: number }>()
  // Steps the app recorded with no tokens (interrupted, or ended in an error), by position in the session. The
  // provider bills these requests anyway; the app leaves them out of its totals.
  const zeroSteps = new Map<string, number[]>()
  const notes: string[] = []
  if (db) {
    const { Database } = await import("bun:sqlite")
    const handle = new Database(db, { readonly: true })
    for (const r of handle.query("select session_id sid, data from session_message where type = 'assistant' order by session_id, seq").all() as Array<{ sid: string; data: string }>) {
      const list = zeroSteps.get(r.sid) ?? []
      zeroSteps.set(r.sid, list)
      const t = (JSON.parse(r.data).tokens ?? {}) as { input?: number; cache?: { read?: number; write?: number } }
      list.push((t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0) === 0 ? 1 : 0)
    }
    const rows = handle
      .query("select id, tokens_input input, tokens_output output, tokens_reasoning reasoning, tokens_cache_read read, tokens_cache_write write from session_v2")
      .all() as Array<{ id: string; input: number; output: number; reasoning: number; read: number; write: number }>
    for (const r of rows) claims.set(r.id, r)
  }
  for (const [sid, s] of sessions) {
    if (only && sid !== only) continue
    console.log(
      `\n${sid}  wire: ${s.requests} requests (${s.failed} failed) · prompt ${s.prompt.toLocaleString()} (cache read ${s.cacheRead.toLocaleString()}, write ${s.cacheWrite.toLocaleString()}, uncached ${(s.prompt - s.cacheRead - s.cacheWrite).toLocaleString()}) · output ${s.output.toLocaleString()} (reasoning ${s.reasoning.toLocaleString()})`,
    )
    const c = claims.get(sid)
    if (!c || fromLine > 1) continue // a partial log cannot be compared with the app's whole-session totals
    const appPrompt = c.input + c.read + c.write
    // The app keeps reasoning beside output; whether its `output` already includes it depends on the
    // provider adapter, so both readings are shown and either matching passes.
    const outOk = c.output === s.output || c.output + c.reasoning === s.output
    console.log(`${" ".repeat(sid.length)}  app:  prompt ${appPrompt.toLocaleString()} · output ${c.output.toLocaleString()} + reasoning ${c.reasoning.toLocaleString()} · header ${(c.input + c.output + c.reasoning + c.read + c.write).toLocaleString()}`)
    // An excess on the wire is explained when it is exactly the requests the app recorded as zero-token steps:
    // billed by the provider, absent from the app's totals. That is the app under-counting, not the tap.
    const primary = lines.filter((l) => l.sid === sid && l.kind === "primary" && l.usage)
    const idx = (zeroSteps.get(sid) ?? []).flatMap((z, i) => (z ? [i] : []))
    const missed = idx.reduce((a, i) => ({ prompt: a.prompt + (primary[i]?.usage?.prompt ?? 0), output: a.output + (primary[i]?.usage?.output ?? 0) }), { prompt: 0, output: 0 })
    const dPrompt = s.prompt - appPrompt
    // wire output counts reasoning inside it, so the app's comparable figure is output + reasoning
    const dOutput = s.output - (c.output + c.reasoning)
    if (dPrompt !== 0 || !outOk) {
      if (idx.length > 0 && dPrompt === missed.prompt && (outOk || dOutput === missed.output))
        notes.push(`${sid}: the app's totals leave out ${idx.length} interrupted/errored step(s) the provider billed (${missed.prompt.toLocaleString()} prompt, ${missed.output.toLocaleString()} output tokens); the tap's count is the one to trust`)
      else {
        if (dPrompt !== 0) problems.push(`${sid}: app prompt ${appPrompt} ≠ wire ${s.prompt} (Δ ${dPrompt})`)
        if (!outOk && !(idx.length > 0 && dOutput === missed.output)) problems.push(`${sid}: app output ${c.output}(+${c.reasoning}) ≠ wire ${s.output}`)
      }
    }
  }
  if (fromLine > 1 && db) notes.push(`checked from line ${fromLine}: the chain and per-response checks ran; the app comparison was skipped (a partial log is not the whole session)`)
  if (notes.length) console.log(`\nNOTE:\n  ${notes.join("\n  ")}`)
  console.log(problems.length ? `\nFAIL — ${problems.length} problem(s):\n  ${problems.join("\n  ")}` : "\nOK — chain intact, every response complete, app matches wire")
  process.exit(problems.length ? 1 : 0)
}
