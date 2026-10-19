export * as FoldPlugin from "./fold.js"

// The Fold doorway client. Everything here is a thin forwarder: the fold stack
// (khora's POST /v1/hooks/opencode) decides what a prompt becomes, what a tool
// output folds into, what a finished turn teaches, and — via the perceive
// event — what attached media is transcribed into before the frontier sees
// it. This file carries no fold logic, so it does not change when the fold
// does, and it is the only fold-specific code in the fork.
//
// Perception defaults to local: images through the khora OCR/CV backends,
// audio through the local whisper binary, PDFs through their text layer then
// local OCR (khora/perceive/local.mjs on the door side, all on the box, no
// frontier call). The Perceive tab selects the backends; FOLD_PERCEIVE=0
// restores upstream behavior for media.
//
// Fails open: with the door unreachable, slow, or answering nonsense, opencode
// behaves exactly as upstream. FOLD_OFF=1 removes the plugin's effect entirely.

import { Message, ToolFailure } from "@opencode/ai"
import { define, type Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { money } from "@opencode/util/savings"
import { Effect, Schema, Stream } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { record as rulerRecord, recordTokens as rulerTokens } from "./fold-ruler.js"
import { tap as usageTap } from "./usage-tap.js"

const base = (process.env.FOLD_URL ?? "http://127.0.0.1:11436").replace(/\/+$/, "")
const off = process.env.FOLD_OFF === "1"
// The door sits on the request path, so its recall/surf/title calls get a bounded
// budget. The contract's default is 1500ms: the door's surf does real work behind
// the answer (medium writes, the mechanical fold), and a 250ms budget measured as
// "folded" while the stigmergic note never arrived. A wedged or slow door still
// fails open fast (the turn sends native content) instead of stalling the frontier.
// FOLD_TIMEOUT_MS moves it.
const askTimeout = Number(process.env.FOLD_TIMEOUT_MS ?? 1500)
const foldTimeout = Number(process.env.FOLD_FOLD_TIMEOUT_MS ?? 20_000)
// The swarm is model-free but reads the material through the door's capacity
// organs; it gets a longer budget than a recall note while still failing open.
const swarmTimeout = Number(process.env.FOLD_SWARM_TIMEOUT_MS ?? 60_000)
// The cube runs a python witness in the door's locked venv — a real import
// plus a fit, so it carries the swarm's class of budget, never the 250ms
// recall lane. FOLD_CUBE_TIMEOUT_MS moves it; the door may still answer a
// typed gap (cube-disabled without FOLD_CUBE=1) inside this window.
const cubeTimeout = Number(process.env.FOLD_CUBE_TIMEOUT_MS ?? 60_000)
const minChars = Number(process.env.FOLD_MIN_CHARS ?? 4000)
const coolDown = 30_000
const debug = process.env.FOLD_DEBUG === "1"
// FOLD_RULER_FILE=<path.jsonl> measures every primary request by segment (measurement only; see fold-ruler.ts).
const rulerFile = process.env.FOLD_RULER_FILE
// The provider's own usage, read off each response (usage-tap.ts). On by default: it is the only count that is not derived.
const usageFile = process.env.FOLD_USAGE_FILE ?? path.join(os.homedir(), ".local/share/foldcode/usage.jsonl")
// FOLD_TRAIL=1: stale tool results become opaque handles except the ones the decayed trail keeps (decided by the door, see
// khora/opencode-trail.mjs; only when the prompt cache is cold or the window is under pressure, so it never costs a warm cache).
const trailOn = process.env.FOLD_TRAIL === "1"
const trailMinChars = Number(process.env.FOLD_TRAIL_MIN_CHARS ?? 1500)
// Local-first perception: attachments are transcribed by the khora on the
// box (tesseract, ffmpeg, poppler, whisper.cpp when installed) before the
// frontier is sent them, so vision and transcription default to local
// models, never a frontier call. FOLD_PERCEIVE=0 restores upstream behavior.
const perceiveOff = process.env.FOLD_PERCEIVE === "0"
// Shadow capture for the draft-lint trial (the-fold/docs/DRAFT-LINT-PREREG.md):
// full draft text and full tool I/O ride to the door's observe-only shadow
// event. Default off. Local-only rows the door never ships, scores, or
// injects; a failed post is lost, never blocking.
const shadowOn = process.env.FOLD_SHADOW === "1"
// FACING (level 1): the typing the door computes on every answer (groundCheck: each sentence
// grounded / asserted / self, plus the verifiable-failure flags) is RENDERED ON the answer as its
// own notice row, instead of only being deferred into the next turn's note. On by default (every
// reply carries its provenance; FOLD_FACING=0 disables); it discloses provenance and doubt and never
// alters the model's own text (level 1 = no behavior change).
const facingOn = process.env.FOLD_FACING !== "0"
// How much of the facing notice shows: off · line · standing · full. `/fold facing <level>` moves it.
let facingLevel = process.env.FOLD_FACING_LEVEL ?? "full"
// DRAFT-LINT (the-fold/docs/DRAFT-LINT.md): draft + act are the new door
// events. FOLD_DRAFT=0 disables them; FOLD_OFF=1 still disables everything.
// Rollout step 1 is observe-only — the door records verdicts it never
// enforces — so these posts change no turn by default.

let downUntil = 0

// postRaw is a plain promise so the request path (post) and the event-time
// precompute share one implementation: a tool result is folded the moment it
// lands, off the request path, so the next context assembly reads the cache
// with no door wait (see foldOnce / foldBudget below).
const postRaw = async (body: unknown, timeout: number) => {
  if (off || Date.now() < downUntil) return undefined
  const response = await fetch(`${base}/v1/hooks/opencode`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-er7-surface": "opencode" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  }).catch(() => {
    downUntil = Date.now() + coolDown
    return undefined
  })
  if (!response?.ok) return undefined
  return (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
}

const post = (body: unknown, timeout: number) =>
  Effect.tryPromise(() => postRaw(body, timeout)).pipe(Effect.catch(() => Effect.succeed(undefined)))

const lastUserText = (messages: SessionHooks["context"]["messages"]) => {
  const message = messages.findLast((item) => item.role === "user")
  if (!message) return ""
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
}

// Surf: the window must not grow per prompt. Turns older than the last
// `keepTurns` collapse into one receipt block (the ask and how it ended); the
// durable session keeps everything, and the frontier can re-read on demand.
// FOLD_KEEP_TURNS=0 disables (upstream behavior).
const keepTurns = Number(process.env.FOLD_KEEP_TURNS ?? 1)
const grainMode = process.env.FOLD_GRAIN ?? "auto"

// Grain controller (P2): choose the projection's keep-count from measured signals.
// "fixed" preserves the static env values; "auto" applies the rules. Base <= 0 means
// "disabled" and is never re-enabled by the controller.
export type GrainSignals = {
  reopenCount?: number
  pointerCount?: number
  scentWarm?: boolean
  costGateMargin?: number | null
}

export const grainKeepTurns = (base: number, signals: GrainSignals = {}, totalTurns = Infinity) => {
  if (base <= 0) return base
  if (grainMode === "fixed") return base
  const reopen = Math.max(0, signals.reopenCount ?? 0)
  const warm = (signals.pointerCount ?? 0) > 0 || signals.scentWarm === true
  const cold = reopen === 0 && !warm
  let keep = base
  if (reopen > 0) keep = Math.min(totalTurns, base + reopen)
  else if (warm) keep = Math.min(totalTurns, base + 1)
  else if (cold && base > 1) keep = base - 1
  if (typeof signals.costGateMargin === "number" && signals.costGateMargin < 0) keep = Math.min(totalTurns, keep + 1)
  return Math.max(1, keep)
}

export const grainKeepSteps = (base: number, signals: GrainSignals = {}, totalSteps = Infinity) => {
  if (base <= 0) return base
  if (grainMode === "fixed") return base
  const reopen = Math.max(0, signals.reopenCount ?? 0)
  const warm = (signals.pointerCount ?? 0) > 0
  const cold = reopen === 0 && !warm
  let keep = base
  if (reopen > 0) keep = Math.min(totalSteps, base + reopen)
  else if (warm) keep = Math.min(totalSteps, base + 1)
  else if (cold && base > 1) keep = base - 1
  return Math.max(1, keep)
}

export const surfPlan = (messages: SessionHooks["context"]["messages"], keepOverride?: number) => {
  const keep = keepOverride ?? keepTurns
  if (keep <= 0) return undefined
  const starts = messages.flatMap((item, index) =>
    item.role === "user" && item.content.some((part) => part.type === "text") ? [index] : [],
  )
  if (starts.length <= keep) return undefined
  const cut = starts[starts.length - keep]
  const turns = starts.slice(0, starts.length - keep).map((start, i, all) => {
    const turn = messages.slice(start, i + 1 < all.length ? all[i + 1] : cut)
    const answer = turn
      .findLast((item) => item.role === "assistant")
      ?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
    const grounds = [
      ...new Set(turn.flatMap((item) => item.content.flatMap((part) => (part.type === "tool-call" ? [part.name] : [])))),
    ]
    return { n: i + 1, ask: lastUserText(turn), answer: answer ?? "", grounds }
  })
  return { cut, turns }
}

// Every settled turn before the current ask, as {ask, answer, grounds}: published to the door
// each turn so the project's other agents can read them (through Houdini, never raw).
const priorTurns = (messages: SessionHooks["context"]["messages"]) => {
  const starts = messages.flatMap((item, index) =>
    item.role === "user" && item.content.some((part) => part.type === "text") ? [index] : [],
  )
  if (starts.length < 2) return []
  const end = starts[starts.length - 1]
  return starts.slice(0, -1).map((start, i, all) => {
    const turn = messages.slice(start, i + 1 < all.length ? all[i + 1] : end)
    const answer = turn
      .findLast((item) => item.role === "assistant")
      ?.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
    const grounds = [
      ...new Set(turn.flatMap((item) => item.content.flatMap((part) => (part.type === "tool-call" ? [part.name] : [])))),
    ]
    return { n: i + 1, ask: lastUserText(turn), answer: (answer ?? "").slice(0, 4000), grounds }
  })
}

// CLIPPY'S PRESENT, mechanically. The fold is not a transcript tail — it is the THREAD: DISCOURSE (the beings
// the current ask SHARES with the folded turns, computed from the words, never drawn) and what is already
// SETTLED (DMD, last-wins per ask). The frontier is handed the present — what the conversation is ABOUT and
// what is done — so a trimmed window cannot lose the thread and re-answer. No model; a fact to reason from.
const wordsOf = (t: string) => new Set(String(t ?? "").toLowerCase().match(/[\p{L}\p{N}_]{4,}/gu) ?? [])

// ── THE DERIVATION — BOX computes the chain ─────────────────────────────────
// A turn that DEFINES a value in terms of earlier ones (`NAME = expression`) is a link. The machine COMPOSES the
// chain to its values, so the note carries the RESULT of the derivation, not its links — a complex, interdependent
// thread survives a minimal window. Only arithmetic over the chain is composed; anything not computable is left
// in the mouth's own words. No model, deterministic, zero tokens.
const DEF_RE = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*([^.\n]+?)\s*\.?\s*$/
export function evalArith(expr: string, lookup: (n: string) => number | null): number | null {
  const s = String(expr)
  let i = 0
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++
  }
  function primary(): number | null {
    ws()
    if (s[i] === "(") {
      i++
      const v = add()
      ws()
      if (s[i] === ")") i++
      return v
    }
    const ns = i
    while (i < s.length && /[0-9.]/.test(s[i])) i++
    if (i > ns) return Number(s.slice(ns, i))
    const is = i
    while (i < s.length && /[A-Za-z0-9_]/.test(s[i])) i++
    if (i > is) return lookup(s.slice(is, i))
    return null
  }
  function mul(): number | null {
    let v = primary()
    if (v === null) return null
    for (;;) {
      ws()
      const op = s[i]
      if (op !== "*" && op !== "/") return v
      i++
      const r = primary()
      if (r === null) return null
      v = op === "*" ? v * r : v / r
    }
  }
  function add(): number | null {
    let v = mul()
    if (v === null) return null
    for (;;) {
      ws()
      const op = s[i]
      if (op !== "+" && op !== "-") return v
      i++
      const r = mul()
      if (r === null) return null
      v = op === "+" ? v + r : v - r
    }
  }
  const v = add()
  ws()
  return i === s.length ? v : null
}
/** The chain a session defined, composed: every `NAME = expression` turn resolved to its value where it is arithmetic. */
export function derivationFor(turns: NonNullable<ReturnType<typeof surfPlan>>["turns"]): Map<string, number> {
  const defs = new Map<string, string>()
  for (const t of turns) {
    const m = DEF_RE.exec(String(t.answer ?? "").trim())
    if (m) defs.set(m[1], m[2])
  }
  const val = new Map<string, number>()
  const resolve = (n: string, seen: Set<string>): number | null => {
    if (val.has(n)) return val.get(n) ?? null
    if (!defs.has(n) || seen.has(n)) return null
    seen.add(n)
    const v = evalArith(defs.get(n) ?? "", (x) => resolve(x, seen))
    if (typeof v === "number" && Number.isFinite(v)) val.set(n, v)
    return val.has(n) ? (val.get(n) ?? null) : null
  }
  for (const n of defs.keys()) resolve(n, new Set())
  return val
}

export const surfLocal = (turns: NonNullable<ReturnType<typeof surfPlan>>["turns"], ask = "") => {
  const byAsk = new Map<string, (typeof turns)[number]>()
  for (const t of turns) byAsk.set(short(t.ask, 300), t) // last-wins per ask (the DMD)
  const kept = [...byAsk.values()]
  // THE MECHANICAL FOLD. Distinct asks are not listed — they FOLD to their THREADS: turns sharing a rare term
  // become one line (a mechanical paraphrase — the door's ladder Kind rung), and the oldest threads become a
  // count. The note is bounded by THREADS, not turns, and by a hard char budget. No model.
  const askW = wordsOf(ask)
  const about = [
    ...new Set(kept.flatMap((t) => [...wordsOf(`${t.ask} ${t.answer}`)].filter((w) => askW.has(w)))),
  ].slice(0, 6)
  // THE DERIVATION, composed: the chain resolved to its values, so a trimmed window still holds the result.
  const derived = [...derivationFor(kept)].slice(-12)
  const derivedLine = derived.map(([n, v]) => `${n}=${Number.isInteger(v) ? v : v.toFixed(2)}`).join(", ")
  const budget = Number(process.env.FOLD_NOTE_CHARS ?? 2_000)
  const maxThreads = Number(process.env.FOLD_NOTE_GROUPS ?? 6)
  // group each turn by its rarest content term not already in the ask — its THREAD (the Kind rung, mechanically)
  const docs = kept.map((t) => [...wordsOf(`${t.ask} ${t.answer}`)])
  const df = new Map<string, number>()
  for (const d of docs) for (const w of d) df.set(w, (df.get(w) ?? 0) + 1)
  const groups = new Map<string, number[]>()
  docs.forEach((d, i) => {
    const sig =
      d
        .filter((w) => !askW.has(w))
        .sort((a, b) => (df.get(a) ?? 0) - (df.get(b) ?? 0) || (a < b ? -1 : 1))[0] ?? `~${i}`
    const g = groups.get(sig) ?? []
    g.push(i)
    groups.set(sig, g)
  })
  const threads = [...groups.entries()]
    .map(([sig, idx]) => ({ sig, idx, newest: idx[idx.length - 1] }))
    .sort((a, b) => b.newest - a.newest) // newest threads first
  // THE SETTLE LEDGER — one judgment, used twice. A kept ask is settled only if the log carries a reply for it;
  // the header count and each line's → settled / (open, no reply) must be the same predicate, or the top of the
  // note claims a window all-done that the lines below disclose as open (kept.length was counted as "settled").
  const replied = (t: (typeof turns)[number]) => t.answer.trim().length > 0
  const settledN = kept.filter(replied).length
  const openN = kept.length - settledN
  // The folded tail is part of the same ledger: an ask the index dropped is still either answered or not, and the
  // note must not let the fold hide open work behind a bare count (the header would say "1 settled" over a tail
  // holding the unanswered ask). Same predicate as every line below — a reply exists, or it does not.
  const openIn = (ts: typeof threads) => ts.reduce((n, t) => n + t.idx.filter((i) => !replied(kept[i])).length, 0)
  const lineOf = (t: (typeof threads)[number]) => {
    const last = kept[t.idx[t.idx.length - 1]]
    return `- [${t.sig}] ${t.idx.length} ask(s) — latest: ${short(last.ask, 160)} → ${replied(last) ? `settled: ${short(last.answer, 220)}` : "(open, no reply)"}`
  }
  const build = (list: typeof threads, folded: typeof threads) => {
    const ext = folded.reduce((n, t) => n + t.idx.length, 0)
    const foldedOpen = openIn(folded)
    return [
      `[fold: the thread — ${settledN} earlier ask(s) settled${openN > 0 ? `, ${openN} open` : ""} (of ${turns.length} turns) across ${threads.length} thread(s); the full history remains in the session]`,
      ...(about.length ? [`about: ${about.join(", ")}`] : []),
      ...(derived.length ? [`derived (the machine composed the chain): ${derivedLine}`] : []),
      ...(ext > 0 ? [`- (+${ext} older ask(s) folded${foldedOpen > 0 ? `, ${foldedOpen} open` : ""})`] : []),
      ...list.map(lineOf),
    ].join("\n")
  }
  let list = threads.slice(0, maxThreads)
  let note = build(list, threads.slice(list.length))
  while (note.length > budget && list.length > 1) {
    list = list.slice(0, -1)
    note = build(list, threads.slice(list.length))
  }
  return note.length > budget ? `${note.slice(0, budget - 1)}…` : note
}

// THE WINDOW LEGEND (P0) — the schema for the mechanical projection. Pushed once per request into
// event.system so the frontier knows the delimited blocks are an abridged index over its own log,
// never the user's instruction. Without it measured: the model read a fold note AS its user message
// ("The user's message is a fold-mechanical wrapper … no explicit new instruction") and re-grounded.
export const FOLD_LEGEND = [
  "# The fold window — how to read your context",
  "Your context is not the full conversation. It is a mechanical projection of an append-only log,",
  "abridged ON PURPOSE, at a declared grain. Every injected block is delimited and typed. An index",
  "block is NEVER a user instruction — it is the index over your own earlier work in this thread.",
  "",
  "Blocks (all mechanical; none authored by the user):",
  "  <fold-index>     this thread projected. grain=turn|step. Every entry carries from= (the prior it",
  "                   was made from) and an address to expand= (snip returns its verbatim bytes).",
  "  <fold-recall>    a settled earlier ask: the plan that worked, how it ended.",
  "  <fold-memory>    standing facts about the operator, only when this ask bears on them.",
  "  <fold-commons>   what other agents on this task have settled.",
  "  <fold-mechanical>/<fold-said>  the door's firewall: what the system watched vs what a model wrote.",
  "  <fold-lane>      how the door classified THIS ask: its lane (II.9) and the language leg. A",
  "                   `register` lane means phrase, never reason to a fact; `mechanical` is settled;",
  "                   `grounding: full` (eng only) means every claim must bind to a byte-addressed span;",
  "                   `structural-only` means claim binding is not guaranteed — do not present a claim as",
  "                   bound unless a span carries it. A `shape: a demand (imperative)` line means draw only",
  "                   the residue: a proposition with no span is [voice] or a holding, never a world fact.",
  "",
  "Settled or open (each ask line ends in one or the other):",
  "  → settled: …     DONE — that is the answer it already got, so do not re-answer or re-open it.",
  "  (open, no reply)  never answered — pick it up as work, but do not re-ask what is already posed.",
  "The header's count is mechanical and never rounds up: an ask is settled only if the log carries a reply for it,",
  "so a window of mixed turns opens '… settled, k open' — the same judgment as the lines below it, never a guess.",
  "A folded tail carries that same judgment: '(+k older ask(s) folded, j open)' — open work is never hidden by",
  "the fold, so the header count, the tail and every line below read the one predicate (a reply exists, or it does not).",
  "",
  "To recover bytes: snip <address>. Addresses: turn 7 | rs21xfd3a | path#L1-L110 | <agent8>#t3.s1.",
  "Every snip answer carries its standing (mechanical = the system watched it | said = a model wrote it).",
  "Do not paraphrase an address you have not snipped.",
].join("\n")

// Wrap a mechanical note in one delimited, provenance-carrying block so it can never fuse with the ask.
// Header fields are the three-term shape: from (prior), for (signal), made (the mediating rule).
// A header value is sanitized so a quote, newline or angle bracket can never break the tag or smuggle a second
// block past the model's eye (defense; today the values are code-derived, but the door's own note text is not).
const foldAttr = (v: unknown) => String(v ?? "").replace(/[<>"]/g, "'").replace(/\s+/g, " ").trim()
export const foldIndex = (header: Record<string, string>, body: string) =>
  `<fold-index${Object.entries(header)
    .map(([k, v]) => [k, foldAttr(v)] as const)
    .filter(([, v]) => v.length > 0)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("")}>\n${body}\n</fold-index>\n\n`

// A person-facing notice (a `synthetic` rendered for the Person, never for the model). Matched at the START
// of the message only: with the /m flag a genuine ANSWER that happened to begin a line with a notice prefix was
// deleted wholesale — and "fold measured ·" (P0.4) is a phrase a model could plausibly write.
export const isPersonNotice = (text: string) =>
  /^(?:fold facing ·|fold measured ·|fold chase|fold matrix|fold view |fold savings|fold audit|fold door unreachable)/.test(
    String(text ?? ""),
  )

export const surfApply = (
  messages: SessionHooks["context"]["messages"],
  cut: number,
  note: string,
  made = "fold surf",
  turns = 0,
) => {
  const head = messages[cut]
  messages.splice(0, cut)
  const wrapped = foldIndex(
    {
      grain: "turn",
      from: turns > 0 ? `${turns} earlier turn(s)` : `${cut} earlier message(s)`,
      for: "the current ask",
      made,
    },
    note,
  )
  messages[0] = Message.make({
    id: head.id,
    role: head.role,
    content: [{ type: "text" as const, text: wrapped }, ...head.content],
    metadata: head.metadata,
    providerMetadata: head.providerMetadata,
    native: head.native,
  })
}

// STEP FOLD — surf for the inside of one long turn. `surfPlan` cuts at user prompts, so an agent that runs
// 60 tool steps under ONE prompt never shrinks. This cuts at steps: the last FOLD_KEEP_STEPS (assistant +
// its tool results) stay verbatim, older whole steps leave the window as one note of addressed receipts
// (each `snip`-able to its exact bytes), and a bounded VIEW of the medium rides with it: the latest bytes of
// the files the collapsed steps read or wrote, as of their last read or write. Measured (regex-engine task,
// 197 differential cases, phases 1-6): with the view, 37-40 steps and 22k input tokens/step reached 197/197;
// without it the agent re-read files (329 reads vs 8 writes) and stalled. FOLD_KEEP_STEPS=0 disables (default).
// SURF IS THE LINEAGE'S WORD, AND IT HAS ALWAYS BEEN ADDRESSED. In khora it began as the surfer (legacy host/
// surfer.js): the segment a reader's prompt addresses is snipped out of the corpus — byte-accurate, typed gap
// when unaddressable, never a guess, no model. surf.js (stage 3) seeks material shaped like the void across
// several sources (queries carry context, candidates carry provenance, failures are typed); hunt.js admits,
// surf judges nothing. Surf is the general term and its subtypes are the cube's 27 cells — grep is among
// them (SEG·Figure: each match a Link from a word to a place; khora native/the-fold/surf-types.js). Here the
// medium is the window: receipts address each collapsed step (snip returns its exact bytes), the view carries
// current bytes, the cut is stated.
const stepKeep = () => Number(process.env.FOLD_KEEP_STEPS ?? 0)
const viewCap = () => Number(process.env.FOLD_VIEW_CHARS ?? 40_000)
type Msg = SessionHooks["context"]["messages"][number]
const squash = (t: string, n: number) => t.replace(/\s+/g, " ").trim().slice(0, n)
const textOfResult = (part: Msg["content"][number]) => foldable(part)?.text
const pathOf = (input: unknown) => {
  const i = (input ?? {}) as Record<string, unknown>
  const v = i.filePath ?? i.file_path ?? i.path ?? i.file
  return typeof v === "string" ? v : undefined
}
const hash36 = (t: string) => {
  let h = 5381
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0
  return h.toString(36).slice(0, 6).padStart(4, "0")
}
export const stepPlan = (messages: Msg[], keep = stepKeep(), viewMax = viewCap()) => {
  if (!(keep > 0)) return undefined
  const s = messages.findLastIndex((m) => m.role === "user" && m.content.some((p) => p.type === "text"))
  if (s < 0) return undefined
  const starts: number[] = []
  for (let i = s + 1; i < messages.length; i++) if (messages[i].role === "assistant") starts.push(i)
  if (starts.length <= keep) return undefined
  const cutStep = starts.length - keep
  const from = starts[0]
  const to = starts[cutStep]
  const salt = hash36(messages[s].id ?? String(s))
  const steps = starts.slice(0, cutStep).map((start, k) => {
    const end = starts[k + 1]
    const part = messages.slice(start, end)
    const raw = part
      .flatMap((m) =>
        m.content.flatMap((p) =>
          p.type === "text"
            ? [`said: ${p.text}`]
            : p.type === "tool-call"
              ? [`${p.name}(${clip(p.input ?? {}, 3000)})`]
              : p.type === "tool-result"
                ? [`=> ${textOfResult(p) ?? clip(p.result, 3000)}`]
                : [],
        ),
      )
      .join("\n")
      .slice(0, 20_000)
    const call = part.flatMap((m) => m.content.filter((p) => p.type === "tool-call"))[0]
    const result = part.flatMap((m) => m.content.flatMap((p) => (p.type === "tool-result" ? [textOfResult(p) ?? ""] : [])))[0] ?? ""
    const said = part[0].content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ")
    const n = k + 1
    return {
      n,
      handle: `rs${n.toString(36)}${salt}`,
      raw,
      line: `${said ? `said "${squash(said, 120)}" · ` : ""}${call && call.type === "tool-call" ? `${call.name} ${pathOf(call.input) ?? squash(clip(call.input ?? {}, 120), 120)}` : "(no tool)"} → ${squash(result, 140)}`,
    }
  })
  // the VIEW: latest bytes per path from the collapsed region (read result / written content); an edit makes the
  // path unknown (its bytes are not in the call), so it is left out rather than shown stale
  const calls = new Map<string, { name: string; input: unknown }>()
  const files = new Map<string, string>()
  for (const m of messages.slice(from, to)) {
    for (const p of m.content) {
      if (p.type === "tool-call") {
        calls.set(p.id, { name: p.name, input: p.input })
        const path = pathOf(p.input)
        const content = (p.input as Record<string, unknown> | undefined)?.content
        if (path && /write|create/i.test(p.name) && typeof content === "string") (files.delete(path), files.set(path, content))
        else if (path && /edit|patch|replace/i.test(p.name)) files.delete(path)
      } else if (p.type === "tool-result") {
        const c = calls.get(p.id)
        const path = c && pathOf(c.input)
        const text = textOfResult(p)
        if (c && path && /read|view|cat/i.test(c.name) && text !== undefined && !/error|not found/i.test(text.slice(0, 40))) (files.delete(path), files.set(path, text))
      }
    }
  }
  // a path touched again inside the kept steps is visible there already
  const kept = new Set<string>()
  for (const m of messages.slice(to)) for (const p of m.content) if (p.type === "tool-call") { const path = pathOf(p.input); if (path) kept.add(path) }
  const view: Array<[string, string]> = []
  let used = 0
  for (const [path, bytes] of [...files].reverse()) {
    if (kept.has(path)) continue
    if (used + bytes.length > viewMax && view.length) break
    if (!(viewMax > 0)) break
    view.push([path, bytes.slice(0, viewMax)])
    used += bytes.length
  }
  view.reverse()
  return { s, from, to, steps, view }
}
export const stepNote = (plan: NonNullable<ReturnType<typeof stepPlan>>, keep: number) =>
  [
    // Prefix-stable: the note names only the folded steps, never the running count, so the same cut is the
    // same bytes on every request and the provider's cache keeps reading past it.
    `[fold: steps 1-${plan.steps.length} of this turn are stored verbatim; the steps after them are shown in full. A call to snip with a handle below returns that step's exact text.]`,
    ...plan.steps.map((st) => `- step ${st.n} (snip ${st.handle}): ${st.line}`),
    ...(plan.view.length
      ? [
          `[workspace: these are the files the stored steps read or wrote, as of their last read or write in this turn. Files on disk are always current; read_file shows them.]`,
          ...plan.view.map(([path, bytes]) => `=== ${path} ===\n${bytes}`),
        ]
      : []),
  ].join("\n")
export const stepApply = (messages: Msg[], plan: NonNullable<ReturnType<typeof stepPlan>>, keep: number, store?: Map<string, string>) => {
  if (store) for (const st of plan.steps) store.set(st.handle, st.raw)
  const head = messages[plan.s]
  const note = stepNote(plan, keep)
  const wrapped = foldIndex(
    {
      grain: "step",
      from: `steps 1-${plan.steps.length} of this turn`,
      for: "the current ask",
      made: "fold stepNote",
    },
    note,
  )
  messages.splice(plan.from, plan.to - plan.from)
  messages[plan.s] = Message.make({
    id: head.id,
    role: head.role,
    content: [...head.content, { type: "text" as const, text: `\n\n${wrapped}` }],
    metadata: head.metadata,
    providerMetadata: head.providerMetadata,
    native: head.native,
  })
}

// THE HARD CAP — the frontier's window NEVER grows past FOLD_MAX_CHARS. The local model does a lot with
// 8,000 chars; the frontier gets one comfortable ceiling and no more. Folding bounds it per turn; this bounds
// it absolutely: after folding, drop the OLDEST whole turn until the assembly fits, always keeping the last
// (the current ask) and the head. A filed ceiling, not a hope — no turn, tool output or runaway can pass it.
const messageChars = (m: SessionHooks["context"]["messages"][number]) =>
  m.content.reduce(
    (k, p) =>
      k +
      (p.type === "text"
        ? p.text.length
        : p.type === "tool-call"
          ? JSON.stringify(p.input ?? {}).length
          : p.type === "tool-result"
            ? JSON.stringify(p.result ?? {}).length
            : 0),
    0,
  )
export const contextChars = (messages: SessionHooks["context"]["messages"]) => messages.reduce((n, m) => n + messageChars(m), 0)
// The window ceiling the cap enforces, in chars of messages + injected system blocks: the tighter of the
// window cap and the gate's room after the tool definitions. stableStepCut plans against this same number,
// so the cut and the cap never disagree (when they did, the cap dropped steps the cut had kept, and every
// drop edited the head: 9 of 17 live requests broke the cache that way).
export const windowLimit = (tools: number) => {
  const gate = gateChars()
  return Math.min(Number(process.env.FOLD_MAX_CHARS ?? 32_000), gate > 0 ? gate - tools : Infinity)
}

export const capContext = (
  messages: SessionHooks["context"]["messages"],
  system: ReadonlyArray<{ text?: string }> = [],
  opts: { fixed?: number; store?: Map<string, string>; clipOnly?: boolean } = {},
) => {
  // The tighter of the window cap and THE GATE (the whole prompt: tool definitions are `fixed`, they never shrink).
  const max = windowLimit(opts.fixed ?? 0)
  if (!(max > 0)) return
  const keep = (text: string, cut: number) => {
    if (!opts.store) return clipToFit(text, cut)
    const handle = `rc${hash36(text)}${text.length.toString(36)}`
    opts.store.set(handle, text)
    return clipToFit(text, cut, handle)
  }
  // The injected blocks (recall, commons, legend, fold-index, plan) live in `event.system`, not in `messages`.
  // They are counted against the same ceiling, so a large injection cannot slip past the cap (they are never
  // dropped — the message window shrinks first, and if the injections alone exceed the cap the window floors).
  const injected = system.reduce((n, part) => n + (typeof part?.text === "string" ? part.text.length : 0), 0)
  const over = () => contextChars(messages) + injected - max
  // 1. CLIP before dropping. One large part (a 24k file read) must not evict every step around it: oversized
  // tool results and tool-call inputs are cut, oldest first, down to a floor, so each step keeps its shape
  // (which call, on what, what came back). Measured on the dolphin session: dropping whole messages instead
  // left the ask + note + one orphaned read, and the agent re-read the same file for 70 steps.
  const floor = Math.min(2_000, Math.floor(max / 4))
  // Parts are immutable: a clipped part is a new part in a new message, the original bytes held under a handle.
  // A clip always lands on the floor, never on "just enough": the same part is the same bytes on every later
  // request, so a clip moves the cache boundary once instead of on every step.
  for (let i = 1; i < messages.length && over() > 0; i++)
    for (let j = 0; j < messages[i].content.length; j++) {
      const excess = over()
      if (excess <= 0) break
      const part = messages[i].content[j]
      let next: Msg["content"][number] | undefined
      if (part.type === "tool-result") {
        const text = foldable(part)?.text
        if (text === undefined || text.length <= floor) continue
        next = { ...part, result: { type: "text" as const, value: keep(text, floor) } }
      } else if (part.type === "tool-call" && part.input && typeof part.input === "object") {
        const input = { ...(part.input as Record<string, unknown>) }
        for (const key of Object.keys(input)) {
          const v = input[key]
          if (typeof v === "string" && v.length > floor) input[key] = keep(v, floor)
        }
        next = { ...part, input }
      }
      if (next) messages[i] = { ...messages[i], content: messages[i].content.map((p, k) => (k === j ? next : p)) } as Msg
    }
  // 2. Then drop the OLDEST whole STEP after the head while still over: an assistant message and the tool
  // results that answer it leave together, so no result is ever orphaned from its call (an orphan is
  // stripped downstream, which silently erases what the agent just read). The head (index 0, which carries
  // the fold note) and the last step (the current work) are pinned.
  const stepEnd = (start: number) => {
    let j = start + 1
    while (j < messages.length && messages[j].role !== "assistant" && !(messages[j].role === "user" && messages[j].content.some((p) => p.type === "text"))) j++
    return j
  }
  for (let guard = 0; guard < 5000 && !opts.clipOnly && messages.length > 2 && over() > 0; guard++) {
    const end = stepEnd(1)
    if (end >= messages.length) break
    const gone = messages.splice(1, end - 1)
    // Lossless: the dropped step's exact bytes are held under a handle and a one-line receipt rides in the head.
    if (opts.store) {
      const raw = JSON.stringify(gone.map((m) => m.content))
      const handle = `rd${hash36(raw)}${raw.length.toString(36)}`
      opts.store.set(handle, raw)
      const names = gone.flatMap((m) => m.content.flatMap((p) => (p.type === "tool-call" ? [`${p.name} ${pathOf(p.input) ?? ""}`.trim()] : [])))
      const receipt = { type: "text", text: `[fold: a step (${names.join(", ") || "text"}) left the window to fit the gate; snip ${handle} returns its exact bytes]` } as Msg["content"][number]
      messages[0] = { ...messages[0], content: [...messages[0].content, receipt] } as Msg
    }
  }
}

// THE GATE — the whole prompt the model receives (system + tool definitions + messages), in chars of what the
// hooks hand the provider. Over it, the fold compresses mechanically and losslessly: whole steps become
// addressed receipts, cut bytes are held under snip handles. It never fails a request. 0 disables.
export const gateChars = () => Number(process.env.FOLD_GATE_CHARS ?? 48_000)
export const toolChars = (tools: Record<string, unknown> | undefined) => (tools ? JSON.stringify(tools).length : 0)
export const systemChars = (system: ReadonlyArray<{ text?: string }>) =>
  system.reduce((n, part) => n + (typeof part?.text === "string" ? part.text.length : 0), 0)

// PREFIX-STABLE STEP FOLD. Measured on a live 39-request session: folding all but the newest step on EVERY
// request rewrote the head each time, so the provider cached only the fixed 8,640-token prefix and billed
// the whole window again on every step (cost fell 4-24% against no fold while raw tokens fell 3x). Here the
// cut is held still while the window fits under the gate; only when it overflows does the cut jump, far
// enough that the window drops to `low` of the gate, so many appended steps fit before the next jump.
// Between jumps every request is the previous one plus the new step: an append, which the cache reuses.
export type StepEpoch = { head: string; cut: number; view: number }
export const stableStepCut = (
  messages: Msg[],
  sizes: { tools: number; system: number },
  prev: StepEpoch | undefined,
  low = 0.6,
): StepEpoch | undefined => {
  const limit = windowLimit(sizes.tools)
  if (!(limit > 0) || !Number.isFinite(limit)) return undefined
  const s = messages.findLastIndex((m) => m.role === "user" && m.content.some((p) => p.type === "text"))
  if (s < 0) return undefined
  const head = messages[s].id ?? String(s)
  const steps = messages.slice(s + 1).filter((m) => m.role === "assistant").length
  const held = prev && prev.head === head ? prev : { head, cut: 0, view: viewCap() }
  // The window as it will be sent: folded at `cut`, then with the cap's clips (which never move the prefix
  // more than once per part). Only what clipping cannot bring under the gate is an overflow.
  const size = (cut: number, view: number) => {
    const trial = structuredClone(messages)
    const plan = cut > 0 ? stepPlan(trial, steps - cut, view) : undefined
    if (plan) stepApply(trial, plan, steps - cut)
    capContext(trial, [{ text: "x".repeat(sizes.system) }], { fixed: sizes.tools, clipOnly: true })
    return contextChars(trial) + sizes.system
  }
  const cut = Math.min(held.cut, Math.max(0, steps - 1))
  if (size(cut, held.view) <= limit) return { head, cut, view: held.view }
  // Overflow: the smallest jump (and the largest view) that lands under the low-water mark — `low` of the ROOM
  // the injected system blocks leave under the limit, not of the whole limit.
  const target = sizes.system + low * (limit - sizes.system)
  for (let next = Math.max(cut + 1, 1); next <= steps - 1; next++)
    for (const view of [viewCap(), 8_000, 2_000, 0]) if (size(next, view) <= target) return { head, cut: next, view }
  return steps > 1 ? { head, cut: steps - 1, view: 0 } : { head, cut: 0, view: held.view }
}

// The step fold the gate needs: the most steps kept verbatim and the largest workspace view that fit, tried
// on a copy so the live window is folded once. undefined when the window already fits or nothing can fold.
export const gateStepPlan = (messages: Msg[], fixed: number, from: number) => {
  const gate = gateChars()
  if (!(gate > 0) || contextChars(messages) + fixed <= gate) return undefined
  const keeps = [...new Set([from, 4, 2, 1].filter((k) => k > 0 && k <= Math.max(from, 4)))].sort((a, b) => b - a)
  let last: { keep: number; plan: NonNullable<ReturnType<typeof stepPlan>> } | undefined
  for (const keep of keeps)
    for (const view of [viewCap(), 8_000, 2_000, 0]) {
      const plan = stepPlan(messages, keep, view)
      if (!plan) continue
      last = { keep, plan }
      const trial = structuredClone(messages)
      stepApply(trial, plan, keep)
      if (contextChars(trial) + fixed <= gate) return last
    }
  return last
}

const clipToFit = (text: string, keep: number, handle?: string) =>
  text.length <= keep
    ? text
    : `${text.slice(0, keep)}\n[fold: ${(text.length - keep).toLocaleString()} of ${text.length.toLocaleString()} chars cut to fit the window. This is a cut of the same output, not a new one; ${handle ? `snip ${handle} returns all of it` : "read with an offset for the rest"}.]`

const isNewAsk = (messages: SessionHooks["context"]["messages"]) => messages.at(-1)?.role === "user"

// Event payloads are trimmed before they leave the process: the record needs the
// shape of a turn (which tools, in what order, how it ended), not its bytes.
const clip = (value: unknown, max = 2000) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""
  return text.length > max ? `${text.slice(0, max)}…[${text.length - max} more]` : text
}

// The door reads a tool's IDENTITY — which file, which command — never its bytes. The input is
// forwarded as a small object with the addressing fields clipped: a large write's content never
// rides, and the door never has to parse a string that clip cut mid-token (a truncated string is
// not JSON, which made every mechanical claim silently unfireable). A non-object value still
// rides the old clip for compatibility; the door parses strings where it can.
const TOOL_SHAPE_KEYS = ["filePath", "file_path", "path", "file", "command", "cmd"] as const
const toolShape = (value: unknown) => {
  if (!value || typeof value !== "object") return clip(value, 1000)
  const input = value as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const key of TOOL_SHAPE_KEYS) {
    const field = input[key]
    if (typeof field === "string") out[key] = clip(field, 1000)
  }
  return out
}

type Observed = Stream.Success<ReturnType<Context["event"]["subscribe"]>>

const forward = (event: Observed) => {
  switch (event.type) {
    case "session.step.started":
      return { assistantMessageID: event.data.assistantMessageID, model: event.data.model, agent: event.data.agent }
    case "session.step.ended":
      return {
        assistantMessageID: event.data.assistantMessageID,
        finish: event.data.finish,
        cost: event.data.cost,
        tokens: event.data.tokens,
      }
    case "session.tool.input.started":
      return { id: event.data.id, name: event.data.name }
    case "session.tool.called":
      return { id: event.data.id, input: toolShape(event.data.input), executed: event.data.executed }
    case "session.tool.success":
      return { id: event.data.id, ok: true, executed: event.data.executed, output: clip(event.data.content, 1000) }
    case "session.tool.failed":
      return { id: event.data.id, ok: false, executed: event.data.executed, error: clip(event.data.error, 500) }
    case "session.text.ended":
      return { assistantMessageID: event.data.assistantMessageID, text: clip(event.data.text, 4000) }
    case "session.execution.started":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return {}
    default:
      return undefined
  }
}

// Full bytes for shadow capture — the opposite of forward(): no clipping,
// because the lint trial scores drafts, not shapes. Only kinds the trial
// reads; everything else rides nothing.
const shadowOf = (event: Observed) => {
  switch (event.type) {
    case "session.text.ended":
      return typeof event.data.text === "string" && event.data.text.length > 0
        ? { kind: "draft-text", name: "", text: event.data.text }
        : undefined
    case "session.tool.called":
      return { kind: "tool-io", name: `called:${String(event.data.id ?? "?")}`, text: JSON.stringify(event.data.input) ?? "" }
    case "session.tool.success":
      return { kind: "tool-io", name: `ok:${String(event.data.id ?? "?")}`, text: JSON.stringify(event.data.content) ?? "" }
    case "session.tool.failed":
      return { kind: "tool-io", name: `err:${String(event.data.id ?? "?")}`, text: JSON.stringify(event.data.error) ?? "" }
    default:
      return undefined
  }
}

// The text a tool result carries, when it is text. Structured JSON results and
// errors are left alone: those are the shapes a model debugs.
const foldable = (part: SessionHooks["context"]["messages"][number]["content"][number]) => {
  if (part.type !== "tool-result") return undefined
  const text =
    part.result.type === "text"
      ? typeof part.result.value === "string"
        ? part.result.value
        : undefined
      : part.result.type === "content" &&
          part.result.value.every((item) => item.type === "text") &&
          part.result.value.length > 0
        ? part.result.value.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
        : undefined
  if (text === undefined) return undefined
  return { text, id: part.id, name: part.name }
}

// STIGMERGIC PARAPHRASE — the trail mark a kept-out result leaves behind. Mechanical, model-free: counts, the
// first line, and the structure the bytes themselves declare (markdown headings, else top-level symbols). The
// next reader learns what was here without a snip, and snips only when the gist says the bytes matter.
export const trailGist = (text: string, key = "") => {
  const lines = text.split("\n")
  const first = lines.find((l) => l.trim().length > 0)?.trim().slice(0, 120) ?? ""
  const heads = lines.filter((l) => /^\s*(?:\d+:\s*)?#{1,4}\s+\S/.test(l)).map((l) => l.replace(/^\s*(?:\d+:\s*)?/, "").trim().slice(0, 60))
  const syms = heads.length
    ? heads
    : lines.flatMap((l) => {
        const m = /^\s*(?:\d+:\s*)?(?:export\s+)?(?:async\s+)?(?:function|class|const|def|interface|type)\s+([A-Za-z_$][\w$]*)/.exec(l)
        return m ? [m[1]] : []
      })
  const shown = syms.slice(0, 8)
  return [
    key ? `of ${key}` : "",
    `${lines.length} lines`,
    first ? `starts "${first}"` : "",
    shown.length ? `${heads.length ? "headings" : "symbols"}: ${shown.join(" | ")}${syms.length > shown.length ? ` +${syms.length - shown.length}` : ""}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

// Replace the results the door pointed at with a kept-out stub + mechanical gist. `held` results are never
// replaced for the first time: the model must read what it just asked for (see trailMessages).
export const trailApply = (
  messages: SessionHooks["context"]["messages"],
  point: Map<string, string>,
  done: Map<string, string>,
  store: Map<string, string>,
  keyOf: Map<string, string>,
  held: (target: { id: string; name?: string }) => boolean,
) => {
  for (const [index, message] of messages.entries()) {
    let changed = false
    const content = message.content.map((part) => {
      const target = foldable(part)
      const handle = target ? point.get(target.id) : undefined
      if (!target || !handle || (held(target) && !done.has(target.id)) || (target.text.startsWith("[") && target.text.includes("kept out; SNIP"))) return part
      store.set(handle, target.text)
      done.set(target.id, handle)
      changed = true
      return { ...part, result: { type: "text" as const, value: `[${target.text.length} chars kept out; SNIP ${handle}] gist (mechanical): ${trailGist(target.text, keyOf.get(target.id))}` } }
    })
    if (changed)
      messages[index] = Message.make({ id: message.id, role: message.role, content, metadata: message.metadata, providerMetadata: message.providerMetadata, native: message.native })
  }
}

// A file span the model can name without the door: `path#L10-L20`, `path#L5`, `path#120-340` (bytes). Read straight
// from disk, so a door outage never strands a snip of a file (measured: with the door down, two snips failed and the
// model re-read the same README until the repeated-action guard closed the turn). undefined when the ref is not a span.
export const localSpan = (ref: string, workspace = process.cwd()) => {
  const m = /^(.+?)#(L)?(\d+)(?:-L?(\d+))?$/.exec(ref.trim())
  if (!m) return undefined
  const [, raw, isLine, a, b] = m
  const file = path.resolve(workspace, raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : raw)
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  const from = Number(a)
  const to = b === undefined ? from : Number(b)
  if (isLine) {
    const lines = text.split("\n").slice(Math.max(0, from - 1), Math.max(from, to))
    return { file, range: `L${from}-L${to}`, bytes: lines.map((line, i) => `${from + i}: ${line}`).join("\n") }
  }
  return { file, range: `${from}-${to}`, bytes: text.slice(from, to) }
}

const formatMeter = (meter: Record<string, unknown>) => {
  const savings = (meter.savings ?? {}) as Record<string, unknown>
  const num = (value: unknown) => (typeof value === "number" ? value : 0)
  const first = (meter.firstAsks ?? {}) as Record<string, unknown>
  const repeats = (meter.repeatAsks ?? {}) as Record<string, unknown>
  return [
    `fold savings · since ${String(savings.since ?? "?")}`,
    `kept out of the frontier: ${num(savings.projectedChars).toLocaleString()} chars ≈ ${num(savings.projectedTokensEst).toLocaleString()} tokens (projections ${num(savings.projections)})`,
    `titles served by rule: ${num(meter.titlesServedLocally)} ≈ ${num(savings.titleTokensEst).toLocaleString()} frontier tokens avoided`,
    `estimated saved: ${money(num(savings.savedUSD))} (${String(savings.note ?? "")})`,
    `frontier bought: ${num(meter.turns)} turns · first ${num(first.n)} (${num(first.tokens).toLocaleString()} tok) · repeats ${num(repeats.n)}, ${num(repeats.recalled)} recalled`,
    `meter: ${base}/v1/hooks/opencode/meter`,
  ].join("\n")
}

const short = (value: unknown, max = 400) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max}]` : text
}

// How the last turns were prompted, disclosed: the recall note the door
// injected, the addresses it pointed the ask at, the title it derived by rule,
// and the cut it made (dropped / kept / the record that stood in). This is the
// doorway's own bookkeeping — never the model's words.
const formatAudit = (audit: Record<string, unknown>) => {
  const turns = Array.isArray(audit.turns) ? (audit.turns as Array<Record<string, unknown>>) : []
  if (turns.length === 0) return `fold audit · no turns recorded yet · ${base}/v1/hooks/opencode/audit`
  const row = (turn: Record<string, unknown>, index: number) =>
    [
      `${turns.length - index}. ${short(turn.ask, 160)}`,
      `   address ${String(turn.address ?? "?")} · ${turn.repeat ? `repeat ×${String(turn.repeat)}` : "first ask"} · ${turn.settled ? "settled" : "open"}`,
      `   recall  ${turn.recall ? short(turn.recall) : "—"}`,
      `   look    ${turn.look ? short(turn.look) : "—"}`,
      `   cut     ${turn.project ? short(turn.project) : "—"}`,
      `   title   ${turn.title ? short(turn.title, 120) : "—"}`,
    ].join("\n")
  return [
    `fold audit · last ${turns.length} turn(s) · read at ${base}/v1/hooks/opencode/audit`,
    ...turns.map(row),
  ].join("\n\n")
}

// THE FACING PAGE, on the output. The door types every sentence of a finished answer mechanically
// (groundCheck): [S# ref] = the sentence shares its content with a witnessed span or a settled one,
// [M] = the mouth's own prose (no source shares it). Flags are the verifiable failures the door can
// catch (unknown_path, unverified_pass). This renders the typing; it never edits the model's words
// and never scores them as truth — the label is about provenance, not correctness.
const facingNote = (answer: Record<string, unknown> | undefined): string => {
  const g = answer as
    | {
        sentences?: Array<{ text?: string; type?: string; ref?: string }>
        flags?: Array<{ kind?: string; detail?: string; cell?: string }>
        summary?: Record<string, number>
        standing?: { cell?: string; meaning?: string; watched?: string[] }
        step?: {
          output?: string
          superseded?: string | null
          ground_trace?: Array<{ text?: string; ground?: string; ref?: string | null }>
          lane?: string
          disclosure?: string
        }
      }
    | undefined
  const sentences = Array.isArray(g?.sentences) ? g.sentences : []
  if (sentences.length === 0) return ""
  const tag = (s: { type?: string; ref?: string }, i: number) =>
    s.type === "grounded" ? `[S${i + 1} ${String(s.ref ?? "?")}]` : s.type === "asserted" ? `[S${i + 1} ${String(s.ref ?? "?")}·asserted]` : "[M]"
  const lines = sentences.map((s, i) => `${tag(s, i)} ${short(s.text, 200)}`)
  const flags = Array.isArray(g?.flags) ? g.flags : []
  const sum = g?.summary
  const head = sum
    ? `fold facing · ${sum.grounded ?? 0} grounded · ${sum.asserted ?? 0} asserted · ${sum.selfModel ?? 0} self · ${sum.flagged ?? 0} flagged`
    : `fold facing · ${sentences.length} sentence(s)`
  // the standing cube: which cell this reply's claim stands at (EVA·Figure for a clean figure,
  // EVA·Pattern once flags fire), with the nulls the reading watched for.
  const st = g?.standing
  const where = st?.cell ? `standing · ${st.cell}${st.watched?.length ? ` — watched ${st.watched.join(", ")}` : ""}` : ""
  const flagLines = flags.map((f) => `⚠ ${String(f.kind ?? "flag")}${f.cell ? ` → ${f.cell}` : ""}: ${short(f.detail, 120)}`)
  // THE SECOND VERSION: the model's finished text as one step — each sentence
  // typed against the ground ([S address] = rests on a fact; [M] = the mouth's
  // own), and, when a mechanism settled the ask, the draw the machine outweighed.
  const step = g?.step
  const stepLines = step
    ? [
        `── the ground — the model's text is one step ──`,
        ...(step.ground_trace ?? []).map((s) =>
          s.ground === "material" ? `[S ${String(s.ref ?? "?")}] ${short(s.text, 200)}` : `[M] ${short(s.text, 200)}`,
        ),
        ...(step.superseded ? [`[superseded] the machine settled this — the model's draw was: ${short(step.superseded, 200)}`] : []),
      ]
    : []
  if (facingLevel === "off") return ""
  if (facingLevel === "line") return [head, where].filter(Boolean).join("\n")
  if (facingLevel === "standing") return [where, ...flagLines].filter(Boolean).join("\n")
  return [head, where, ...lines, ...stepLines, ...flagLines].filter(Boolean).join("\n")
}

export const Plugin = define({
  id: "fold.doorway",
  effect: Effect.fn(function* (ctx) {
    if (off) return

    // The price of the model actually in use, from the operator's own catalog;
    // sent with each fold so the door's dollars are the running model's dollars.
    let prices = new Map<string, { input: number; read: number; write: number }>()
    yield* ctx.model.transform((editor) => {
      prices = new Map(
        editor.list().flatMap((model) =>
          model.cost.length > 0
            ? [
                [
                  `${model.providerID}/${model.id}`,
                  { input: model.cost[0].input, read: model.cost[0].cache.read, write: model.cost[0].cache.write },
                ] as const,
              ]
            : [],
        ),
      )
    })
    const priceIn = (model: { providerID: string; id: string }) => prices.get(`${model.providerID}/${model.id}`)?.input
    // The cache prices let the door price a cut against the cached prefix it would burn; the door decides.
    const priceCache = (model: { providerID: string; id: string }) => {
      const price = prices.get(`${model.providerID}/${model.id}`)
      return { priceCacheRead: price?.read, priceCacheWrite: price?.write }
    }

    // WEB SEARCH, NATIVELY. Registered the way opencode's own search providers are
    // (ctx.websearch.transform, the same transform the Exa/Tavily/… plugins use), but the
    // engine is this machine: heimdall's keyless /api/search — Brave then DuckDuckGo from the
    // operator's own address, no third-party key and no relay. It joins the built-in providers,
    // so the first search selects one (the upstream flow) and remembers it; the doorway never
    // forces a default, so an explicit choice always wins. FOLD_WEBSEARCH=0 removes it;
    // FOLD_HEIMDALL_URL picks the bridge (default :8790). Fails open: a down bridge is one
    // provider erroring, never a broken opencode.
    if (process.env.FOLD_WEBSEARCH !== "0") {
      const heimdall = (process.env.FOLD_HEIMDALL_URL ?? process.env.HEIMDALL_URL ?? "http://127.0.0.1:8790").replace(
        /\/+$/,
        "",
      )
      yield* ctx.websearch.transform((editor) => {
        editor.add({
          id: "this-machine",
          name: "This machine",
          execute: (input) =>
            Effect.gen(function* () {
              const response = yield* Effect.tryPromise(() =>
                fetch(`${heimdall}/api/search?${new URLSearchParams({ q: input.query })}`, {
                  signal: AbortSignal.timeout(20_000),
                }),
              )
              if (!response.ok) return yield* Effect.fail(new Error(`heimdall search answered ${response.status}`))
              const data = (yield* Effect.tryPromise(() => response.json())) as {
                results?: ReadonlyArray<{ url?: unknown; title?: unknown; snippet?: unknown }>
              }
              return (data.results ?? []).flatMap((item) =>
                typeof item.url === "string"
                  ? [
                      {
                        url: item.url,
                        ...(typeof item.title === "string" ? { title: item.title } : {}),
                        ...(typeof item.snippet === "string" ? { content: item.snippet } : {}),
                        time: {},
                      },
                    ]
                  : [],
              )
            }),
        })
      })
    }

    // The contract check: the fork speaks events the door's handshake lists.
    // A drifted door logs; it never blocks (everything here fails open).
    yield* Effect.tryPromise(async () => {
      const response = await fetch(`${base}/v1/hooks/opencode`, { signal: AbortSignal.timeout(3000) })
      return (await response.json()) as { door?: string; events?: string[] }
    }).pipe(
      Effect.tap((door) => {
        const events = door?.events ?? []
        const missing = ["context", "surf", "ground", "title", "perceive"].filter((event) => !events.includes(event))
        if (door?.door !== "opencode" || missing.length > 0)
          return Effect.logWarning("fold doorway speaks an older contract", { door: door?.door, missing, events })
        return Effect.void
      }),
      Effect.catch(() => Effect.void),
      Effect.ignore,
      Effect.forkScoped({ startImmediately: true }),
    )

    // Durable history keeps the raw tool result, so this must replace it on
    // every dispatch, not once: a part folds on its first appearance and the
    // cache then re-serves the same fold for the rest of the turn, with no
    // further door traffic. The cache is keyed by part id and scoped to the
    // session's plugin lifetime.
    const folded = new Map<string, string>()
    // trail: handle -> the exact bytes the tool returned (the durable session keeps them too); the ids already pointerized
    // per session (monotone: a stub never turns back into bytes, so the prompt prefix flips at most once per result);
    // when each session last asked, for the door's idle gate.
    const trailStore = new Map<string, string>()
    // The ledger's per-request window sizes, set by the context hook and taken by the usage tap.
    const windows = new Map<string, { before: number; after: number; tools: number }>()
    // The held step-fold cut per session (prefix-stable epochs, see stableStepCut).
    const stepEpochs = new Map<string, StepEpoch>()
    const trailDone = new Map<string, Map<string, string>>()
    const reopenCounts = new Map<string, number>()
    const lastCall = new Map<string, number>()

    // The precompute: a tool result is folded the moment it lands (event-time,
    // off the request path) and cached by part id; the context hook reads the
    // cache and only falls back to a cold door call when the fold has not landed
    // yet. Precompute posts with the full fold budget; the request path races it
    // against the small ask budget, so a slow door never stalls the turn — it
    // just sends the raw bytes this once.
    // The door RETIRED the `fold` event (the line-level fold measured equal to its null; the door answers `{}`).
    // The precompute is kept as a no-op so the call sites stay unchanged and no dead request rides each tool result.
    const foldOnce = (
      _sessionID: string,
      _tool: string,
      _ask: string,
      _model: { providerID: string; id: string } | undefined,
      _id: string,
      _text: string,
    ) => Promise.resolve<string | undefined>(undefined)
    const foldBudget = (promise: Promise<string | undefined>, ms: number) =>
      Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))])

    // The turn's ask and model, so an event-time fold knows what to fold toward,
    // and tool id -> name, so a result folded at event time is attributed to its tool.
    const lastAsk = new Map<string, string>()
    const lastNote = new Map<string, string>()
    const lastModel = new Map<string, { providerID: string; id: string }>()
    const toolNames = new Map<string, string>()

    // The task a session's marks belong to: FOLD_TASK when set, else the root
    // of its parent chain, so a tab's subagents share one worknotes directory
    // with no setup. Cached per session; any lookup failure falls back to the
    // session's own id (a private task), never blocking a turn.
    // The task is the PROJECT, resolved by the door from the session's workspace, so every agent
    // in one repository (subagents and separate tabs alike) shares one medium. An explicit
    // FOLD_TASK overrides. Session lookups never fail a turn: Session.get on an unknown id
    // raises a DEFECT, which Effect.catch does not see, so only "ses…" ids are looked up and the
    // whole cause is swallowed.
    const lookup = (id: string) =>
      id.startsWith("ses")
        ? ctx.session.get(id as never).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : Effect.succeed(undefined)
    const workspaces = new Map<string, string>()
    const workspaceOf = (sessionID: string) =>
      Effect.gen(function* () {
        const hit = workspaces.get(sessionID)
        if (hit) return hit
        const session = yield* lookup(sessionID)
        const dir = (session as { location?: { directory?: string } } | undefined)?.location?.directory ?? process.cwd()
        workspaces.set(sessionID, dir)
        return dir
      })
    const taskOf = (_sessionID: string) => Effect.succeed(process.env.FOLD_TASK || undefined)

    const foldMessages = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        if (debug) yield* Effect.logWarning("fold.scan", { sessionID: event.sessionID, messages: event.messages.length })
        for (const [index, message] of event.messages.entries()) {
          for (const part of message.content) {
            const target = foldable(part)
            if (!target) continue
            if (debug) yield* Effect.logWarning("fold.part", { id: target.id, chars: target.text.length })
            if (target.text.length < minChars) continue
            const cached = folded.get(target.id)
            const text =
              cached ??
              (yield* Effect.tryPromise(() =>
                foldBudget(
                  foldOnce(event.sessionID, target.name, lastUserText(event.messages), event.model, target.id, target.text),
                  askTimeout,
                ),
              ).pipe(Effect.catch(() => Effect.succeed(undefined))))
            if (typeof text !== "string" || text.length === 0) {
              if (debug) yield* Effect.logWarning("fold.skipped", { id: target.id })
              continue
            }
            if (cached === undefined) folded.set(target.id, text)
            const saved = target.text.length - text.length
            if (debug)
              yield* Effect.logWarning(cached === undefined ? "fold.applied" : "fold.reuse", {
                id: target.id,
                chars: target.text.length,
                saved,
              })
            const next = message.content.map((item) =>
              item === part
                ? {
                    ...item,
                    result: {
                      type: "text" as const,
                      value: `${text}\n\n[fold: ${saved} chars kept out of this context; the full output remains in the session]`,
                    },
                  }
                : item,
            )
            event.messages[index] = Message.make({
              id: message.id,
              role: message.role,
              content: next,
              metadata: message.metadata,
              providerMetadata: message.providerMetadata,
              native: message.native,
            })
          }
        }
      })

    // Local-first perception: user-attached and tool-returned media with a
    // local payload (inline base64/bytes, data: URLs) is transcribed by the
    // door's khora before the frontier sees it. Provider refs and remote URLs
    // carry no local payload and ride upstream untouched. An empty
    // transcription keeps the media (the frontier as fallback, never
    // blindness); a passthrough answer leaves the bytes identical. Cached by
    // content key for the session's plugin lifetime, like the fold cache.
    type Perceived = { text: string; replace: boolean } | null
    const perceived = new Map<string, Perceived>()

    const perceivableMime = (mime: string) => {
      const m = mime.toLowerCase()
      return m.startsWith("image/") || m.startsWith("audio/") || m === "application/pdf"
    }

    const inlineB64 = (source: { type?: string; data?: unknown } | undefined): string | undefined => {
      if (!source) return undefined
      if (source.type === "base64" && typeof source.data === "string") return source.data
      if (source.type === "bytes" && source.data instanceof Uint8Array)
        return Buffer.from(source.data).toString("base64")
      return undefined
    }

    const dataUrlB64 = (uri: string): string | undefined => {
      const match = /^data:[^;,]+;base64,(.+)$/s.exec(uri)
      return match ? match[1] : undefined
    }

    const perceiveKey = (mime: string, dataBase64: string) =>
      `perceive:${mime}:${dataBase64.length}:${dataBase64.slice(0, 64)}`

    const describeGaps = (gaps: Array<{ reason?: string }>) =>
      gaps.length > 0 ? ` [perception gaps: ${gaps.map((g) => g.reason ?? "?").join(", ")}]` : ""

    const perceiveOne = (key: string, mime: string, name: string, dataBase64: string, sessionID: string) =>
      Effect.gen(function* () {
        const hit = perceived.get(key)
        if (hit !== undefined) return hit
        const answer = yield* post({ event: "perceive", sessionID, mime, name, dataBase64 }, foldTimeout)
        const out = (answer ?? {}) as {
          passthrough?: boolean
          text?: unknown
          via?: unknown
          gap?: unknown
          gaps?: Array<{ reason?: string }>
          replaceMedia?: boolean
        }
        if (out.passthrough || typeof out.text !== "string" || out.text.length === 0) {
          if (debug) yield* Effect.logWarning("perceive.kept", { mime, name, via: out.via ?? out.gap ?? "passthrough" })
          perceived.set(key, null)
          return null
        }
        const via = typeof out.via === "string" ? out.via : "local"
        const gaps = Array.isArray(out.gaps) ? out.gaps : []
        const text = `[perceived locally via ${via} — ${name}]${describeGaps(gaps)}\n${out.text}`
        if (debug) yield* Effect.logWarning("perceive.applied", { mime, name, via, chars: out.text.length })
        const result = { text, replace: out.replaceMedia !== false }
        perceived.set(key, result)
        return result
      })

    const remake = (
      message: SessionHooks["context"]["messages"][number],
      content: SessionHooks["context"]["messages"][number]["content"],
    ) =>
      Message.make({
        id: message.id,
        role: message.role,
        content: content as typeof message.content,
        metadata: message.metadata,
        providerMetadata: message.providerMetadata,
        native: message.native,
      })

    const perceiveMessages = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        if (off || perceiveOff || Date.now() < downUntil) return
        for (const [index, message] of event.messages.entries()) {
          let content = message.content
          let changed = false
          for (const [partIndex, part] of content.entries()) {
            if (message.role === "user" && part.type === "media") {
              const media = part.media as { mediaType?: string; source?: { type?: string; data?: unknown } }
              const mime = media.mediaType ?? ""
              if (!perceivableMime(mime)) continue
              const dataBase64 = inlineB64(media.source)
              if (!dataBase64) continue
              const name = (part as { filename?: string }).filename ?? "attachment"
              const result = yield* perceiveOne(perceiveKey(mime, dataBase64), mime, name, dataBase64, event.sessionID)
              if (!result) continue
              const next = content.slice()
              next[partIndex] = result.replace
                ? ({ type: "text", text: result.text } as typeof content[number])
                : part
              if (!result.replace) next.splice(partIndex + 1, 0, { type: "text", text: result.text } as typeof content[number])
              content = next
              changed = true
            } else if (part.type === "tool-result" && part.result.type === "content") {
              const value = part.result.value
              let items = value
              let itemsChanged = false
              for (const [itemIndex, item] of value.entries()) {
                if (item.type !== "file" || !perceivableMime(item.mime)) continue
                const dataBase64 = dataUrlB64(item.uri)
                if (!dataBase64) continue
                const result = yield* perceiveOne(
                  perceiveKey(item.mime, dataBase64),
                  item.mime,
                  item.name ?? "tool file",
                  dataBase64,
                  event.sessionID,
                )
                if (!result || !result.replace) {
                  if (result && !result.replace) {
                    const copy = items.slice()
                    copy.splice(itemIndex + 1, 0, { type: "text", text: result.text })
                    items = copy
                    itemsChanged = true
                  }
                  continue
                }
                const copy = items.slice()
                copy[itemIndex] = { type: "text", text: result.text }
                items = copy
                itemsChanged = true
              }
              if (!itemsChanged) continue
              const next = content.slice()
              next[partIndex] = { ...part, result: { ...part.result, value: items } }
              content = next
              changed = true
            }
          }
          if (changed) event.messages[index] = remake(message, content)
        }
      })

    const trailMessages = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const now = Date.now()
        const idleMs = now - (lastCall.get(event.sessionID) ?? now)
        lastCall.set(event.sessionID, now)
        const done = trailDone.get(event.sessionID) ?? new Map<string, string>()
        trailDone.set(event.sessionID, done)
        // what each result is ABOUT: the path (or pattern/command) its call named
        const keyOf = new Map<string, string>()
        const results: Array<{ id: string; key: string; step: number }> = []
        // The model must read what it just asked for. A `snip` answer is a recovery, and the newest tool result is the
        // one the model has not yet acted on: pointerizing either hands back a handle for a handle, so the model
        // snips again, gets a stub again, and re-reads in a loop (measured: one 113-line PLAN.md, ~20 snips).
        const newest = event.messages.flatMap((m) => m.content).findLast((part) => foldable(part) !== undefined)
        const held = (target: { id: string; name?: string }) => target.name === "snip" || target.id === (newest as { id?: string } | undefined)?.id
        let step = 0
        for (const message of event.messages) {
          if (message.role === "user" && message.content.some((part) => part.type === "text")) step++
          for (const part of message.content) {
            if (part.type === "tool-call") {
              const input = (part.input ?? {}) as Record<string, unknown>
              const arg = input.filePath ?? input.path ?? input.file ?? input.pattern ?? input.command ?? input.url ?? ""
              keyOf.set(part.id, `${part.name}:${String(arg).slice(0, 200)}`)
            }
            const target = foldable(part)
            if (target && !held(target) && target.text.length >= trailMinChars) results.push({ id: target.id, key: keyOf.get(target.id) ?? `${target.name}:${target.id}`, step })
          }
        }
        if (!results.length && done.size === 0) return
        // a result already pointerized stays pointerized on every later call; new ones only when the door says go
        let point = new Map<string, string>(done)
        const tokens = Math.round(event.messages.reduce((n, m) => n + m.content.reduce((k, p) => k + (p.type === "text" ? p.text.length : p.type === "tool-result" ? JSON.stringify(p.result).length : 0), 0), 0) / 4)
        const answer = yield* post({ event: "trail", sessionID: event.sessionID, results, already: [...done.keys()], idleMs, tokens, window: 200_000 }, askTimeout)
        if (answer?.go === true && answer.point && typeof answer.point === "object") for (const [id, handle] of Object.entries(answer.point as Record<string, string>)) if (!point.has(id)) point.set(id, String(handle))
        if (point.size === 0) return
        trailApply(event.messages, point, done, trailStore, keyOf, held)
      })

    const context = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        // THE NOTICES ARE OUTPUT, NEVER INPUT. A `synthetic` notice still rides in the session, so a fold
        // notice rendered for the PERSON (facing, chase, matrix, view, savings, audit) is stripped here before
        // anything is sent — otherwise the model ANSWERS the notice itself. Measured without this: over two
        // turns the model replied to the facing text and the window inflated to 219k tokens.
        for (let i = event.messages.length - 1; i >= 0; i--) {
          const text = event.messages[i].content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
          if (isPersonNotice(text)) event.messages.splice(i, 1)
        }
        // THE LEDGER'S "BEFORE": the window exactly as the harness assembled it (messages + system), after our own
        // notices are stripped. Everything the fold changes from here on is measured against this number; the
        // tap (usage-tap.ts) joins it to the provider's own token count for the request that follows.
        const windowBefore = contextChars(event.messages) + systemChars(event.system)
        // Remember the turn's ask and model so a tool result that lands mid-turn
        // can be folded at event time without re-reading the message list.
        lastAsk.set(event.sessionID, lastUserText(event.messages))
        lastModel.set(event.sessionID, event.model)
        // Perception first: media becomes local transcription before recall
        // or folding reads the turn, so everything downstream sees text.
        yield* perceiveMessages(event)
        // The recall and the fold both knock on the door; the recall first, so
        // the turn exists before any fold can be attributed to it.
        if (isNewAsk(event.messages)) {
          const workspace = yield* workspaceOf(event.sessionID)
          const answer = yield* post(
            {
              event: "context",
              sessionID: event.sessionID,
              model: event.model,
              agent: event.agent,
              ask: lastUserText(event.messages),
              messages: event.messages.length,
              tools: Object.keys(event.tools),
              workspace,
              task: process.env.FOLD_TASK || undefined,
              turns: priorTurns(event.messages),
            },
            askTimeout,
          )
          const note = answer?.system
          if (typeof note === "string" && note.length > 0) event.system.push({ type: "text", text: note })
          // The project's commons: what the other agents here have settled, already ingested and
          // projected through Houdini by the door against this ask.
          const commons = answer?.commons
          if (typeof commons === "string" && commons.length > 0) event.system.push({ type: "text", text: commons })
          // The swarm's learning: what the ants already measured on this task, injected when
          // the ask's own words bear on it. Mechanical read of the door's own marks; the fork
          // carries no swarm logic and injects the note only when it arrives.
          const swarm = answer?.swarm
          if (typeof swarm === "string" && swarm.length > 0) event.system.push({ type: "text", text: swarm })
          // Step 1 of the doorway plan: the archon ground note rides only
          // when the door computed and injected it (FOLD_ARCHONS=1 on the
          // door; default is shadow — recorded, never injected). The fork
          // carries no archon logic; the note arrives credited or not at all.
          const archons = answer?.archons as { note?: unknown } | undefined
          if (archons && typeof archons.note === "string" && archons.note.length > 0)
            event.system.push({ type: "text", text: archons.note })
          // The power of openness: the AntiStrauss plain-reading teaching the door
          // injects into every turn by default (honesty, humility, knowing yourself).
          // The fork carries no openness logic; the note arrives grounded or not at all.
          const openness = answer?.openness as { note?: unknown } | undefined
          if (openness && typeof openness.note === "string" && openness.note.length > 0)
            event.system.push({ type: "text", text: openness.note })
          // Memory: the operator's standing facts (which repo is canonical, which
          // account publishes) the ask bears on, from ~/.config/opencode/user-memory.md.
          // The door decides by mechanical word overlap; the fork carries no memory
          // logic and injects the note only when it arrives.
          const memory = answer?.memory
          if (typeof memory === "string" && memory.length > 0) event.system.push({ type: "text", text: memory })
          // Refs: addresses the operator gave the system access to (the Remember
          // window's store), injected when the ask's own words bear on one. The
          // source is named; its bytes are read on demand (the snip tool), never
          // carried here. The door matches mechanically; the fork injects.
          const refs = answer?.refs
          if (typeof refs === "string" && refs.length > 0) event.system.push({ type: "text", text: refs })
          // System: standing prompt text the operator attached to asks like this
          // one, injected only when it bears — never every prompt.
          const systemPrompt = answer?.systemPrompt
          if (typeof systemPrompt === "string" && systemPrompt.length > 0)
            event.system.push({ type: "text", text: systemPrompt })
          // The lane: the door's reason-gate classification of THIS ask plus the language
          // leg's grounding disclosure (opencode-lane.mjs). Injected only when it arrives —
          // the fork carries no gate logic. It tells the frontier which II.9 lane it is in
          // and how strong the grounding is, so a creative or casual turn is not confused
          // with a claim about the world.
          const lane = answer?.lane
          if (typeof lane === "string" && lane.length > 0) event.system.push({ type: "text", text: lane })
        }
        // Surf: the window must not grow per prompt. The door's ladder (figure /
        // kind / pattern, each line addressed) answers; with it down, local
        // truncation does, so growth is bounded either way.
        let folded = false
        let proj = ""
        const turnCount = event.messages.filter((m) => m.role === "user").length
        const prevNote = lastNote.get(event.sessionID) ?? ""
        const grainSignals: GrainSignals = {
          reopenCount: reopenCounts.get(event.sessionID) ?? 0,
          pointerCount: trailDone.get(event.sessionID)?.size ?? 0,
          scentWarm: prevNote.includes("<fold-trail>"),
        }
        const effectiveKeep = grainKeepTurns(keepTurns, grainSignals, turnCount)
        const plan = surfPlan(event.messages, effectiveKeep)
        if (plan) {
          const task = yield* taskOf(event.sessionID)
          const workspace = yield* workspaceOf(event.sessionID)
          // The chars this cut keeps out of the request, measured on the messages
          // it is about to splice away, so the door's savings ledger (and the
          // titlebar tally) report the real reduction, not only the title calls.
          const keptOutChars = JSON.stringify(event.messages.slice(0, plan.cut)).length
          // THE FLOOR: the door's answer never decides whether the window is trimmed. The post is bounded by a
          // HARD client timeout, so a wedged door (accepts the connection, never answers) resolves to
          // `undefined` and the cut below still runs. The door supplies the NOTE; the CLIENT holds the window
          // flat — the window floor must not depend on the door.
          const answer = yield* post(
            { event: "surf", sessionID: event.sessionID, task, workspace, universe: process.env.FOLD_UNIVERSE ?? "world", ask: lastUserText(event.messages), turns: plan.turns, keptOutChars, priceIn: priceIn(event.model), ...priceCache(event.model) },
            askTimeout,
          ).pipe(Effect.timeout(askTimeout + 100), Effect.catch(() => Effect.succeed(undefined)))
          // not cut when the history is shorter than its own ladder, or when the door's cost gate prices the cut above
          // the cached prefix it would burn (the door says `uncut`): the turns stay, only the note rides
          const fromDoor = typeof answer?.note === "string" && answer.note.length > 0
          const noteText = fromDoor ? (answer.note as string) : surfLocal(plan.turns, lastUserText(event.messages))
          if (answer?.uncut === true) {
            if (fromDoor)
              event.system.push({
                type: "text",
                text: foldIndex(
                  { grain: "turn", from: `${plan.turns.length} earlier turn(s)`, for: "the current ask", made: "fold ladder (door, uncut)" },
                  answer.note as string,
                ),
              })
            folded = fromDoor
            proj = fromDoor ? noteText : ""
          } else {
            surfApply(event.messages, plan.cut, noteText, fromDoor ? "fold ladder (door)" : "fold surf (local)", plan.turns.length)
            folded = true
            proj = noteText
          }
        }
        // Step fold: inside one long turn, older whole steps leave the window as addressed receipts + the workspace view
        const stepSignals: GrainSignals = {
          reopenCount: reopenCounts.get(event.sessionID) ?? 0,
          pointerCount: trailDone.get(event.sessionID)?.size ?? 0,
        }
        const fixed = toolChars(event.tools) + systemChars(event.system)
        const grainKeep = grainKeepSteps(stepKeep(), stepSignals, event.messages.length)
        // THE GATE first. Default: the prefix-stable epoch (stableStepCut). FOLD_STABLE=0 restores the
        // per-request fold (most steps that fit, recomputed every request), kept for the A/B.
        const stable = process.env.FOLD_STABLE !== "0"
        const epoch = stable
          ? stableStepCut(event.messages, { tools: toolChars(event.tools), system: systemChars(event.system) }, stepEpochs.get(event.sessionID))
          : undefined
        if (epoch) stepEpochs.set(event.sessionID, epoch)
        const stepCount = event.messages.slice(event.messages.findLastIndex((m) => m.role === "user" && m.content.some((p) => p.type === "text")) + 1).filter((m) => m.role === "assistant").length
        const gated = stable
          ? epoch && epoch.cut > 0
            ? { keep: stepCount - epoch.cut, plan: stepPlan(event.messages, stepCount - epoch.cut, epoch.view) }
            : undefined
          : gateStepPlan(event.messages, fixed, grainKeep || 4)
        const effectiveStepKeep = gated?.keep ?? (stable ? 0 : grainKeep)
        const stepsPlan = gated?.plan ?? (stable ? undefined : stepPlan(event.messages, effectiveStepKeep))
        if (stepsPlan) {
          stepApply(event.messages, stepsPlan, effectiveStepKeep, trailStore)
          folded = true
          proj += `${proj ? "\\n" : ""}${stepNote(stepsPlan, effectiveStepKeep)}` // L1: disclose the step receipts too
        }
        // L1 DISCLOSURE: exactly the projection this turn was handed, kept so event:prompt can reveal it.
        if (folded) lastNote.set(event.sessionID, proj)
        // THE LEGEND, once, only when a projection was injected — the frontier's schema for the blocks above.
        if (folded && process.env.FOLD_LEGEND !== "0") event.system.push({ type: "text", text: FOLD_LEGEND })
        yield* foldMessages(event)
        if (trailOn) yield* trailMessages(event)
        // THE HARD CAP: after every fold, the frontier's window is bounded absolutely (FOLD_MAX_CHARS).
        capContext(event.messages, event.system, { fixed: toolChars(event.tools), store: trailStore })
        // THE LEDGER'S "AFTER": what is actually sent. before - after is what the fold kept out (negative when
        // the notes it added cost more than they removed). `tools` is what the definitions weigh, measured the
        // same way, so a later change that sends fewer tools shows up as its own line.
        windows.set(event.sessionID, { before: windowBefore, after: contextChars(event.messages) + systemChars(event.system), tools: toolChars(event.tools) })
      })

    const title = (event: SessionHooks["title"]) =>
      Effect.gen(function* () {
        const answer = yield* post(
          {
            event: "title",
            sessionID: event.sessionID,
            model: event.model,
            ask: lastUserText(event.messages),
            priceIn: priceIn(event.model),
          },
          askTimeout * 4,
        )
        const result = answer?.title
        if (typeof result === "string" && result.trim().length > 0) event.result = result.trim()
      })

    yield* ctx.command.transform((editor) => {
      editor.add({
        name: "fold",
        description:
          "fold savings (`/fold`), how this turn was prompted (`/fold audit`), a verified fill of the project's stubs (`/fold chase <test command>`), or the resumable record (`/fold matrix|drive [login|pull|push|logout]`; matrix login takes <homeserver> <user>)",
        execute: (input) => {
          // CHASE: the door runs the DEF->EVA->REC void loop over this session's directory,
          // judged only by the declared test command's exit code. Green draws become EOT
          // blocks in the session's task record (shared with its subagents); red draws are
          // reverted on disk. The door must have FOLD_REC_EXEC=1; otherwise it refuses.
          const chase = /^\s*(?:\/fold\s+)?chase\s+([\s\S]+?)\s*$/i.exec(input.prompt.text)
          if (chase) {
            const testCommand = chase[1]
            return Effect.gen(function* () {
              const task = yield* taskOf(input.sessionID)
              const session = yield* lookup(input.sessionID)
              const workspace = (session as { location?: { directory?: string } } | undefined)?.location?.directory ?? process.cwd()
              const answer = yield* post(
                { event: "chase", sessionID: input.sessionID, agent: input.sessionID, task, workspace, testCommand, ask: `make \`${testCommand}\` pass by filling the stubs` },
                280_000,
              )
              const rounds = Array.isArray(answer?.rounds) ? (answer.rounds as Array<Record<string, unknown>>) : []
              const record = Array.isArray(answer?.record) ? (answer.record as Array<Record<string, unknown>>) : []
              const text =
                answer === undefined
                  ? `fold chase: door unreachable at ${base}`
                  : answer.ok !== true
                    ? `fold chase refused: ${String(answer.gap ?? "unknown")}${answer.gap === "exec-disabled" ? " (start the door with FOLD_REC_EXEC=1)" : ""}`
                    : [
                        `fold chase ${answer.done ? "green" : `not green${answer.gap ? ` (${String(answer.gap)})` : ""}`} · ${rounds.length} round(s) · workspace ${workspace}`,
                        ...rounds.flatMap((r) =>
                          r.target
                            ? [`- ${String(r.target)}: ${r.reverted ? "reverted" : r.testExitCode === 0 ? "kept" : "carried"} (exit ${String(r.testExitCode)})`]
                            : [],
                        ),
                        `record (${record.length}): ${record.map((b) => String(b.referent)).join(", ") || "—"}`,
                      ].join("\n")
              yield* ctx.session.synthetic({
                sessionID: input.sessionID,
                text,
                description: "fold chase — verified fill, judged by the real test",
                resume: false,
              })
            }).pipe(Effect.ignore)
          }
          // The Matrix record (khora fold-matrix.mjs): the door keeps every settled turn as
          // sealed EODB events in the account's room, so logging in on another machine resumes
          // the fold. The password is never typed here — it would persist in the transcript;
          // the door reads it from FOLD_MATRIX_PASSWORD on its own side.
          const mx = /^\s*(?:\/fold\s+)?(matrix|drive)\b\s*(\S*)\s*(\S*)\s*(\S*)/i.exec(input.prompt.text)
          if (mx) {
            const [, where, act, a, b] = mx
            const verb = ["login", "pull", "push", "logout"].includes(act.toLowerCase()) ? act.toLowerCase() : "status"
            const post_ = verb !== "status"
            return Effect.gen(function* () {
              const data = yield* Effect.tryPromise(async () => {
                const response = await fetch(`${base}/v1/hooks/opencode/${where.toLowerCase()}/${verb}`, {
                  method: post_ ? "POST" : "GET",
                  headers: { "content-type": "application/json" },
                  body: post_ ? JSON.stringify(verb === "login" ? { base: a, user: b } : {}) : undefined,
                  signal: AbortSignal.timeout(30_000),
                })
                return (await response.json()) as Record<string, unknown>
              })
              yield* ctx.session.synthetic({
                sessionID: input.sessionID,
                text: `fold ${where.toLowerCase()} ${verb}\n${JSON.stringify(data, null, 2)}`,
                description: "fold matrix — the account's resumable record",
                resume: false,
              })
            }).pipe(
              Effect.catch(() =>
                ctx.session
                  .synthetic({
                    sessionID: input.sessionID,
                    text: `fold door unreachable at ${base} — matrix not reached`,
                    description: "fold door unreachable",
                    resume: false,
                  })
                  .pipe(Effect.ignore),
              ),
              Effect.ignore,
            )
          }
          // THE VIEW SWITCH: how much of the facing notice a reply carries — off · line · standing ·
          // full. A session norm; the typed spread is still recorded either way.
          const view = /^\s*(?:\/fold\s+)?(?:facing|layers|view)\b\s*(\S*)/i.exec(input.prompt.text)
          if (view) {
            const level = String(view[1] || "").toLowerCase()
            const known = ["off", "line", "standing", "full"]
            if (known.includes(level)) facingLevel = level
            return ctx.session
              .synthetic({
                sessionID: input.sessionID,
                text: `fold view — ${known.includes(level) ? `set to ${facingLevel}` : `now: ${facingLevel}`}\nlevels: off (nothing) · line (the count) · standing (the cell + flags) · full (the typed sentences too)`,
                description: "fold view — the layers on the answer",
                resume: false,
              })
              .pipe(Effect.ignore)
          }
          const audit = /\baudit\b/i.test(input.prompt.text)
          const url = `${base}/v1/hooks/opencode/${audit ? "audit" : "meter"}`
          return Effect.gen(function* () {
            const data = yield* Effect.tryPromise(async () => {
              const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
              if (!response.ok) throw new Error(`${url} ${response.status}`)
              return (await response.json()) as Record<string, unknown>
            })
            // A synthetic message WITH a description renders as its own notice
            // row — a block physically separate from the model's output, never
            // folded into the transcript's assistant text.
            yield* ctx.session.synthetic({
              sessionID: input.sessionID,
              text: audit ? formatAudit(data) : formatMeter(data),
              description: audit
                ? "fold audit — how this turn was prompted"
                : "fold savings — what the fold kept out of the frontier",
              resume: false,
            })
          }).pipe(
            Effect.catch(() =>
              ctx.session
                .synthetic({
                  sessionID: input.sessionID,
                  text: `fold door unreachable at ${base} — nothing folded, nothing saved`,
                  description: "fold door unreachable",
                  resume: false,
                })
                .pipe(Effect.ignore),
            ),
            Effect.ignore,
          )
        },
      })
    })

    // The EXACT assembled request, verbatim, so the audit discloses what the
    // frontier was actually prompted with. A clone is read (never the live
    // body) and the capture is detached, so it never delays the model request.
    // Nothing here is vectorized or ranked: it is the bytes sent.
    const capturePrompt = (event: SessionHooks["http.request"]) => {
      // Layer 0 ruler: where the bytes of this exact request are. Local file, independent of the door.
      if (rulerFile && event.kind === "primary")
        void event.request.clone().text().then((body) => rulerRecord(rulerFile, { sessionID: event.sessionID, model: event.model }, body)).catch(() => undefined)
      if (off || Date.now() < downUntil || event.kind !== "primary") return
      void event.request
        .clone()
        .text()
        .then((body) => {
          if (!body) return
          return fetch(`${base}/v1/hooks/opencode`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-er7-surface": "opencode" },
            body: JSON.stringify({ event: "prompt", sessionID: event.sessionID, model: event.model, body, note: lastNote.get(event.sessionID) ?? "" }),
            signal: AbortSignal.timeout(foldTimeout),
          }).then(
            () => undefined,
            () => undefined,
          )
        })
        .catch(() => undefined)
    }

    // ── the local senses, as tools any model can call ─────────────────────
    // A model never hears an audio and never sees a pixel: it calls a sense, which runs on this box, and reads the
    // text it returns as an EOT observation with a giver (provenance). No network for the sense itself.
    const ASR = (process.env.FOLD_ASR_URL ?? "http://127.0.0.1:11460").replace(/\/+$/, "")
    const observation = (text: string, giver: string, source: string) => ({
      output: { text, giver },
      content: text,
      metadata: { schema: "EOTObservation@1", id: `$sense-${Date.now().toString(36)}`, role: "part", giver, source, supersedes: [] },
    })

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "transcribe",
        options: { codemode: false },
        description:
          "Transcribe an audio file locally (whisper on this machine, no network — the audio never leaves the box). Returns an EOT observation: the words the waveform carried, with a giver. Read the text; you never hear the audio, and you must not add what it does not say.",
        input: Schema.Struct({
          path: Schema.String.annotate({ description: "Path to the audio file on this machine" }),
          language: Schema.optionalKey(Schema.String).annotate({ description: "ISO language code, or 'auto'" }),
          task: Schema.optionalKey(Schema.Literals(["transcribe", "translate"])).annotate({
            description: "transcribe (default) or translate the speech to English",
          }),
        }),
        output: Schema.Struct({ text: Schema.String, giver: Schema.String }),
        execute: (input) =>
          Effect.gen(function* () {
            const bytes = yield* Effect.tryPromise(() => Bun.file(input.path).arrayBuffer())
            const q = new URLSearchParams()
            if (input.language) q.set("language", input.language)
            if (input.task) q.set("task", input.task)
            const response = yield* Effect.tryPromise(() =>
              fetch(`${ASR}/transcribe?${q.toString()}`, {
                method: "POST",
                headers: { "content-type": "application/octet-stream" },
                body: bytes,
                signal: AbortSignal.timeout(120_000),
              }),
            )
            if (!response.ok)
              return yield* Effect.fail(new ToolFailure({ message: `whisper answered ${response.status} at ${ASR}` }))
            const data = (yield* Effect.tryPromise(() => response.json())) as { text?: unknown; model?: unknown }
            const text = typeof data.text === "string" ? data.text : ""
            return observation(text, `whisper ${typeof data.model === "string" ? data.model : "local"}`, input.path)
          }).pipe(Effect.mapError((error) => new ToolFailure({ message: "transcribe failed", error }))),
      }),
    )

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "perceive",
        options: { codemode: false },
        description:
          "Read an image locally through the local vision sense (image-khora OCR/pixel pipeline, or a local CV model — no frontier vision, no network). Returns an EOT observation: the measured card/fields with a giver. Read the text; you never receive a pixel, and you must not add a field the image does not show.",
        input: Schema.Struct({
          path: Schema.String.annotate({ description: "Path to the image on this machine" }),
        }),
        output: Schema.Struct({ text: Schema.String, giver: Schema.String }),
        execute: (input) =>
          Effect.gen(function* () {
            const response = yield* Effect.tryPromise(() =>
              fetch(`${base}/v1/perceive`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ path: input.path }),
                signal: AbortSignal.timeout(60_000),
              }),
            )
            if (!response.ok)
              return yield* Effect.fail(
                new ToolFailure({
                  message: `perceive answered ${response.status} at ${base} — is the local vision sense running?`,
                }),
              )
            const data = (yield* Effect.tryPromise(() => response.json())) as { text?: unknown; giver?: unknown }
            const text = typeof data.text === "string" ? data.text : ""
            return observation(text, typeof data.giver === "string" ? data.giver : "image-khora", input.path)
          }).pipe(Effect.mapError((error) => new ToolFailure({ message: "perceive failed", error }))),
      }),
    )

    // SNIP: the model composes by reference, the stack supplies the bytes. The description is the
    // whole prompt cost of this tool, so it is one line. The door resolves the address, logs the read
    // as a witnessed event, and says whether the bytes are witnessed (a file span, a test) or only
    // asserted (what another agent said). An unresolvable address is a typed gap, never a guess.
    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "snip",
        options: { codemode: false },
        description:
          "Exact bytes by address. Addresses: a step handle shown in a <fold-index grain=\"step\"> block (rs21xfd3a), a turn (turn 7), a path span (path#L10-L20 or path#120-340), a commons ref (8f3a2b1c#t3.s1), or any address shown in <fold-index>/<fold-commons>. Returns the verbatim bytes and their standing (mechanical = the system watched it, said = a model wrote it).",
        input: Schema.Struct({ ref: Schema.String.annotate({ description: "The address to resolve" }) }),
        output: Schema.Struct({ bytes: Schema.String, standing: Schema.String, from: Schema.String }),
        execute: (input, context) =>
          Effect.gen(function* () {
            const sessionID = String((context as { sessionID?: unknown }).sessionID ?? "")
            const workspace = yield* workspaceOf(sessionID)
            // an opaque trail handle is resolved here, from the bytes the tool returned; no door round trip
            if (/^r[0-9a-z]{4,16}$/.test(input.ref.trim())) {
              const kept = trailStore.get(input.ref.trim())
               if (kept === undefined) return yield* Effect.fail(new ToolFailure({ message: `snip: handle ${input.ref} is not held by this session (the full output remains in the session history)` }))
               reopenCounts.set(sessionID, (reopenCounts.get(sessionID) ?? 0) + 1)
              const head = `[snip ${input.ref} · from: tool result · standing: mechanical]\n`
              return { output: { bytes: kept, standing: "witnessed", from: "tool result" }, content: `${head}${kept}`, metadata: { schema: "EOTSnip@1", ref: input.ref, standing: "witnessed", from: "tool result", origin: "mechanical" } }
            }
            // THE MODEL ANSWERS; THE SYSTEM DOES THE STIGMERGY. The ask in front of the model rides along so the
            // door can record the tension MECHANICALLY — the model authors no motive, it just reads to answer.
            const answer = yield* post(
               { event: "snip", sessionID, agent: sessionID, workspace, universe: process.env.FOLD_UNIVERSE ?? "world", ref: input.ref, ask: lastAsk.get(sessionID) ?? "" },
              askTimeout * 4,
            )
            if (answer === undefined) {
              const local = localSpan(input.ref, workspace)
              if (local)
                return {
                  output: { bytes: local.bytes, standing: "witnessed", from: `${local.file} ${local.range}` },
                  content: `[snip ${input.ref} · from: ${local.file} ${local.range} · standing: mechanical · read from disk; the fold door is unreachable at ${base}]\n${local.bytes}`,
                  metadata: { schema: "EOTSnip@1", ref: input.ref, standing: "witnessed", from: local.file, origin: "mechanical" },
                }
              return yield* Effect.fail(
                new ToolFailure({
                  message: `snip: the fold door is unreachable at ${base}, so ${input.ref} cannot be resolved. Do not retry snip; for a file use read with offset/limit, otherwise proceed without it.`,
                }),
              )
            }
            if (answer.ok !== true)
              return yield* Effect.fail(new ToolFailure({ message: `snip ${String(answer.gap ?? "failed")}: ${input.ref}` }))
            const prov = (answer.provenance ?? {}) as Record<string, unknown>
            const from = [prov.kind, prov.file ?? prov.agent, prov.range ? JSON.stringify(prov.range) : null, prov.sha256]
              .filter((x) => typeof x === "string" && x.length > 0)
              .join(" ")
            const bytes = String(answer.bytes ?? "")
            const standing = String(answer.standing ?? "asserted")
            const head = `[snip ${input.ref} · from: ${from || "address"} · standing: ${standing === "witnessed" ? "mechanical" : "said"}]\n`
            return {
              output: { bytes, standing, from },
              content: `${head}${bytes}`,
              metadata: { schema: "EOTSnip@1", ref: input.ref, standing, from, origin: standing === "witnessed" ? "mechanical" : "model" },
            }
          }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: "snip failed", error })))),
      }),
    )

    // SWARM: deploy the ants on hard meaning. The door runs the model-free capacity-swarm (independent
    // mechanical readings, their contention, the surviving read with its named holes) and returns its own
    // report — a measurement, never a guess. The result is the door's verbatim bytes, and the same reading
    // is rendered as its own notice row, so the model relays it and cannot author a finding the swarm did
    // not measure. The finding also enters the task medium and the cross-session ledger — the app learns.
    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "swarm",
        options: { codemode: false },
        description:
          "Deploy the ant-swarm on hard meaning: independent mechanical readings of the material, their contention, and the surviving read with its named holes. Reads any language and any modality (text, or a path to an image/audio/PDF/code file, resolved by the local senses first) by the material's own referent-physics — model-free, a measurement, never a guess. Returns the door's own report; relay it, and add no finding the swarm did not measure.",
        input: Schema.Struct({
          ask: Schema.String.annotate({ description: "What to read for (the pointing or question)" }),
          text: Schema.optionalKey(Schema.String).annotate({
            description: "The material to read; omit to read the session's own recent turns",
          }),
          path: Schema.optionalKey(Schema.String).annotate({
            description: "A file of any modality (image, audio, PDF, code) the door reads with its local senses before swarming",
          }),
          ref: Schema.optionalKey(Schema.String).annotate({
            description: "An address whose bytes become the material (path#L10-L20, or a <fold-commons> ref)",
          }),
          lang: Schema.optionalKey(Schema.String).annotate({ description: "OCR language for image/PDF (ISO code); omit for the door's default" }),
        }),
        output: Schema.Struct({ reading: Schema.String, standing: Schema.String, holes: Schema.String, giver: Schema.String }),
        execute: (input, context) =>
          Effect.gen(function* () {
            const sessionID = context.sessionID
            const workspace = yield* workspaceOf(sessionID)
            const answer = yield* post(
              { event: "swarm", sessionID, agent: sessionID, workspace, ask: input.ask, text: input.text, path: input.path, ref: input.ref, lang: input.lang },
              swarmTimeout,
            )
            if (answer === undefined) return yield* Effect.fail(new ToolFailure({ message: `swarm: the fold door is unreachable at ${base}` }))
            if (answer.ok !== true)
              return yield* Effect.fail(new ToolFailure({ message: `swarm ${String(answer.gap ?? "failed")}: ${input.ask}` }))
            const reading = String(answer.reading ?? "")
            const standing = String(answer.standing ?? "unresolved")
            const holes = String(answer.holes ?? "")
            const giver = String(answer.giver ?? "ant-swarm")
            const modality = String(answer.modality ?? "")
            // The ground the ants read is disclosed when a sense derived it: the model must
            // see that the material was measured (which modality, by whom), not handed raw.
            const ground = modality && modality !== "text/plain" ? `ground: ${giver} (${modality})\n` : ""
            const report = [`${ground}${reading}`, holes ? `anti-matter: ${holes}` : "", `standing: ${standing}`].filter(Boolean).join("\n")
            // The reading as its own notice row, physically separate from the assistant's text — the door's
            // measurement the model must not reword. Failure-silent: the tool result already carries it.
            yield* ctx.session
              .synthetic({ sessionID, text: `fold measured · ${report}`, description: "the swarm — the ants' reading, measured", resume: false })
              .pipe(Effect.catchCause(() => Effect.void))
            return {
              output: { reading, standing, holes, giver },
              content: report,
              metadata: { schema: "EOSwarm@1", reading, standing, holes, giver, modality, origin: "mechanical" },
            }
          }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: "swarm failed", error })))),
      }),
    )

    // CUBE: the 27-cell tool registry — coverage always, a witness call in
    // shadow. The door measures (model-free, python in its locked venv, its own
    // whitelist and family gates); the result renders as its own notice row, so
    // the model relays the door's finding and cannot author one. A disagreement
    // is a finding the door records (a REC candidate), never a retry.
    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "cube",
        options: { codemode: false },
        description:
          "The 27-cell cube's own tools. Name a cell (DEF·Pattern, NUL.Ground) or a registered tool package (pydmd, scipy) to run one whitelisted tool in shadow — a witness reading beside its own JS sibling, recorded, never gating; or omit both and get the map: every cell's coverage, which python packages are present in the door's locked venv, and each tool's last agreement. Model-free: the door measures, you relay; add no finding it did not measure.",
        input: Schema.Struct({
          ask: Schema.String.annotate({ description: "What to read for (the pointing or question)" }),
          cell: Schema.optionalKey(Schema.String).annotate({
            description: "A cube address (DEF·Pattern, NUL.Ground). With no tool, the cell's single registered tool runs; a multi-tool cell is refused by name.",
          }),
          tool: Schema.optionalKey(Schema.String).annotate({
            description: "A registered tool package (pydmd, scipy, clingo). Omit with no cell for the coverage map.",
          }),
          text: Schema.optionalKey(Schema.String).annotate({ description: "The material inline (a series for the witness), when no path/ref is given" }),
          path: Schema.optionalKey(Schema.String).annotate({ description: "A file on this machine the door reads for the material" }),
          ref: Schema.optionalKey(Schema.String).annotate({ description: "An address whose bytes become the material (path#L10-L20, or a <fold-commons> ref)" }),
          rank: Schema.optionalKey(Schema.Number).annotate({ description: "Declared model order for witnesses that fit one — both engines truncate to it, so the agreement compares readings and not rank choices" }),
          seed: Schema.optionalKey(Schema.Number).annotate({ description: "Declared seed for a tool that draws (recorded in the call's detail; the tool must honour it)" }),
        }),
        output: Schema.Struct({ reading: Schema.String, standing: Schema.String, giver: Schema.String }),
        execute: (input, context) =>
          Effect.gen(function* () {
            const sessionID = context.sessionID
            const workspace = yield* workspaceOf(sessionID)
            const answer = yield* post(
              { event: "cube", sessionID, agent: sessionID, workspace, ask: input.ask, cell: input.cell, tool: input.tool, text: input.text, path: input.path, ref: input.ref, rank: input.rank, seed: input.seed },
              cubeTimeout,
            )
            if (answer === undefined) return yield* Effect.fail(new ToolFailure({ message: `cube: the fold door is unreachable at ${base}` }))
            if (answer.ok !== true)
              return yield* Effect.fail(
                new ToolFailure({
                  message: `cube ${String(answer.gap ?? "failed")}: ${input.tool ?? input.cell ?? input.ask}${answer.why ? ` — ${String(answer.why)}` : ""}`,
                }),
              )
            // MAP mode (no cell, no tool): the coverage report IS the reading —
            // the model relays which of the 27 cells the registry can serve.
            if (answer.mode === "map") {
              const cells = Array.isArray(answer.cells) ? (answer.cells as { cell: string; coverage: string; tools: { package: string; present: boolean | null }[] }[]) : []
              const sidecar = (answer.sidecar ?? {}) as { found?: boolean; why?: unknown }
              const report = [
                `cube map: ${cells.length} cells registered, ${cells.filter((c) => c.coverage === "present").length} fully present in the locked venv${sidecar.found ? "" : `; sidecar absent — ${String(sidecar.why ?? "").slice(0, 200)}`}`,
                ...cells.map(
                  (c) =>
                    `${c.cell}: ${c.coverage} — ${c.tools
                      .map((t) => `${t.package}${t.present === true ? "" : t.present === false ? " (absent)" : t.present === null ? " (unprobed)" : ""}`)
                      .slice(0, 8)
                      .join(", ")}`,
                ),
              ].join("\n")
              return {
                output: { reading: report, standing: "map", giver: "cube-registry" },
                content: report,
                metadata: { schema: "EOCube@1", mode: "map", origin: "mechanical" },
              }
            }
            const reading = String(answer.reading ?? "")
            const standing = String(answer.standing ?? "unresolved")
            const giver = typeof answer.producer === "string" && answer.producer.length > 0 ? answer.producer : "cube"
            const agreement = typeof answer.agreement === "number" ? `agreement ${answer.agreement.toFixed(2)}` : "no agreement computable"
            const report = `${reading}\n${agreement}; standing: ${standing}`
            // The reading as its own notice row, physically separate from the
            // assistant's text — the door's measurement the model must not reword.
            yield* ctx.session
              .synthetic({ sessionID, text: `fold measured · ${report}`, description: "the cube — the door's own witness reading, measured", resume: false })
              .pipe(Effect.catchCause(() => Effect.void))
            return {
              output: { reading, standing, giver },
              content: report,
              metadata: { schema: "EOCube@1", mode: "call", cell: String(answer.cell ?? ""), tool: (answer.tool ?? null) as unknown, agreement: answer.agreement ?? null, shadow: true, origin: "mechanical" },
            }
          }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: "cube failed", error })))),
      }),
    )

    yield* ctx.session.hook("context", context)
    yield* ctx.session.hook("title", title)
    yield* ctx.session.hook("http.request", (event) => {
      capturePrompt(event)
      return Effect.void
    })
    yield* ctx.session.hook("http.response", (event) => {
      if (usageFile !== "off") {
        const window = event.kind === "primary" ? windows.get(event.sessionID) : undefined
        windows.delete(event.sessionID)
        void usageTap(usageFile, { sessionID: event.sessionID, kind: event.kind, model: event.model, request: event.request, response: event.response, window }).catch(() => undefined)
      }
      return Effect.void
    })

    // FACING (level 1): type the finished answer at the door and render the spread. Rides BESIDE
    // the record, never instead; failure-silent (the door's ground answers a gap, never throws past
    // post()'s catch). It only renders — the model's text is untouched.
    const facing = (event: Observed) =>
      Effect.gen(function* () {
        if (event.type !== "session.text.ended") return
        const sessionID = event.data.sessionID
        const text = typeof event.data.text === "string" ? event.data.text : ""
        if (text.trim().length < 8) return
        const workspace = yield* workspaceOf(sessionID)
        const answer = yield* post(
          { event: "ground", sessionID, agent: sessionID, workspace, universe: process.env.FOLD_UNIVERSE ?? "world", text, ask: lastAsk.get(sessionID) ?? "" },
          askTimeout,
        )
        const note = facingNote(answer)
        if (!note) return
        yield* ctx.session.synthetic({
          sessionID,
          text: note,
          description: "fold facing — how this answer grounds",
          resume: false,
        })
      }).pipe(Effect.ignore)

    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        // Worktree operations carry a project, not a session: the door reads what git now says in the
        // workspace this plugin was loaded in and records the create/remove as EOT `wt` events.
        if (event.type === "worktree.updated" || event.type === "worktree.resolved") {
          const [sessionID, workspace] = workspaces.entries().next().value ?? [undefined, process.cwd()]
          return post({ event: "event", type: event.type, sessionID, workspace, data: {} }, askTimeout).pipe(Effect.asVoid)
        }
        if (rulerFile && event.type === "session.step.ended") rulerTokens(rulerFile, "sessionID" in event.data ? event.data.sessionID : undefined, event.data.tokens)
        // Fold a tool result at the instant it lands, off the request path: the
        // precompute wins the race against the next context assembly, so folding
        // costs the frontier nothing but the bytes it removes. A miss (or a dead
        // door) falls back to the cold, bounded path fold in `context`.
        if (event.type === "session.tool.input.started") toolNames.set(event.data.id, event.data.name)
        if (event.type === "session.tool.success") {
          const name = toolNames.get(event.data.id) ?? "tool"
          toolNames.delete(event.data.id)
          const text = event.data.content.every((part) => part.type === "text")
            ? event.data.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
            : ""
          if (text.length >= minChars && !folded.has(event.data.id))
            void foldOnce(event.data.sessionID, name, lastAsk.get(event.data.sessionID) ?? "", lastModel.get(event.data.sessionID), event.data.id, text)
        }
        const data = forward(event)
        if (!data) return Effect.void
        const sessionID = "sessionID" in event.data ? event.data.sessionID : undefined
        const record = post({ event: "event", type: event.type, sessionID, data }, askTimeout).pipe(Effect.asVoid)
        // The record rides with its side effects — never instead of them, all concurrent, all
        // failure-silent (post()'s own contract). Shadow capture feeds the draft-lint trial; facing
        // renders the typing on the answer. Each is opt-in and neither can delay the other.
        const side: Array<Effect.Effect<void, never, never>> = [record]
        if (facingOn && event.type === "session.text.ended") side.push(facing(event))
        if (shadowOn) {
          const shadow = shadowOf(event)
          if (shadow && sessionID) side.push(post({ event: "shadow", sessionID, ...shadow }, askTimeout).pipe(Effect.asVoid))
        }
        if (side.length === 1) return record
        return Effect.all(side, { concurrency: side.length, discard: true })
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
