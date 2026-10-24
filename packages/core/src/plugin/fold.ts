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
import { Deferred, Effect, Fiber, Schema, Stream } from "effect"
import os from "node:os"
import path from "node:path"
import { record as rulerRecord, recordTokens as rulerTokens } from "./fold-ruler.js"
import { tap as usageTap } from "./usage-tap.js"
import { Bus } from "../bus.js"
import { SessionEvent } from "../session/event.js"
import { GROUND_LEGEND, GROUND_STEER_HEAD, contradictedIn, gatherPassages, groundHead, groundPayload, groundSteer, pairedIn, revisedIn, shouldHandBack, withoutCitations, type Revise } from "./fold-ground.js"
import { REGISTER_LEGEND, dropTrailingNotices, gateTools, markRegistered, registerBlock, registerHit } from "./fold-register.js"
import * as Physics from "./physics.js"
import * as Learn from "./physics-learn.js"
import fs from "node:fs"

const base = (process.env.FOLD_URL ?? "http://127.0.0.1:11436").replace(/\/+$/, "")
const off = process.env.FOLD_OFF === "1"
// The door sits on the request path, so its recall/surf/title calls get a bounded
// budget. The contract's default is 1500ms: the door's surf does real work behind
// the answer (medium writes, the mechanical fold), and a 250ms budget measured as
// "folded" while the stigmergic note never arrived. A wedged or slow door still
// fails open fast (the turn sends native content) instead of stalling the frontier.
// FOLD_TIMEOUT_MS moves it.
const askTimeout = Number(process.env.FOLD_TIMEOUT_MS ?? 1500)
// The ground is computed after the answer, off the request path, so it may take longer than a context read (the door loads its parsers on first use).
const groundTimeout = Number(process.env.FOLD_GROUND_TIMEOUT_MS ?? 45000)
// The falsifier's research (the workspace, then Wikidata/Wikipedia/Wiktionary at one request per 10 s) runs as a second
// pass after the quick profile is already on the answer; names never looked up before can take a minute.
const researchTimeout = Number(process.env.FOLD_RESEARCH_TIMEOUT_MS ?? 120_000)
const researchOn = process.env.FOLD_RESEARCH !== "0"
// The check is handed back to the model once per answer (a contradicted sentence, a name that does not match, figures resting on
// nothing read) so the next answer carries its sources. FOLD_GROUND_STEER=0 turns the hand-back off, FOLD_GROUND_LEGEND=0 the legend.
const groundSteerOn = process.env.FOLD_GROUND_STEER !== "0"
const groundLegendOn = process.env.FOLD_GROUND_LEGEND !== "0"
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
// PHYSICS-BASED TOOL CALLING (physics.ts). The model writes content in its own medium and the machine derives the
// operation, so no tool definition is sent. FOLD_PHYSICS=1 serves every provider, 0 none; the default serves local
// providers (FOLD_PHYSICS_PROVIDERS, default "ollama"), whose models cannot call tools reliably. Every decline and
// refusal is appended to FOLD_PHYSICS_LOG with its reason and the turn takes the normal tool path.
const physicsMode = process.env.FOLD_PHYSICS ?? "auto"
const physicsProviders = (process.env.FOLD_PHYSICS_PROVIDERS ?? "ollama").split(",").map((p) => p.trim())
const physicsLog = process.env.FOLD_PHYSICS_LOG ?? path.join(os.homedir(), ".local/share/foldcode/physics.jsonl")
// REC and the frontier: an answer that leaves the ask's void open is retried once by the local model in the other form,
// then (or past FOLD_PHYSICS_BUDGET_MS) put to the frontier over an OpenAI-compatible endpoint: FOLD_FRONTIER_URL (off until
// set: a source file leaving the machine is the operator's call, and the :8790 bridge refuses it by disclosure policy),
// FOLD_FRONTIER_MODEL, FOLD_FRONTIER_KEY optional. A verified edit is kept as a recipe in// FOLD_PHYSICS_RECIPES, which the machine applies to later asks of the same shape with no model at all.
const physicsRetries = Number(process.env.FOLD_PHYSICS_RETRIES ?? 1)
const physicsBudget = Number(process.env.FOLD_PHYSICS_BUDGET_MS ?? 60_000)
const physicsFrontier = !!process.env.FOLD_FRONTIER_URL && process.env.FOLD_PHYSICS_FRONTIER !== "0"
const physicsRecipes = process.env.FOLD_PHYSICS_RECIPES ?? path.join(os.homedir(), ".local/share/foldcode/physics-recipes.jsonl")
const physicsAskFrontier = async (prompt: string) => {
  const url = process.env.FOLD_FRONTIER_URL!.replace(/\/+$/, "") + "/chat/completions"
  const key = process.env.FOLD_FRONTIER_KEY
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: process.env.FOLD_FRONTIER_MODEL ?? "heimdall-by-the-fold", messages: [{ role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(physicsBudget),
  })
  if (!res.ok) throw new Error(`frontier answered ${res.status}`)
  return ((await res.json()) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content
}
const physicsServes = (providerID: string) => physicsMode === "1" || (physicsMode === "auto" && physicsProviders.includes(providerID))
// GATHER (physics-gather.ts). A search ask ("find me a corpus of sample documents for OCR training") is answered from what the
// machine read: it runs the searches and fetches itself, offers the model no tool, and hands over the sentences it read. That is a
// cost cut, not a reliability workaround, so it serves every provider; FOLD_GATHER=0 turns it off. Same heimdall search as the
// "this machine" engine below.
const gatherOn = process.env.FOLD_GATHER !== "0"
// THE REGISTER (fold-register.ts; the door's opencode-register.mjs): before route and gather, the door is asked whether the conversation
// itself answers a new ask (a stated name, a moved date, "did I say X"); a hit is never gathered (foldcode-poc/FAILURES.md F5). The
// door's `<fold-register>` block is pinned in event.system, past native compaction (F1). FOLD_REGISTER=0 turns it off.
const registerOn = process.env.FOLD_REGISTER !== "0"
// THE TOOL GATE (fold-register.ts gateTools): the fold's own tools a plain turn cannot use are not sent — measured as +5 tools on every
// request, about a tenth of a chat request before any history (FAILURES.md, diagnosis 2026-10-23). FOLD_TOOL_GATE=0 turns it off.
const toolGateOn = process.env.FOLD_TOOL_GATE !== "0"
// The research itself runs in the door (khora opencode-gather.mjs: the Holodeck's research and its summary selected by the asker's
// stance, in a worker thread, no model). By default the door also ANSWERS: one model call is pointed at the door's local endpoint, which
// replies with the text it assembled, so no model runs and no token is spent. FOLD_GATHER_MODEL=1 has a real model write the answer from
// the lines read instead. Only providers listed in FOLD_GATHER_VIA_DOOR are pointed at the door (it speaks the OpenAI chat wire format).
const gatherZero = process.env.FOLD_GATHER_MODEL !== "1"
// THE CONVERSATION ROUTER (khora opencode-route.mjs, by the door): each ask is routed by intent before any model is called, and grounding is ON by
// default: an ACCOUNT ask (longform, explain, a question about a world topic) is gathered first and the MODEL WRITES from the sources; a SEARCH ask
// stays zero-model; basic chat, invented work, arithmetic, follow-ups and anything about the workspace take the paths they always took (no research).
// FOLD_ROUTE=0 turns it off. When the door gives no route (a gap, an error, a door that is down) the classifier below decides, as it always did.
const routeOn = process.env.FOLD_ROUTE !== "0"
// the route post is quick on a quiet door (ms) but has to cross the door's event loop: FOLD_ROUTE_MS (default 4 s) is its budget, and a
// timed-out route falls back to the English classifier, which does not know a longform ask (the model then writes freely)
const routeTimeout = Number(process.env.FOLD_ROUTE_MS ?? 4000)
// LONGFORM (khora opencode-longform.mjs): a piece is a file written one section at a time across model responses, each section graded against its own
// material, repair capped, with short prompts (a section's lines and the sentence before it, never the piece). The door keeps the job; the model
// calls are this session's own (a synthetic message resumes the turn for each section). On by default for a longform ask; FOLD_LONGFORM=0 turns it off.
// GENERATE (the organ): any ask the router types as PRODUCE (an account ask with a form — essay, brief, plan, table, list, code, poem, a summary of one's
// own documents…) runs through the layers below, never the agent loop; "essay" is one measured kind among them (prose). FOLD_GENERATE_* names the
// switches; the FOLD_LONGFORM_* names stay as aliases.
const envAlias = (name: string) => process.env[`FOLD_GENERATE${name}`] ?? process.env[`FOLD_LONGFORM${name}`]
const generateOn = envAlias("") !== "0"
// FREEFORM (default; FOLD_LONGFORM_FREEFORM=0 turns it off): the model is GIVEN the facts but writes in its own words; the door grades nothing and cuts nothing
// (khora opencode-longform.mjs freeform). With it off, the grounded section-by-section path stands.
const generateFreeform = envAlias("_FREEFORM") !== "0"
const LONGFORM_MARK = "fold longform ·"
const gatherViaDoor = (process.env.FOLD_GATHER_VIA_DOOR ?? "opencode-go,opencode,ollama").split(",").map((p) => p.trim())
const gatherBudgetMs = Number(process.env.FOLD_GATHER_BUDGET_MS ?? 90_000)
// A broad topic never saturates the Holodeck's stopping rule, and a handful of good pages is enough to write an account from: an account ask is cut sooner.
const gatherAccountSoftMs = Number(process.env.FOLD_GATHER_ACCOUNT_SOFT_MS ?? 20_000)
// a longform piece is read for longer than a question: 20 s read one page (and the material rule kept it out), and the piece was written from nothing
const gatherLongformSoftMs = Number(process.env.FOLD_GATHER_LONGFORM_SOFT_MS ?? 45_000)
type GatherResult = { voids?: Array<{ id: string; label: string; sentences: Array<{ text: string; host: string }> }>; text: string; sources: Array<{ url: string }>; passages: Array<{ name: string; text: string }>; notes?: string[]; gaps: unknown[]; calls?: unknown; stop?: unknown }
// When the door cannot gather, the turn is NOT handed to the tool loop (it searches through the same engine and measured 81 requests,
// 693k tokens, on one ask); it takes one small request that says so. FOLD_GATHER_FALLBACK=tools restores the tool path.
const gatherFallbackTools = process.env.FOLD_GATHER_FALLBACK === "tools"
const physicsRecord = (row: Record<string, unknown>) => {
  try {
    fs.mkdirSync(path.dirname(physicsLog), { recursive: true })
    fs.appendFileSync(physicsLog, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n")
  } catch {}
}
// RESEARCH FEEDBACK (general, not tied to any one generation path): the pages a turn READ, shown to the person as its own
// notice — never sent to the model. Every path that gathers (a plain account, a piece's own gather) shows the same line, so
// the person sees what was researched no matter what is written from it.
const hostOf = (name: string) => { try { return new URL(name).hostname.replace(/^www\./, "") } catch { return String(name).slice(0, 40) } }
const researchNotice = (sessionID: string, sources: number, passages: Array<{ name: string }>) => {
  const hosts = [...new Set(passages.map((p) => hostOf(p.name)))].slice(0, 12)
  return { sessionID, text: `fold measured · research — ${sources} source(s) read${hosts.length ? `: ${hosts.join(", ")}` : ""}`, description: "fold research — what was read", resume: false }
}
// STEP MATERIAL (general): the facts a step writes from, shown to the person as its own notice. Any stepped generation shows its step's material.
const materialNotice = (sessionID: string, label: string, facts: string[]) => {
  const lines = facts.slice(0, 8).map((f) => `- ${String(f).slice(0, 160)}`).join("\n")
  return { sessionID, text: `fold measured · ${label} — writing from ${facts.length} fact(s)${lines ? `:\n${lines}` : ""}`, description: "fold research — the step's facts", resume: false }
}
// PIECE PROGRESS (data, not prose): the outline with each section's state, published on the bus as a fold-longform notice so the window draws ONE live
// panel for the piece (replaced on every start / step / finish). The door computes the states (opencode-longform.mjs outlineStates); this only relays them.
// the sections mode's states (planned/writing/judging/written/cut) and the layers mode's slot states: a slot the stitched layer FILLED from the
// sources, a GAP it left, the gap being DRAWN by the model, and a drawn gap ADMITTED (its facing sentences placed, the rest marked)
type GenerateSectionState = "planned" | "writing" | "judging" | "written" | "cut" | "filled" | "gap" | "drawing" | "admitted"
// a section once judged carries its verdict (sentences, how many face their material, how many were cut, rounds) and a preview of what was kept;
// a layers row carries which layer wrote it and how many of its sentences are marked as the model's own
type GenerateOutline = Array<{ id: string; title: string; state: GenerateSectionState; facts: number; sentences?: number; supported?: number; cut?: number; rounds?: number; freeform?: boolean; preview?: string; round?: number; layer?: "stitched" | "drawn"; marked?: number; depth?: number }>
// the last step's verdict: what was judged, how it fared, and the sentences cut — so the window shows the work, not only the next title
type GenerateGraded = { section: string; title?: string; round: number; sentences: number; supported: number; accepted: boolean; failed: string[]; freeform?: boolean; marked?: number; newGaps?: number }
type GenerateProgress = {
  v: 1; topic: string; outline: GenerateOutline; current: string | null; round: number; done: boolean; sources: number
  // the kind of thing being generated (prose, brief, table…), so the panel can say "Writing a brief on X" / "Building a table on X"
  kind?: string
  startedAt?: number; calls?: number; graded?: GenerateGraded | null; judging?: { section: string; title?: string; facts: number } | null
  // layers mode: which layer is at work, and the marked share so far (sentences the model's own / sentences placed), with the stitched text when it landed
  layer?: "stitched" | "drawn"; marked?: { marked: number; placed: number }; stitched?: { filled: number; gaps: number; text?: string }
}
const GENERATE_STATES: ReadonlySet<string> = new Set(["planned", "writing", "judging", "written", "cut", "filled", "gap", "drawing", "admitted"])
const generateOutlineOf = (raw: unknown): GenerateOutline =>
  (Array.isArray(raw) ? raw : []).flatMap((s) => {
    const o = s as Record<string, unknown>
    if (typeof o?.id !== "string") return []
    const state = GENERATE_STATES.has(String(o.state)) ? (o.state as GenerateSectionState) : "planned"
    const num = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k] as number) ? { [k]: o[k] as number } : {})
    return [{
      id: o.id, title: typeof o.title === "string" ? o.title : o.id, state, facts: Number(o.facts) || 0,
      ...num("sentences"), ...num("supported"), ...num("cut"), ...num("rounds"), ...num("round"), ...num("marked"), ...num("depth"),
      ...(o.freeform === true ? { freeform: true } : {}), ...(typeof o.preview === "string" && o.preview ? { preview: o.preview.slice(0, 240) } : {}),
      ...(o.layer === "stitched" || o.layer === "drawn" ? { layer: o.layer } : {}),
    }]
  })
const generateGradedOf = (raw: unknown): GenerateGraded | null => {
  const g = raw as Record<string, unknown> | undefined
  if (!g || typeof g !== "object" || typeof g.section !== "string") return null
  return { section: g.section, ...(typeof g.title === "string" ? { title: g.title } : {}), round: Number(g.round) || 0, sentences: Number(g.sentences) || 0, supported: Number(g.supported) || 0, accepted: g.accepted === true, failed: (Array.isArray(g.failed) ? g.failed : []).map((f) => String(f).slice(0, 200)).slice(0, 6), ...(g.freeform === true ? { freeform: true } : {}), ...(typeof g.marked === "number" ? { marked: g.marked } : {}), ...(typeof g.newGaps === "number" ? { newGaps: g.newGaps } : {}) }
}
type GenerateNoticeInput = { topic: string; kind?: string; outline: GenerateOutline; round?: number; done?: boolean; sources: number; startedAt?: number; calls?: number; graded?: GenerateGraded | null; judging?: { section: string; title?: string; facts: number } | null; layer?: "stitched" | "drawn"; marked?: { marked: number; placed: number }; stitched?: { filled: number; gaps: number; text?: string } }
const generateNotice = (sessionID: string, p: GenerateNoticeInput) => {
  const current = p.outline.find((s) => s.state === "writing" || s.state === "judging" || s.state === "drawing") ?? null
  const written = p.outline.filter((s) => s.state === "written" || s.state === "cut" || s.state === "filled" || s.state === "admitted").length
  const longform: GenerateProgress = {
    v: 1, topic: p.topic, outline: p.outline, current: current?.id ?? null, round: Number(p.round) || 0, done: p.done === true, sources: p.sources, kind: p.kind ?? "prose",
    ...(p.startedAt ? { startedAt: p.startedAt } : {}), ...(typeof p.calls === "number" ? { calls: p.calls } : {}), ...(p.graded !== undefined ? { graded: p.graded } : {}), ...(p.judging !== undefined ? { judging: p.judging } : {}),
    ...(p.layer ? { layer: p.layer } : {}), ...(p.marked ? { marked: p.marked } : {}), ...(p.stitched ? { stitched: p.stitched } : {}),
  }
  const verdict = p.graded ? ` · last: "${p.graded.title ?? p.graded.section}" ${p.graded.supported}/${p.graded.sentences} face their facts${p.graded.failed.length ? `, ${p.graded.failed.length} cut` : ""}` : ""
  const share = p.marked && p.marked.placed ? ` · marked ${Math.round((100 * p.marked.marked) / p.marked.placed)}%` : ""
  const text = p.done
    ? `fold measured · ${p.topic} — the piece is assembled (${written} of ${p.outline.length} section(s))${share}`
    : p.judging
      ? `fold measured · ${p.topic} — judging "${p.judging.title ?? p.judging.section}" against ${p.judging.facts} fact(s)`
      : p.layer === "stitched"
        ? `fold measured · ${p.topic} — stitched from the sources: ${p.stitched?.filled ?? written} slot(s) filled, ${p.stitched?.gaps ?? p.outline.filter((s) => s.state === "gap").length} gap(s) left for the model`
        : current?.state === "drawing"
          ? `fold measured · ${p.topic} — drawing "${current.title}" from ${current.facts} snip(s)${share}${verdict}`
          : `fold measured · ${p.topic} — writing ${current ? `"${current.title}"` : "…"} (${written} of ${p.outline.length} written${p.round ? `, repair round ${p.round}` : ""})${verdict}`
  return { sessionID: sessionID as never, text, description: "fold longform — the piece's progress", metadata: { notice: "fold-longform", longform } as Record<string, unknown> }
}
// THE WORK ORDER (FOLD_LONGFORM_MODE): "layers" (default) is two recursive layers in one longform — layer A stitches the piece from the sources with no
// model (door op "stitch"), and layer B, the model, writes ONLY into the gaps layer A left, one gap per call, each reply admitted at its addresses
// (door op "admit"), new gaps drawn next to a depth and a call budget. "sections" is the earlier section-by-section path (door ops "start"/"step"),
// kept for comparison. A door without the stitch op fails open to sections, recorded.
const generateMode = envAlias("_MODE") === "sections" ? "sections" : "layers"
const generateDepth = Math.max(0, Number(envAlias("_DEPTH") ?? 2) || 0)
const generateCallBudget = Math.max(1, Number(envAlias("_CALLS") ?? 8) || 8)
// THE KIND of thing asked for, from the router's form: the router names what the ask produces (opencode-route.mjs: `form`, today "longform" when a genre
// word meets a producing verb); "longform" is the prose kind. Any other form the router names rides through as it is — the plugin keeps no list of kinds.
const generateKindOf = (form: unknown): string => (typeof form === "string" && form.trim() ? (form.trim() === "longform" ? "prose" : form.trim().toLowerCase().slice(0, 40)) : "prose")
// how a gap window names the part asked for, by kind: prose is "a piece"; any other kind is named as itself
const generateNoun = (kind: string) => (kind === "prose" ? "piece" : kind)
// a gap the stitched layer left, as the door hands it: its slot, what a piece must say there, why it is a gap, and the addressed snips near it
type GenerateSnip = string | { text?: string; name?: string; host?: string; source?: string; ref?: string; url?: string; address?: string; n?: number; start?: number; end?: number }
type GenerateGap = { slot: string; label: string; why?: string; context: GenerateSnip[]; depth: number }
const generateGapsOf = (raw: unknown, depth: number): GenerateGap[] =>
  (Array.isArray(raw) ? raw : []).flatMap((g) => {
    const o = g as Record<string, unknown>
    if (!o || typeof o !== "object") return []
    const slot = typeof o.slot === "string" ? o.slot : typeof o.id === "string" ? o.id : ""
    if (!slot) return []
    return [{ slot, label: typeof o.label === "string" && o.label ? o.label : slot, ...(typeof o.why === "string" ? { why: o.why } : {}), context: Array.isArray(o.context) ? (o.context as GenerateGap["context"]) : [], depth }]
  })
// one addressed snip, as a line the model writes from and the grader can face: `text — <source> @<ref>`
// (opencode-stitch.mjs `address`: { text, source, url, n, start, end } — the source's host, its url, and the byte span `[S<n> #start-end]`)
const generateSnipLine = (s: GenerateSnip) => {
  if (typeof s === "string") return s.replace(/\s+/g, " ").trim().slice(0, 320)
  const text = String(s.text ?? "").replace(/\s+/g, " ").trim().slice(0, 320)
  const ref = String(s.ref ?? s.url ?? s.address ?? "")
  const name = String(s.name ?? s.host ?? (ref ? hostOf(ref) : s.source ?? ""))
  const span = typeof s.n === "number" && typeof s.start === "number" && typeof s.end === "number" ? ` [S${s.n} #${s.start}-${s.end}]` : ""
  return text ? `${text}${name || ref ? ` — ${[name, ref ? `@${ref}` : ""].filter(Boolean).join(" ")}${span}` : ""}` : ""
}
// the gap window: what the piece must say there, the snips near it, only what they state. Sized by the snips (a model asked for 220 words from
// two snips pads them), like opencode-longform.mjs wordsFor.
const generateGapPrompt = (topic: string, gap: GenerateGap, kind = "prose") => {
  const lines = gap.context.map(generateSnipLine).filter(Boolean).slice(0, 12)
  const words = Math.max(40, Math.min(220, Math.round(lines.reduce((n, l) => n + l.split(" ").length, 0) * 1.2)))
  const noun = generateNoun(kind)
  return [
    kind === "prose"
      ? `Write what a piece on ${topic} must say about ${gap.label}, about ${words} words, as plain paragraphs with no heading.${gap.why ? ` (${gap.why.replace(/\s+/g, " ").trim().slice(0, 200)})` : ""}`
      : `Write the ${noun} part that a ${noun} on ${topic} must have about ${gap.label}, about ${words} words, in the form a ${noun} takes, with no heading.${gap.why ? ` (${gap.why.replace(/\s+/g, " ").trim().slice(0, 200)})` : ""}`,
    lines.length ? `The sources near it say (each line is one snip, with its source and address):\n${lines.map((l) => `- ${l}`).join("\n")}` : "No source near it says anything; write one short sentence that says so.",
    "Write only what these snips state, in your own words; say nothing they do not state.",
  ].join("\n\n").slice(0, 6000)
}
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
// The facing renders NATIVELY on the answer (the window reads the notice's `metadata.ground`); FOLD_FACING=notice
// keeps the text notice, so a window that cannot draw the ground (and the door-down path) still discloses.
const facingNative = process.env.FOLD_FACING !== "notice"
// DRAFT-LINT (the-fold/docs/DRAFT-LINT.md): draft + act are the new door
// events. FOLD_DRAFT=0 disables them; FOLD_OFF=1 still disables everything.
// Rollout step 1 is observe-only — the door records verdicts it never
// enforces — so these posts change no turn by default.

let downUntil = 0

// postRaw is a plain promise so the request path (post) and the event-time
// precompute share one implementation: a tool result is folded the moment it
// lands, off the request path, so the next context assembly reads the cache
// with no door wait (see foldOnce / foldBudget below).
const postRaw = async (body: unknown, timeout: number, patient = false) => {
  // A patient post (the ground, computed after the answer) neither waits out nor starts the cool-down: a slow first
  // load of the door's parsers must not blank the ground the person is owed.
  if (off || (!patient && Date.now() < downUntil)) return undefined
  const response = await fetch(`${base}/v1/hooks/opencode`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-er7-surface": "opencode" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  }).catch(() => {
    if (!patient) downUntil = Date.now() + coolDown
    return undefined
  })
  if (!response?.ok) return undefined
  return (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
}

const post = (body: unknown, timeout: number, patient = false) =>
  Effect.tryPromise(() => postRaw(body, timeout, patient)).pipe(Effect.catch(() => Effect.succeed(undefined)))

// THE CONFESSION rides the finished piece (penelope layer 9): one paragraph computed at the door from the residue ledger — how many
// sentences face a source, how many are the model's own, the gaps, the calls — never written by the model. The door's refusal to
// answer leaves the piece as it is; the paragraph is appended, never put in the model's mouth to rewrite.
const withConfession = (job: string, text: string) =>
  Effect.gen(function* () {
    if (!text) return text
    const r = (yield* post({ event: "longform", op: "confess", job }, 8_000, true)) as { ok?: boolean; text?: string } | undefined
    const c = r?.ok === true && typeof r.text === "string" ? r.text.trim() : ""
    return c ? `${text}\n\n${c}` : text
  })

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
// The ground/profile notice is committed straight onto the bus and never admitted to the inbox, so it never wakes a step:
// finding it as the newest message says nothing about who started the step, and must not mark the step as notice-woken.
export const isGroundNotice = (text: string) => /^fold facing · the (?:ground|profile)/.test(String(text ?? ""))

export const isPersonNotice = (text: string) =>
  /^(?:fold facing ·|fold measured ·|fold chase|fold matrix|fold view |fold savings|fold audit|fold door unreachable|fold physics ·)/.test(
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

// THE STEP LOG, PROJECTED APPEND-ONLY. The turn's steps are a log; the window is a projection of it at the
// latest cursor, and the projection only ever GROWS. Lineage: khora native/the-fold/build-log.js, where a
// build is never a mutable object but a thread of entries (PROPOSE · INS, SUPERSEDE · SYN naming the version
// it supersedes) and "the code" is the fold of the log up to here. Here the same discipline holds the window:
//   1. A fold never edits the head. Each fold APPENDS a projection event (a mid-turn system message, typed
//      <fold-index grain="step" v=k supersedes=v(k-1)>) where the steps it retires stood; the reader's rule is
//      that the latest version of an entry wins. Between folds every request is the previous one plus the new
//      step, and at a fold the provider's cache breaks only at the first step actually removed.
//   2. What stays verbatim is decided by the dependency chain, not by age: an edit is made from the version
//      of the file it edits (SYN after the read or write that produced that version, the cube's own order
//      SIG/SEG -> INS -> SYN), the next step is made from the latest run's result (EVA), and the frontier is
//      the work itself. Everything else becomes an addressed receipt whose exact bytes are held under a snip
//      handle. FOLD_GATE_CHARS only says WHEN to fold; the chain says WHAT.
//   3. What the agent already observed is state, not memory: every observation is keyed by its address (a
//      path, or the call itself) and versioned by a hash of its bytes, edits are compiled mechanically onto
//      the bytes they were made from, and the projection says "read at version X, same bytes at steps a, b",
//      so a re-read to remember is never needed. No model is consulted for any of it.
type StepOp = "SIG" | "SEG" | "INS" | "SYN" | "EVA" | "NUL"
export type StepAct = {
  n: number
  id: string
  start: number
  end: number
  acts: Array<{ op: StepOp; name: string; addr: string; file: boolean; from?: string; to?: string; ok: boolean }>
  deps: number[]
  handle: string
  raw: string
  line: string
}
export type StepFact = { addr: string; file: boolean; version: string; bytes?: string; by: number; seen: number[]; made: number[] }
export type StepLog = { s: number; head: string; first: number; acts: StepAct[]; state: Map<string, StepFact> }
export type ProjectionEvent = { v: number; anchor: string; text: string }
export type Projection = { head: string; retired: string[]; events: ProjectionEvent[]; facts: Record<string, string>; clips: string[] }

const frontierSteps = () => Number(process.env.FOLD_FRONTIER ?? 2)
const versionOf = (t: string) => `${hash36(t)}${t.length.toString(36)}`
const isAsk = (m: Msg) => m.role === "user" && m.content.some((p) => p.type === "text")
const editOf = (input: unknown) => {
  const i = (input ?? {}) as Record<string, unknown>
  const old = i.oldString ?? i.old_string ?? i.old
  const next = i.newString ?? i.new_string ?? i.new
  return typeof old === "string" && typeof next === "string" && old.length > 0
    ? { old, next, all: i.replaceAll === true || i.replace_all === true }
    : undefined
}
// An edit compiled onto the bytes it was made from (build-log's patch rule: the bytes must be located exactly
// once, or every one of them under replaceAll). undefined when they are not: the version is then known only by
// its derivation, never guessed.
const compileEdit = (bytes: string, e: NonNullable<ReturnType<typeof editOf>>) => {
  const k = bytes.split(e.old).length - 1
  if (k === 0 || (k > 1 && !e.all)) return undefined
  return e.all ? bytes.split(e.old).join(e.next) : bytes.replace(e.old, () => e.next)
}
// A read result as file bytes: a "Read file …, lines a-b" header and "N: " / "N| " line numbers are the tool's
// rendering, not the file. Only a read from line 1 is the file's head; a later span is kept as an observation.
const readBytes = (text: string) => {
  const lines = text.split("\n")
  const header = /^(Read file|<file>|<path>)/i.test(lines[0] ?? "") ? lines.shift() : undefined
  const numbered = lines.length > 0 && lines.filter((l) => l.length > 0).every((l) => /^\s*\d+(?:: |:$|\| |\|$|\t)/.test(l))
  const body = numbered ? lines.map((l) => l.replace(/^\s*\d+(?:: ?|\| ?|\t)/, "")).join("\n") : lines.join("\n")
  const from = header ? Number(/lines (\d+)-/.exec(header)?.[1] ?? 1) : 1
  return { body, whole: from === 1 }
}
const stableJson = (v: unknown): string =>
  v && typeof v === "object"
    ? Array.isArray(v)
      ? `[${v.map(stableJson).join(",")}]`
      : `{${Object.keys(v as object)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
          .join(",")}}`
    : JSON.stringify(v) ?? "null"
const failed = (text: string | undefined) => text !== undefined && /^\s*(error|failed|not found|no such file)/i.test(text.slice(0, 80))

// The act of a tool call, typed mechanically from the ACT (which tool, on what), never from the content.
const actOf = (name: string, input: unknown): { op: StepOp; addr: string; file: boolean } => {
  const path = pathOf(input)
  const content = (input as Record<string, unknown> | undefined)?.content
  if (path && /edit|patch|replace/i.test(name)) return { op: "SYN", addr: path, file: true }
  if (path && /write|create/i.test(name) && typeof content === "string") return { op: "INS", addr: path, file: true }
  if (path && /read|view|cat/i.test(name)) return { op: "SIG", addr: path, file: true }
  const addr = `${name} ${squash(stableJson(input ?? {}), 300)}`
  if (/bash|shell|exec|run|test|command/i.test(name)) return { op: "EVA", addr, file: false }
  if (/grep|glob|list|search|find|fetch|snip|perceive|read|view/i.test(name)) return { op: "SEG", addr, file: false }
  return { op: "NUL", addr, file: false }
}

// THE LOG: the current turn's steps, each typed, addressed, and linked to the steps it was made from.
export const stepLog = (messages: Msg[]): StepLog | undefined => {
  const s = messages.findLastIndex(isAsk)
  if (s < 0) return undefined
  const starts: number[] = []
  for (let i = s + 1; i < messages.length; i++) if (messages[i].role === "assistant") starts.push(i)
  if (starts.length === 0) return undefined
  const head = messages[s].id ?? String(s)
  const salt = hash36(head)
  const state = new Map<string, StepFact>()
  const acts = starts.map((start, k): StepAct => {
    const n = k + 1
    const end = starts[k + 1] ?? messages.length
    const part = messages.slice(start, end)
    const results = new Map<string, string | undefined>()
    for (const m of part) for (const p of m.content) if (p.type === "tool-result") results.set(p.id, textOfResult(p) ?? clip(p.result, 1_000_000))
    const deps = new Set<number>()
    const acts: StepAct["acts"] = []
    for (const m of part)
      for (const p of m.content) {
        if (p.type !== "tool-call") continue
        const { op, addr, file } = actOf(p.name, p.input)
        const out = results.get(p.id)
        const ok = out !== undefined && !failed(out)
        const prior = state.get(addr)
        const from = prior?.version
        let next: StepFact | undefined
        if (op === "SYN") {
          // made FROM the version it edits: the step that produced that version is a dependency
          if (prior) deps.add(prior.by)
          const e = editOf(p.input)
          if (ok) {
            const bytes = prior?.bytes !== undefined && e ? compileEdit(prior.bytes, e) : undefined
            const version = bytes !== undefined ? versionOf(bytes) : `${from ?? "?"}+${n}`
            next = { addr, file, version, bytes, by: n, seen: [], made: [...(prior?.made ?? []), n] }
          }
        } else if (op === "INS" && ok) {
          const bytes = String((p.input as Record<string, unknown>).content)
          next = { addr, file, version: versionOf(bytes), bytes, by: n, seen: [], made: [...(prior?.made ?? []), n] }
        } else if (ok && out !== undefined && op !== "NUL") {
          const { body, whole } = file ? readBytes(out) : { body: out, whole: true }
          const version = versionOf(body)
          // the latest observation produces the version (a re-read of the same bytes moves `by`, so the
          // chain keeps the newest copy and the older ones can retire)
          next = {
            addr,
            file,
            version,
            bytes: whole ? body : undefined,
            by: n,
            seen: prior && prior.version === version ? [...prior.seen, n] : [n],
            made: prior?.made ?? [],
          }
        }
        if (next) (state.delete(addr), state.set(addr, next))
        acts.push({ op, name: p.name, addr, file, from, to: next?.version, ok })
      }
    const raw = JSON.stringify(part.map((m) => ({ role: m.role, content: m.content })))
    const said = part[0].content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join(" ")
    const result = [...results.values()][0] ?? ""
    const what = acts.length
      ? acts.map((a) => `${a.op} ${a.name} ${a.file ? a.addr : squash(a.addr.slice(a.name.length + 1), 100)}${a.from && a.to && a.from !== a.to ? ` @${a.from}→@${a.to}` : a.to ? ` @${a.to}` : ""}${a.ok ? "" : " (failed)"}`).join("; ")
      : "(no tool)"
    return {
      n,
      id: messages[start].id ?? `${head}#${n}`,
      start,
      end,
      acts,
      deps: [...deps].sort((a, b) => a - b),
      handle: `rs${n.toString(36)}${salt}`,
      raw,
      line: `${said ? `said "${squash(said, 100)}" · ` : ""}${what} → ${squash(result, 120)}`,
    }
  })
  return { s, head, first: starts[0], acts, state }
}

// THE CHAIN: the steps the current work depends on. Roots: the frontier (the last FOLD_FRONTIER steps), the
// latest successful edit or write (the file version being worked on), and the latest run (the result the next
// step is made from). Closed over `deps`, so an edit keeps the read it came from, and a chain of edits keeps
// the read at its root.
export const neededSteps = (log: StepLog, frontier = frontierSteps()) => {
  const total = log.acts.length
  const roots = new Set<number>()
  for (let n = Math.max(1, total - Math.max(1, frontier) + 1); n <= total; n++) roots.add(n)
  const made = log.acts.findLast((a) => a.acts.some((x) => (x.op === "SYN" || x.op === "INS") && x.ok))
  if (made) roots.add(made.n)
  const ran = log.acts.findLast((a) => a.acts.some((x) => x.op === "EVA"))
  if (ran) roots.add(ran.n)
  const need = new Set<number>()
  const visit = (n: number) => {
    if (need.has(n)) return
    need.add(n)
    for (const d of log.acts[n - 1]?.deps ?? []) visit(d)
  }
  for (const r of roots) visit(r)
  return need
}

// The projection rendered: everything before the turn's first step unchanged (the ask is never edited), then
// each step not retired, and each projection event right after the step it anchors to.
const eventMessage = (head: string, ev: ProjectionEvent) =>
  Message.make({ id: `fold-proj-${head}-${ev.v}`, role: "system", content: [{ type: "text" as const, text: ev.text }] })
export const renderProjection = (messages: Msg[], log: StepLog, proj: Projection, store?: Map<string, string>, floor = 2_000): Msg[] => {
  const retired = new Set(proj.retired)
  const clipped = new Set(proj.clips)
  // A clip is decided once, when the result is superseded (at a fold), and kept: the same part is the same
  // bytes on every later request, so the cache never breaks because space ran out.
  const clipMsg = (m: Msg): Msg => {
    if (clipped.size === 0 || !m.content.some((p) => p.type === "tool-result" && clipped.has(p.id))) return m
    return {
      ...m,
      content: m.content.map((p) => {
        if (p.type !== "tool-result" || !clipped.has(p.id)) return p
        const text = foldable(p)?.text
        if (text === undefined || text.length <= floor) return p
        const handle = `rc${hash36(text)}${text.length.toString(36)}`
        store?.set(handle, text)
        return { ...p, result: { type: "text" as const, value: clipToFit(text, floor, handle) } }
      }),
    } as Msg
  }
  const anchored = new Map<string, ProjectionEvent[]>()
  for (const ev of proj.events) anchored.set(ev.anchor, [...(anchored.get(ev.anchor) ?? []), ev])
  const out = messages.slice(0, log.first)
  for (const a of log.acts) {
    // a retired step leaves the window, but an instruction the harness placed inside its span stays (it is not
    // the step's work, and a system update is never the fold's to drop)
    if (!retired.has(a.id)) out.push(...messages.slice(a.start, a.end).map(clipMsg))
    else out.push(...messages.slice(a.start, a.end).filter((m) => m.role === "system"))
    for (const ev of anchored.get(a.id) ?? []) out.push(eventMessage(log.head, ev))
  }
  return out
}

// One projection event: the receipts of the steps it retires, the observed state that changed since the last
// event (the latest version of an entry wins), and the current bytes of files not visible verbatim elsewhere.
const projectionText = (log: StepLog, proj: Projection, batch: StepAct[], keptAfter: Set<number>, viewMax: number) => {
  const v = proj.events.length + 1
  const last = log.acts.length
  const facts: Record<string, string> = {}
  const changed: StepFact[] = []
  for (const o of log.state.values()) {
    const sig = `${o.version}|${o.seen.join(",")}|${o.made.join(",")}`
    facts[o.addr] = sig
    if (proj.facts[o.addr] !== sig) changed.push(o)
  }
  // where the current bytes of an entry already ride verbatim: in the kept step that observed or wrote them
  // (an edit's compiled bytes ride nowhere, so they go in the view)
  const shownIn = (o: StepFact) => {
    if (!keptAfter.has(o.by)) return undefined
    const act = log.acts[o.by - 1]?.acts.find((x) => x.addr === o.addr && x.to === o.version)
    return act && act.op !== "SYN" ? o.by : undefined
  }
  const view: Array<[string, string]> = []
  let used = 0
  for (const o of [...changed].reverse()) {
    if (!o.file || o.bytes === undefined || shownIn(o)) continue
    if (!(viewMax > 0) || (used + o.bytes.length > viewMax && view.length)) continue
    view.push([`${o.addr} @${o.version}`, o.bytes.slice(0, viewMax)])
    used += o.bytes.length
  }
  view.reverse()
  const inView = new Set(view.map(([k]) => k))
  const stateLine = (o: StepFact) => {
    const shown = shownIn(o)
    const name = o.file ? o.addr : `${o.addr.slice(0, o.addr.indexOf(" "))} \`${squash(o.addr.slice(o.addr.indexOf(" ") + 1), 160)}\``
    const plural = (k: number[]) => (k.length > 1 ? "s" : "")
    return [
      `- ${name} @${o.version}`,
      o.seen.length ? `${o.file ? "read" : "observed"} at this version at step${plural(o.seen)} ${o.seen.join(", ")}` : "",
      o.made.length ? `written or edited at step${plural(o.made)} ${o.made.join(", ")}` : "",
      o.seen.length > 1 ? "the same bytes each time" : "",
      shown
        ? `current bytes shown in full in step ${shown}`
        : inView.has(`${o.addr} @${o.version}`)
          ? "current bytes below"
          : o.file && o.bytes === undefined
            ? "current bytes not held here (an edit could not be compiled); read the file for them"
            : `snip rs${o.by.toString(36)}${hash36(log.head)} returns the step that holds them`,
    ]
      .filter(Boolean)
      .join(" · ")
  }
  // MECHANICAL PROSIFICATION: the model is handed what it could have written itself, plain working notes in
  // its own voice, never EOT notation or fold markup. Deterministic, rule-based, no model; the version number
  // is the only structure, and a later version replaces an earlier one entry by entry.
  const text = [
    `Working notes (version ${v}${v > 1 ? `, replacing version ${v - 1}` : ""}), as of step ${last}. Steps ${batch.map((a) => a.n).join(", ")} are summarized below; I can get the exact text of any of them with snip and its handle.`,
    ...batch.map((a) => `Step ${a.n} (${a.handle})${a.deps.length ? `, built on step ${a.deps.join(", ")}` : ""}: ${a.line}`),
    ...(changed.length ? [`What I have already looked at or changed in this task, at the latest version (no need to read these again unless the file changed on disk):`, ...changed.map(stateLine)] : []),
    ...(view.length ? [`Current file contents:`, ...view.map(([k, bytes]) => `--- ${k} ---\n${bytes}`)] : []),
  ].join("\n")
  return { text, facts }
}

// THE FOLD: the projection for this request. Under the gate the held projection is rendered as it stands (the
// request is the previous one plus the new step). Over it, ONE new event retires every live step the chain does
// not need; only when that cannot fit are needed steps retired too, oldest first (the frontier's newest step
// never), with their current bytes carried in the event. undefined when the turn has no steps.
export const projectSteps = (messages: Msg[], sizes: { tools: number; system: number }, prev: Projection | undefined, store?: Map<string, string>) => {
  const log = stepLog(messages)
  if (!log) return undefined
  const held: Projection = prev && prev.head === log.head ? prev : { head: log.head, retired: [], events: [], facts: {}, clips: [] }
  const limit = windowLimit(sizes.tools)
  if (!(limit > 0) || !Number.isFinite(limit)) return undefined
  // The window as it will be sent: with the cap's clips (measured: remembering clips as projection state, or
  // sizing raw so retirement replaces clipping, both cost more cache breaks on the live replay than this).
  const size = (out: Msg[]) => {
    const trial = structuredClone(out)
    capContext(trial, [{ text: "x".repeat(sizes.system) }], { fixed: sizes.tools, clipOnly: true })
    return contextChars(trial) + sizes.system
  }
  const gate = limit
  const current = renderProjection(messages, log, held)
  if (size(current) <= gate) return { messages: current, proj: held, log, event: undefined, clipped: false }
  const retired = new Set(held.retired)
  const live = log.acts.filter((a) => !retired.has(a.id))
  const need = neededSteps(log)
  const newest = log.acts.at(-1)!.n
  const free = live.filter((a) => !need.has(a.n))
  const forced = live.filter((a) => need.has(a.n) && a.n !== newest)
  const attempt = (batch: StepAct[], view: number) => {
    const gone = new Set(batch.map((a) => a.id))
    const keptAfter = new Set(log.acts.filter((a) => !retired.has(a.id) && !gone.has(a.id)).map((a) => a.n))
    const { text, facts } = projectionText(log, held, batch, keptAfter, view)
    const anchorN = Math.max(...batch.map((a) => a.n), ...held.events.map((ev) => log.acts.find((a) => a.id === ev.anchor)?.n ?? 0))
    const proj: Projection = {
      head: log.head,
      retired: [...held.retired, ...batch.map((a) => a.id)],
      events: [...held.events, { v: held.events.length + 1, anchor: log.acts[anchorN - 1].id, text }],
      facts: { ...held.facts, ...facts },
      clips: held.clips,
    }
    return { proj, out: renderProjection(messages, log, proj) }
  }
  // Hysteresis, as in the epoch fold: an overflow retires down to a low-water mark (`low` of the room above the
  // injected system), so many appended steps fit before the next event. Chain-needed steps are retired only
  // when the free ones cannot get there, oldest first.
  const low = 0.6
  const target = sizes.system + low * (limit - sizes.system)
  let best: ReturnType<typeof attempt> | undefined
  let fits: ReturnType<typeof attempt> | undefined
  search: for (const goal of [target, gate]) {
    for (let extra = 0; extra <= (goal === target ? 0 : forced.length); extra++) {
      const batch = [...free, ...forced.slice(0, extra)].sort((a, b) => a.n - b.n)
      if (batch.length === 0) continue
      for (const view of [viewCap(), 8_000, 2_000, 0]) {
        best = attempt(batch, view)
        if (size(best.out) <= goal) {
          fits = best
          break search
        }
      }
    }
  }
  best = fits ?? best
  if (!best) return { messages: current, proj: held, log, event: undefined, clipped: false }
  const batchIds = new Set(best.proj.retired.slice(held.retired.length))
  if (store) for (const a of log.acts) if (batchIds.has(a.id)) store.set(a.handle, a.raw)
  return { messages: best.out, proj: best.proj, log, event: best.proj.events.at(-1), clipped: false }
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
    // The ground is committed as a message directly, never admitted through the inbox: an admitted synthetic is a
    // pending input, and the runner answers it with another model step (the answer would appear twice).
    const bus = yield* Bus.Service
    // A person-notice that must not wake a model step goes straight onto the bus (the window draws it, the inbox never sees it). An inbox notice
    // delivered mid-turn resumes the turn with the whole history: 2026-10-23, every section of a piece cost two such steps (49-65k characters each).
    const noticeOnBus = (n: { sessionID: string; text: string; description: string }) =>
      bus.publish(SessionEvent.Synthetic, { sessionID: n.sessionID as never, text: n.text, description: n.description })

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
    const windows = new Map<string, { before: number; after: number; tools: number; withheld?: number }>()
    // physics: the file a derived-edit turn presented, waiting for the model's reply; sessions whose derived edit was refused go the tool path next.
    const armed = new Map<string, { plan: Extract<Physics.Plan, { kind: "edit" }>; ask: string; at: number }>()
    const physicsAside = new Set<string>()
    const pending = new Map<string, { hold: { plan: Extract<Physics.Plan, { kind: "edit" }>; ask: string; at: number }; text: string; first: Physics.Derived }>()
    const refused = new Set<string>()
    const servedTurn = new Set<string>()
    // The held step-fold cut per session (prefix-stable epochs, see stableStepCut).
    const stepEpochs = new Map<string, StepEpoch>()
    // The append-only step projection per session (see projectSteps): which steps are retired, and its events.
    const stepProjections = new Map<string, Projection>()
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
    // the sentences the reader asked to revise this turn (the app's fold note), handed to the door with the answer's ground
    const revising = new Map<string, Revise[]>()
    // the sentences a hand-back asked the model to restate: its reply is their revision
    const selfRevising = new Map<string, Revise[]>()
    // What the turn was handed to read (its tool results), kept so the door can ground the answer against it.
    const turnMaterial = new Map<string, Array<{ name: string; text: string }>>()
    const gatheredMaterial = new Map<string, Array<{ name: string; text: string }>>()
    // sessions whose current ask a gather answered: the grounding check still renders for the person, but is never handed back to the
    // model (measured: its hand-back on a gathered answer restored the tools and ran 86 more requests, 832k tokens, on a 2.9k-token answer)
    const gatheredTurn = new Set<string>()
    // sessions whose next primary model call is pointed at the door's gather answer (id of the answer the door kept)
    const gatherRedirect = new Map<string, string>()
    // the lines of a door-served answer that measure the run rather than quote a page: shown to the person, never sent to be graded as claims
    const gatherNotes = new Map<string, Set<string>>()
    // a piece in progress: the door's job id, and the prompt the next model call is asked (a resume replaces the whole window with it)
    // `current`: the section (or gap) the pending prompt asks for, so the judging notice names it; `calls`: model calls served so far; layers mode
    // keeps its gap queue (tree order, each with its depth), the latest outline rows and the marked tally here
    type GenerateEntry = {
      job: string; finished: boolean; topic: string; kind: string; sources: number; mode: "sections" | "layers"; startedAt: number; calls: number
      current: { section: string; title: string; facts: number } | null; outline: GenerateOutline
      gaps: GenerateGap[]; gap: GenerateGap | null; marked: { marked: number; placed: number }; text: string; path: string
    }
    const generateJobs = new Map<string, GenerateEntry>()
    const generatePending = new Map<string, string>()
    // sessions with a "fold longform ·" mark waiting in the inbox: one mark keeps a headless turn alive between calls, and a turn that continues on its
    // own (an output-limit continuation, a step with tool calls) must not queue another for every section — each leftover mark is a model call
    const generateMarkQueued = new Set<string>()
    // steps that arrived with tool calls the section window never offered (recorded, re-asked; capped so a model that only calls tools ends the run)
    const generateToolSteps = new Map<string, number>()
    // a reply refused by the shape check once (re-asked once with the same prompt; a repeat is left to the door to grade)
    const generateShapeRetried = new Set<string>()
    // the section prompt the window last served per session: a step whose pending prompt was not served yet is a section call even when
    // the queued "fold longform ·" mark was not promoted (headless `opencode run` continues the turn instead of admitting the queue)
    const generateServed = new Map<string, string>()
    // a section's grading at the door, in flight: the next call is queued BEFORE the door grades (so the turn never goes idle in between —
    // a headless run exits on idle), and that call waits here for the step's result before its window is set
    const generateInFlight = new Map<string, Deferred.Deferred<void>>()
    // ARM the next call while this one runs: a queued "fold longform ·" mark waits in the inbox for this call to end, so the turn never goes idle
    // between sections (a headless run exits on idle); that call's window then waits on the gate until the door has graded this section
    const generateArm = (sessionID: string) =>
      Effect.gen(function* () {
        const entry = generateJobs.get(sessionID)
        if (!entry || entry.finished) return
        if (!generateInFlight.has(sessionID)) generateInFlight.set(sessionID, yield* Deferred.make<void>())
        if (generateMarkQueued.has(sessionID)) return
        generateMarkQueued.add(sessionID)
        yield* ctx.session.synthetic({ sessionID: sessionID as never, text: `${LONGFORM_MARK} the next call`, description: "fold longform — the next call", delivery: "queue", resume: true })
      }).pipe(Effect.ignore)
    // how many times the current section has been re-asked after the model gave nothing (capped, so a dead model ends the run cleanly)
    const generateRetries = new Map<string, number>()
    // sessions whose served section prompt awaits the model's reply: a reply advances the piece once, and a text that answers no served prompt
    // (a notice-woken step, a second text part of the same reply) advances nothing. 2026-10-23: eleven interim notices delivered as one batch
    // each woke a step, and five "Done." replies consumed five sections.
    const generateAwaiting = new Set<string>()
    // sessions whose longform research has already been shown to the person (so the notice posts once, not per context pass)
    const generateResearched = new Set<string>()
    // What the model itself said earlier in the session, so the door never reads its own words back as evidence for them.
    const ownTexts = new Map<string, string[]>()
    // A session whose last answer was handed a grounding note: the NEXT answer replies to that note and is not handed another.
    const steerOutstanding = new Set<string>()
    // The ask a session was last handed a grounding note for: a person's turn is steered once, and never when the turn already used tools
    // (measured: a hand-back on an answer built from fetched pages restored the tools and ran 86 more requests, 832k tokens, on a 2.9k-token answer).
    const steeredAsk = new Map<string, string>()
    const noticeWoken = new Map<string, string>()
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
        // A step whose newest message IS a notice was woken by the notice itself (a steer promotes at the step
        // boundary): its answer is not a reply to the person, so it is not faced — otherwise each facing's notice
        // wakes another step, whose facing posts another notice, without end.
        let woken = false
        for (let i = event.messages.length - 1; i >= 0; i--) {
          const text = event.messages[i].content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
          if (isPersonNotice(text)) {
            if (i === event.messages.length - 1 && !isGroundNotice(text)) woken = true
            event.messages.splice(i, 1)
          }
        }
        // The wake and everything the run does after it (tool calls, the answer) belong to one ask: remember which.
        if (woken) noticeWoken.set(event.sessionID, lastUserText(event.messages))
        // THE LEDGER'S "BEFORE": the window exactly as the harness assembled it (messages + system), after our own
        // notices are stripped. Everything the fold changes from here on is measured against this number; the
        // tap (usage-tap.ts) joins it to the provider's own token count for the request that follows.
        const windowBefore = contextChars(event.messages) + systemChars(event.system)
        // the person's own words, kept before a gather or physics turn rewrites the last message: the register ingests THESE
        const originalAsk = lastUserText(event.messages)
        let researchAsk = false
        // PHYSICS: serve a read/edit-class turn without tool definitions; decline (recorded) and fall through otherwise.
        let withheld = 0
        // set when this call's window is a longform section: the hook then skips every block that adds to an ask's window (the door's context
        // post and its standing blocks, surf, the step fold, the legends) — a section window is the section and nothing else
        let generateServedNow = false
        const physicsOn = physicsServes(event.model.providerID)
        if (physicsOn || gatherOn) {
          const last = event.messages.at(-1)
          const realAsk = last?.role === "user" && last.content.every((part) => part.type === "text")
          const ask = lastUserText(event.messages)
          armed.delete(event.sessionID)
          const answered = physicsOn && last?.role === "assistant" && !last.content.some((part) => part.type === "tool-call") && servedTurn.has(event.sessionID)
          // THE LONGFORM OWNS THE TURN. Once the door has started a piece for this session, EVERY model call until the piece is done is a section call,
          // whatever the last message's role is (the queued mark, the model's own reply, a tool result): the window is the pending section prompt, no tools,
          // and the original ask's history never reaches the model. Only a NEW ask from the person (not the mark) takes the turn back (the reset below).
          // Measured without this (2026-10-24, ses_e93f6381): the section-1 step continued on its own, the hook saw an assistant last message with the
          // pending prompt already served, and fell through to the agent loop — thirty prompts with the full coding system prompt and 21 tools in 25 s,
          // nine tool calls, and the model then answered the original ask into section 2.
          const generateMark = realAsk && ask.startsWith(LONGFORM_MARK)
          if (generateMark) generateMarkQueued.delete(event.sessionID)
          const generateOwned = generateJobs.has(event.sessionID) && (!realAsk || generateMark)
          // a leftover mark after the piece is done (the job is gone, the pending prompt remains): answered with one word, never the agent loop
          const generateResume = generateOwned || (generateMark && generatePending.has(event.sessionID))
          const routed = !generateResume && realAsk && gatherOn && routeOn ? yield* post({ event: "route", ask, hasHistory: event.messages.length > 1 }, routeTimeout, true) : undefined
          const routeKnown = typeof routed?.research === "boolean"
          // THE REGISTER FIRST: a question the conversation itself answers is answered from the session's own stated facts and is never
          // web research. The door ingests this ask's statements on the same call, so a fact stated now is registered for the next turn.
          // Fails open: no door, no hit, the route decides as before.
          const regTask = registerOn && realAsk && !generateResume && event.messages.length > 1 ? yield* taskOf(event.sessionID) : undefined
          const regWorkspace = registerOn && realAsk && !generateResume && event.messages.length > 1 ? yield* workspaceOf(event.sessionID) : undefined
          const registered = registerOn && realAsk && !generateResume && event.messages.length > 1
            ? yield* post({ event: "register", op: "answer", sessionID: event.sessionID, task: regTask, workspace: regWorkspace, ask, turns: priorTurns(event.messages) }, 4000, true)
            : undefined
          const fromRegister = registerHit(registered)
          if (fromRegister) physicsRecord({ sessionID: event.sessionID, served: false, reason: "register: the conversation itself answers this ask", ask, competency: registered.answer.competency })
          // an ask that names the workspace's own things is never gathered from the web, whatever the router said: the tool path searches the workspace
          researchAsk = realAsk && !Physics.workspaceish(ask) && (routeKnown ? routed.research === true : Physics.classify(ask) === "search")
          const searching = !generateResume && realAsk && gatherOn && !fromRegister && !Physics.workspaceish(ask) && (routeKnown ? routed.research === true : Physics.classify(ask) === "search")
          if (realAsk && !generateResume) { gatheredTurn.delete(event.sessionID); gatherNotes.delete(event.sessionID); generateJobs.delete(event.sessionID); generatePending.delete(event.sessionID); generateServed.delete(event.sessionID); generateInFlight.delete(event.sessionID); generateResearched.delete(event.sessionID); generateRetries.delete(event.sessionID); generateMarkQueued.delete(event.sessionID); generateToolSteps.delete(event.sessionID); generateShapeRetried.delete(event.sessionID) }
          // an LONGFORM ask is started at the door (gather, outline, the file, the first section's prompt); when it cannot start, the generic gather below takes it
          // a LONGFORM ask: the router names the FORM (any language, from its kind dictionary); the English predicate is only a fallback
          // a PRODUCE ask: the router typed it as an account WITH a form (whatever form it names), or the English predicate caught a prose ask; the kind rides on
          const generateAskTurn = routeKnown && routed?.kind === "account" && ((typeof routed?.form === "string" && routed.form.length > 0) || Physics.longformAsk(ask))
          const generateKind = generateKindOf(routed?.form)
          // WHILE THE DOOR READS: the window is told what is being read (pages read so far, the page being read now, elapsed), every few
          // seconds while it changes, instead of "working" for a minute. The door keeps the progress; this only reads and relays it.
          // WHILE THE DOOR READS: the window is shown the research itself (queries, the page being read, the pages read, elapsed), replaced every few
          // seconds while it changes. It rides the event bus as a fold-research notice (metadata the window draws in place of "Working"); it is never put
          // in the session's inbox, because an inbox notice delivered mid-turn wakes a model step (2026-10-23: eleven of them ate five sections).
          type ResearchPage = { host: string; title?: string }
          type ResearchProgress = { ok?: boolean; done?: boolean; elapsedMs?: number; candidates?: number; read?: ResearchPage[]; reading?: ResearchPage | null; searches?: Array<{ q?: string; n?: number }>; stop?: string | null }
          const readingWatch = (sessionID: string) =>
            Effect.gen(function* () {
              let last = ""
              while (true) {
                yield* Effect.sleep("3 seconds")
                const p = (yield* Effect.tryPromise(() =>
                  fetch(`${base}/v1/hooks/opencode/gather/progress?sessionID=${encodeURIComponent(sessionID)}`, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : undefined)),
                ).pipe(Effect.catch(() => Effect.succeed(undefined)))) as ResearchProgress | undefined
                if (!p || p.ok !== true) continue
                const read = Array.isArray(p.read) ? p.read : []
                const key = `${read.length}|${p.candidates ?? 0}|${p.reading?.host ?? ""}|${(p.searches ?? []).length}|${p.done ? 1 : 0}`
                if (key === last) continue
                last = key
                const research = { v: 1, elapsedMs: Number(p.elapsedMs ?? 0), searches: (p.searches ?? []).flatMap((s) => (typeof s.q === "string" ? [{ q: s.q, n: Number(s.n) || 0 }] : [])), candidates: Number(p.candidates ?? 0), read, reading: p.reading ?? null, stop: p.stop ?? null, done: p.done === true }
                yield* bus.publish(SessionEvent.Synthetic, { sessionID: sessionID as never, text: `fold measured · researching… ${read.length} page(s) read`, description: "fold research — what is being read", metadata: { notice: "fold-research", research } })
                if (p.done) return
              }
            })
          const researchDone = (sessionID: string) =>
            Effect.gen(function* () {
              const p = (yield* Effect.tryPromise(() =>
                fetch(`${base}/v1/hooks/opencode/gather/progress?sessionID=${encodeURIComponent(sessionID)}`, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? r.json() : undefined)),
              ).pipe(Effect.catch(() => Effect.succeed(undefined)))) as ResearchProgress | undefined
              if (!p || p.ok !== true) return
              const read = Array.isArray(p.read) ? p.read : []
              const research = { v: 1, elapsedMs: Number(p.elapsedMs ?? 0), searches: (p.searches ?? []).flatMap((s) => (typeof s.q === "string" ? [{ q: s.q, n: Number(s.n) || 0 }] : [])), candidates: Number(p.candidates ?? 0), read, reading: null, stop: p.stop ?? null, done: true }
              yield* bus.publish(SessionEvent.Synthetic, { sessionID: sessionID as never, text: `fold measured · research — ${read.length} page(s) read`, description: "fold research — what was read", metadata: { notice: "fold-research", research } })
            }).pipe(Effect.ignore)
          const generateWatch = searching && generateOn && generateAskTurn ? yield* Effect.forkChild(readingWatch(event.sessionID), { startImmediately: true }) : undefined
          // `kind` (and `form`, the router's own word) ride into every door call, so the stitched layer can split its units per kind
          const generateAskBody = { sessionID: event.sessionID, ask, ...(typeof routed?.topic === "string" && routed.topic ? { topic: routed.topic } : {}), kind: generateKind, form: routed?.form, freeform: generateFreeform, softMs: gatherLongformSoftMs, budgetMs: gatherBudgetMs }
          // LAYER A first (layers mode): the door stitches the piece from the sources with no model; the gaps it leaves are the model's work. A door
          // that does not know the op (or fails) is recorded and the sections path is taken instead — the longform never falls to the agent loop for it.
          const generateStitchRes = searching && generateOn && generateAskTurn && generateMode === "layers"
            ? yield* post({ event: "longform", op: "stitch", ...generateAskBody, depth: generateDepth, calls: generateCallBudget }, gatherBudgetMs + 15_000, true)
            : undefined
          const generateStitched = generateStitchRes?.ok === true && typeof generateStitchRes.job === "string"
          if (searching && generateOn && generateAskTurn && generateMode === "layers" && !generateStitched) physicsRecord({ sessionID: event.sessionID, served: false, reason: `longform stitch not ok; taking the sections path: ${JSON.stringify(generateStitchRes ?? null).slice(0, 300)}` })
          const generateStartRes = searching && generateOn && generateAskTurn && !generateStitched
            ? yield* post({ event: "longform", op: "start", ...generateAskBody }, gatherBudgetMs + 15_000, true)
            : undefined
          if (generateWatch) yield* Fiber.interrupt(generateWatch)
          if (generateWatch) yield* researchDone(event.sessionID)
          const generateStarted = generateStartRes?.ok === true && typeof generateStartRes.prompt === "string" && typeof generateStartRes.job === "string"
          if (searching && generateAskTurn && !generateStarted && !generateStitched) physicsRecord({ sessionID: event.sessionID, served: false, reason: `longform start not ok: ${JSON.stringify(generateStartRes ?? null).slice(0, 300)}` })
          // THE SECTION WINDOW carries nothing but the section: one system line and the prompt as the one user message — never the history, never
          // the piece, no tools, and none of the standing blocks the door adds to an ask (openness, memory, lane, recall, the grading legend): the
          // hook returns right after this block when it is set (`generateServedNow`), so nothing below appends to it.
          const generateWindow = (prompt: string) => {
            generateServedNow = true
            generateAwaiting.add(event.sessionID)
            generateServed.set(event.sessionID, prompt)
            const entry = generateJobs.get(event.sessionID)
            if (entry) entry.calls++
            withheld = toolChars(event.tools)
            for (const name of Object.keys(event.tools)) delete event.tools[name]
            const layersLine = `You write one part of a ${generateNoun(entry?.kind ?? "prose")}, from the snips you are given: only what they state, in your own words.`
            event.system.splice(0, event.system.length, { type: "text", text: entry?.mode === "layers" ? layersLine : generateFreeform ? "You write one section of a piece, from the facts you are given, in your own words." : "You write one section of a piece, from the lines you are given." })
            event.messages.splice(0, event.messages.length, Message.make({ id: last!.id, role: "user", content: [{ type: "text", text: prompt }], metadata: last!.metadata, providerMetadata: last!.providerMetadata, native: last!.native }))
          }
          if (generateResume) {
            const entry = generateJobs.get(event.sessionID)
            // a step that arrived with tool calls the window never offered: recorded as its own row, and the section is simply asked again (the
            // text.ended path treats a reply with no text as "no text", capped); a model that only calls tools ends the run after a few such steps
            const sinceAsk = event.messages.slice(event.messages.findLastIndex((m) => m.role === "user" && m.content.some((p) => p.type === "text")) + 1)
            if (entry && last?.role !== "user" && sinceAsk.some((m) => m.role === "assistant" && m.content.some((p) => p.type === "tool-call"))) {
              const n = (generateToolSteps.get(event.sessionID) ?? 0) + 1
              generateToolSteps.set(event.sessionID, n)
              physicsRecord({ sessionID: event.sessionID, served: false, reason: `longform: the model asked for tools it was not given (step ${n}); re-asking the section`, job: entry.job })
              if (n > 3) {
                physicsRecord({ sessionID: event.sessionID, served: false, reason: "longform: the model kept asking for tools; ending the run", job: entry.job })
                generateJobs.delete(event.sessionID)
                generatePending.set(event.sessionID, "Reply with the one word: done.")
                const gate = generateInFlight.get(event.sessionID)
                if (gate) { generateInFlight.delete(event.sessionID); yield* Deferred.succeed(gate, undefined) }
              }
            }
            // the pending prompt was served already and the door is still grading its reply: wait on the gate (never fall through to the agent loop)
            const gate = generateInFlight.get(event.sessionID)
            if (gate) { generateInFlight.delete(event.sessionID); yield* Deferred.await(gate).pipe(Effect.timeout("200 seconds"), Effect.ignore) }
            const pending = generateJobs.has(event.sessionID) ? (generatePending.get(event.sessionID) ?? "") : "Reply with the one word: done."
            generateWindow(pending)
            yield* generateArm(event.sessionID)
            physicsRecord({ sessionID: event.sessionID, served: true, kind: "longform-section", job: generateJobs.get(event.sessionID)?.job, lastRole: last?.role, chars: pending.length, withheldToolChars: withheld })
          } else if (generateStitched) {
            // LAYERS: the stitched piece is already a result (shown now, as data on the bus); the model is asked for the gaps, in tree order
            gatheredTurn.add(event.sessionID)
            const res = generateStitchRes!
            const generateTopic = typeof res.topic === "string" && res.topic ? res.topic : typeof routed?.topic === "string" && routed.topic ? routed.topic : ask
            const generateSources = Array.isArray(res.sources) ? res.sources.length : Number(res.sources) || 0
            const gaps = generateGapsOf(res.gaps, 0)
            const stitchedText = typeof res.text === "string" ? res.text : ""
            // the rows: the stitched sections (opencode-stitch.mjs sectionsOf: id, title, gap, sentences) as filled or gap, then every gap slot under
            // them (a sub-slot "s2.g1" is its own row, at its depth) — the door's `outline`, when it sends one, wins
            const treeRows = generateOutlineOf(res.outline)
            const sectionRows: GenerateOutline = (Array.isArray(res.sections) ? (res.sections as unknown[]) : []).flatMap((sec, i) => { const o = sec as Record<string, unknown>; const id = typeof o?.id === "string" ? o.id : typeof o?.slot === "string" ? o.slot : `f${i + 1}`; return [{ id, title: typeof o?.title === "string" ? o.title : typeof o?.label === "string" ? o.label : id, state: o?.gap === true ? ("gap" as const) : ("filled" as const), facts: Number(o?.sentences ?? o?.facts) || 0, layer: o?.gap === true ? ("drawn" as const) : ("stitched" as const) }] })
            const gapRows: GenerateOutline = gaps.filter((g) => !sectionRows.some((r) => r.id === g.slot)).map((g) => ({ id: g.slot, title: g.label, state: "gap" as const, facts: g.context.length, layer: "drawn" as const, depth: Number((g as unknown as { level?: number }).level) || 1 }))
            const outline: GenerateOutline = treeRows.length ? treeRows : [...sectionRows, ...gapRows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
            const entry: GenerateEntry = { job: String(res.job), finished: false, topic: generateTopic, kind: generateKind, sources: generateSources, mode: "layers", startedAt: Date.now(), calls: 0, current: null, outline, gaps, gap: null, marked: { marked: 0, placed: 0 }, text: stitchedText, path: typeof res.path === "string" ? res.path : "" }
            generateJobs.set(event.sessionID, entry)
            generateRetries.set(event.sessionID, 0)
            const ps = Array.isArray(res.passages) ? (res.passages as Array<{ name: string; text: string }>) : []
            if (ps.length) gatheredMaterial.set(event.sessionID, ps)
            if (!generateResearched.has(event.sessionID)) { generateResearched.add(event.sessionID); yield* noticeOnBus(researchNotice(event.sessionID, generateSources || ps.length, ps)) }
            const filled = Number(res.filled) || outline.filter((s) => s.state === "filled").length
            yield* bus.publish(SessionEvent.Synthetic, generateNotice(event.sessionID, { topic: generateTopic, kind: generateKind, outline, round: 0, done: false, sources: generateSources, startedAt: entry.startedAt, calls: 0, layer: "stitched", marked: entry.marked, stitched: { filled, gaps: gaps.length, ...(stitchedText ? { text: stitchedText.slice(0, 20_000) } : {}) } }))
            const first = gaps.shift()
            if (first) {
              entry.gap = first
              entry.current = { section: first.slot, title: first.label, facts: first.context.length }
              const prompt = generateGapPrompt(generateTopic, first, generateKind)
              generatePending.set(event.sessionID, prompt)
              generateWindow(prompt)
              yield* generateArm(event.sessionID)
              const row = entry.outline.find((s) => s.id === first.slot)
              if (row) row.state = "drawing"
              yield* bus.publish(SessionEvent.Synthetic, generateNotice(event.sessionID, { topic: generateTopic, kind: generateKind, outline: entry.outline, round: 0, done: false, sources: generateSources, startedAt: entry.startedAt, calls: entry.calls, layer: "drawn", marked: entry.marked }))
              yield* noticeOnBus(materialNotice(event.sessionID, first.label, first.context.map(generateSnipLine).filter(Boolean)))
            } else {
              // nothing left for the model: the stitched piece is the piece; one call returns it as written (the door's own answer when it gave an id)
              entry.finished = true
              if (typeof res.id === "string") gatherRedirect.set(event.sessionID, res.id)
              const prompt = stitchedText ? `Return this piece exactly as written, nothing before or after it:\n\n${yield* withConfession(entry.job, stitchedText)}` : "Reply with the one word: done."
              generatePending.set(event.sessionID, prompt)
              generateWindow(prompt)
              yield* bus.publish(SessionEvent.Synthetic, generateNotice(event.sessionID, { topic: generateTopic, kind: generateKind, outline: entry.outline, round: 0, done: true, sources: generateSources, startedAt: entry.startedAt, calls: entry.calls, layer: "stitched", marked: entry.marked }))
            }
            physicsRecord({ sessionID: event.sessionID, served: true, kind: "longform-stitch", route: { kind: routed?.kind, topic: routed?.topic }, job: res.job, filled, gaps: gaps.length + (first ? 1 : 0), sources: generateSources, chars: stitchedText.length, withheldToolChars: withheld })
          } else if (generateStarted) {
            gatheredTurn.add(event.sessionID) // a piece is written from what was read: the ground's hand-back never steers a section
            const generateTopic = typeof generateStartRes!.topic === "string" && generateStartRes!.topic ? generateStartRes!.topic : typeof routed?.topic === "string" && routed.topic ? routed.topic : ask
            const generateSources = Number(generateStartRes!.sources) || 0
            const startOutline = generateOutlineOf(generateStartRes!.outline)
            const startFacts = Array.isArray(generateStartRes!.facts) ? (generateStartRes!.facts as unknown[]).length : 0
            generateJobs.set(event.sessionID, { job: String(generateStartRes!.job), finished: false, topic: generateTopic, kind: generateKind, sources: generateSources, mode: "sections", startedAt: Date.now(), calls: 0, current: { section: String(generateStartRes!.section ?? "s1"), title: String(generateStartRes!.title ?? generateStartRes!.section ?? "s1"), facts: startFacts }, outline: startOutline, gaps: [], gap: null, marked: { marked: 0, placed: 0 }, text: "", path: "" })
            generatePending.set(event.sessionID, String(generateStartRes!.prompt))
            generateRetries.set(event.sessionID, 0)
            const ps = Array.isArray(generateStartRes!.passages) ? (generateStartRes!.passages as Array<{ name: string; text: string }>) : []
            if (ps.length) gatheredMaterial.set(event.sessionID, ps)
            gatheredTurn.add(event.sessionID)
            generateWindow(String(generateStartRes!.prompt))
            yield* generateArm(event.sessionID)
            physicsRecord({ sessionID: event.sessionID, served: true, kind: "longform-start", route: { kind: routed?.kind, topic: routed?.topic }, job: generateStartRes!.job, sections: generateStartRes!.sections, sources: generateStartRes!.sources, withheldToolChars: withheld })
            // what it researched (the general research notice; the piece's own gather is the same reading a plain account gets)
            if (!generateResearched.has(event.sessionID)) { generateResearched.add(event.sessionID); yield* noticeOnBus(researchNotice(event.sessionID, Number(generateStartRes!.sources ?? ps.length), ps)) }
            // the piece's progress as data (s1 writing, the rest planned): the window's one live panel for the piece
            const started = generateJobs.get(event.sessionID)!
            if (startOutline.length) yield* bus.publish(SessionEvent.Synthetic, generateNotice(event.sessionID, { topic: generateTopic, kind: generateKind, outline: startOutline, round: 0, done: false, sources: generateSources, startedAt: started.startedAt, calls: started.calls }))
          } else if (answered) {
            // an answer that missed is restructured here, inside the request, so the session stays open while REC runs
            yield* settle(event.sessionID)
            // the loop's own follow-up after a derived reply: no tools to call, so none are sent
            withheld = toolChars(event.tools)
            for (const name of Object.keys(event.tools)) delete event.tools[name]
            event.system.splice(0, event.system.length, { type: "text", text: "You are a coding assistant." })
            physicsRecord({ sessionID: event.sessionID, served: true, kind: "follow-up", withheldToolChars: withheld })
          } else if (!realAsk) {
            if (physicsOn) physicsRecord({ sessionID: event.sessionID, served: false, reason: "mid-turn: tool results are in the window" })
          } else if (refused.delete(event.sessionID) && physicsOn) physicsRecord({ sessionID: event.sessionID, served: false, reason: "fallback: the previous derived edit was refused", ask })
          else if (searching) {
            // GATHER, THROUGH THE DOOR: the research (search, gate, read, stop) and the reading (statements selected by the asker's
            // stance) run in the door's worker; this turn waits for that and no model is asked to search or to write.
            const gatherWatch = yield* Effect.forkChild(readingWatch(event.sessionID), { startImmediately: true })
            const door = yield* post({ event: "gather", sessionID: event.sessionID, ask, budgetMs: gatherBudgetMs, ...(routeKnown && typeof routed?.topic === "string" && routed.topic ? { topic: routed.topic } : {}), ...(routeKnown && typeof routed?.kind === "string" ? { kind: routed.kind } : {}), ...(routeKnown && routed?.kind === "account" ? { softMs: gatherAccountSoftMs } : {}) }, gatherBudgetMs + 10_000, true)
            yield* Fiber.interrupt(gatherWatch)
            yield* researchDone(event.sessionID)
            const result = door?.ok === true ? (door.result as GatherResult | undefined) : undefined
            const id = typeof door?.id === "string" ? door.id : undefined
            const strip = () => {
              withheld = toolChars(event.tools)
              for (const name of Object.keys(event.tools)) delete event.tools[name]
              event.system.splice(0, event.system.length, { type: "text", text: "You answer from the sources you are given." })
            }
            const say = (text: string) => {
              const index = event.messages.length - 1
              event.messages[index] = Message.make({ id: last.id, role: last.role, content: [{ type: "text", text }], metadata: last.metadata, providerMetadata: last.providerMetadata, native: last.native })
            }
            if (result && result.sources.length === 0) {
              // nothing was read (a throttled search, a typo that matches no page); serving "Nothing was read" as the answer would end the turn on a non-answer
              // The model answers WITHOUT its tools: left with them it searches for itself, step after step (measured 2026-10-21: 45 and 67 steps,
              // 385k and 541k tokens for one factual question), and its footnotes are not the pages'. It is told plainly that nothing was read.
              strip()
              say(`${ask}\n\nNo page could be read for this. Answer briefly from general knowledge, and say that the answer is not sourced.`)
              gatheredTurn.add(event.sessionID)
              physicsRecord({ sessionID: event.sessionID, served: true, kind: "gather-empty", ask, gaps: result.gaps, stop: result.stop, withheldToolChars: withheld })
            } else if (!result && gatherFallbackTools) {
              physicsRecord({ sessionID: event.sessionID, served: false, reason: "gather: the door did not gather", ask, error: door?.error })
            } else if (!result) {
              strip()
              say(`${ask}\n\nNothing could be read for this ask (the research service did not answer: ${String(door?.error ?? "unreachable")}). In one or two sentences, tell the person that no sources were read, say why, and offer to try again.`)
              gatheredTurn.add(event.sessionID)
              physicsRecord({ sessionID: event.sessionID, served: true, kind: "gather-down", error: door?.error, withheldToolChars: withheld })
            } else {
              // what was read is this turn's material, so the ground check weighs the answer against the pages (applied after the new-ask reset below)
              gatheredMaterial.set(event.sessionID, result.passages.filter((p) => !/wikipedia\.org|wikimedia\.org/i.test(p.name)))
              strip()
              const viaDoor = gatherZero && routed?.kind !== "account" && id !== undefined && gatherViaDoor.includes(event.model.providerID)
              if (viaDoor) {
                gatherRedirect.set(event.sessionID, id)
                gatherNotes.set(event.sessionID, new Set((result.notes ?? []).map((l) => String(l).trim())))
              } else {
                gatherNotes.delete(event.sessionID)
                // the pages, parsed: each read page's own holograph (its selected sentences and their neighbours), by site, bounded; the
                // research record (the run's measurements) stays out. The model writes the piece in its own prose from them, and the
                // ground check weighs that prose against the same passages afterwards. Asked to write "from these lines only", it strung
                // quotations together with "according to" after each, which is neither a piece nor graded as support.
                const pages = result.passages.filter((p) => /^https?:/.test(p.name) && !/wikipedia\.org|wikimedia\.org/i.test(p.name)).slice(0, 10)
                const notes = pages.map((p) => `From ${new URL(p.name).hostname.replace(/^www\./, "")}:\n${p.text.replace(/\s*\n\s*/g, " ").slice(0, 1200)}`).join("\n\n")
                const form = generateAskTurn ? "the piece: a title, an opening paragraph, body paragraphs that each develop one idea, and a closing paragraph" : "the answer as connected prose"
                // THE VOID: the gaps an account has to fill, defined from the corpus (what several independent pages say several things
                // about), each with the pages' sentences that bear on it; the piece is those gaps filled, in order
                const voids = (result.voids ?? []).map((v) => ({ ...v, sentences: v.sentences.filter((s) => !/wikipedia/i.test(s.host)) })).filter((v) => v.sentences.length >= 3)
                const gaps = voids.map((v) => `About ${v.label}:\n${v.sentences.map((s) => `- ${s.text}`).join("\n")}`).join("\n\n")
                say(voids.length >= 2 && generateAskTurn
                  ? `${ask}\n\nThe facts the pages state, grouped by what they are about:\n\n${gaps}\n\nWrite it as you would write any piece: your own structure, voice and transitions, in your own words. Do not copy or quote the lines above; weave their facts into your own sentences, one fact per sentence, so each sentence can be checked against the facts above. Every fact and figure in it comes from the facts above.`
                  : `${ask}\n\nWhat the pages read for this say (each block is one page's own sentences):\n\n${notes || result.text}\n\nWrite ${form}, in your own words. Its facts and figures are the pages' own, and its sentences name no page.`)
              }
              yield* noticeOnBus(researchNotice(event.sessionID, result.sources.length, result.passages))
              gatheredTurn.add(event.sessionID)
              physicsRecord({ sessionID: event.sessionID, served: true, kind: viaDoor ? "gather-door" : "gather-model", route: routeKnown ? { kind: routed?.kind, topic: routed?.topic } : undefined, modelCalls: viaDoor ? 0 : 1, sources: result.sources.length, calls: result.calls, stop: result.stop, gaps: result.gaps, withheldToolChars: withheld })
            }
          } else if (!physicsOn) {
            // not a gather ask, and physics does not serve this provider: the normal path
          } else {
            const workspace = yield* workspaceOf(event.sessionID)
            const plan = Physics.resolve(ask, workspace)
            if (plan.kind === "decline") servedTurn.delete(event.sessionID)
            if (plan.kind === "decline" || plan.kind === "gather") physicsRecord({ sessionID: event.sessionID, served: false, reason: plan.kind === "decline" ? plan.reason : "gather resolved off the gather path", ask, workspace })
            else {
              // TAUGHT: a recipe the machine learned earlier answers this ask with no model; the model is only asked to say what changed.
              const made =
                plan.kind === "edit"
                  ? (() => {
                      const hit = Physics.taught(plan, ask, Learn.load(physicsRecipes))
                      if (!hit) return undefined
                      const w = Physics.commit(plan, hit.derived.after)
                      if (!w.ok) return undefined
                      Learn.won(physicsRecipes, hit.recipe)
                      physicsRecord({ sessionID: event.sessionID, edit: plan.file, ok: true, by: "recipe", skeleton: hit.recipe.skeleton, checked: hit.derived.checked })
                      return { after: hit.derived.after }
                    })()
                  : undefined
              withheld = toolChars(event.tools)
              for (const name of Object.keys(event.tools)) delete event.tools[name]
              // the system is a plain statement of fact: where the work is. Standing prompts that speak of tools are not sent.
              event.system.splice(0, event.system.length, { type: "text", text: `You are a coding assistant. The project is at ${workspace}.` })
              const index = event.messages.length - 1
              event.messages[index] = Message.make({
                id: last.id,
                role: last.role,
                content: [{ type: "text", text: made ? Physics.presentDone(plan as Extract<Physics.Plan, { kind: "edit" }>, ask, made.after) : Physics.present(plan, ask) }],
                metadata: last.metadata,
                providerMetadata: last.providerMetadata,
                native: last.native,
              })
              servedTurn.add(event.sessionID)
              if (plan.kind === "edit" && !made) armed.set(event.sessionID, { plan, ask, at: Date.now() })
              physicsRecord({ sessionID: event.sessionID, served: true, kind: plan.kind, file: plan.file, withheldToolChars: withheld })
            }
          }
        }
        // A SECTION WINDOW IS DONE HERE: the material it was read from becomes the turn's material (so the facing weighs the section against the pages),
        // the ledger takes its before/after, and nothing below runs — no door context post (openness, memory, lane, recall), no surf or step fold,
        // no legend tail. Measured before this (ses_e93f6381): the section window carried <fold-openness> and <fold-memory> blocks and the grading legend.
        if (generateServedNow) {
          const gathered = gatheredMaterial.get(event.sessionID)
          if (gathered) { turnMaterial.set(event.sessionID, gathered); gatheredMaterial.delete(event.sessionID) }
          lastAsk.set(event.sessionID, lastUserText(event.messages))
          lastModel.set(event.sessionID, event.model)
          windows.set(event.sessionID, { before: windowBefore, after: contextChars(event.messages) + systemChars(event.system), tools: 0, ...(withheld ? { withheld } : {}) })
          return
        }
        // THE TOOL GATE: on a plain ask (not served by physics, gather or longform, which send no tools at all), the fold's own tools
        // the turn cannot use are not sent. Counted as withheld, so the ledger sees it.
        if (toolGateOn && isNewAsk(event.messages) && !gatheredTurn.has(event.sessionID) && !generateJobs.has(event.sessionID) && !servedTurn.has(event.sessionID)) {
          const before = toolChars(event.tools)
          if (gateTools(event.tools, originalAsk, { research: researchAsk }).length) withheld += before - toolChars(event.tools)
        }
        // Remember the turn's ask and model so a tool result that lands mid-turn
        // can be folded at event time without re-reading the message list.
        const ask = lastUserText(event.messages)
        if (lastAsk.get(event.sessionID) !== ask) turnMaterial.delete(event.sessionID)
        lastAsk.set(event.sessionID, ask)
        revising.set(event.sessionID, revisedIn(ask))
        // a new prompt from the reader ends the hand-back's reply: a sentence it never restated stays as it was said
        if (!ask.startsWith(GROUND_STEER_HEAD)) selfRevising.delete(event.sessionID)
        const gathered = gatheredMaterial.get(event.sessionID)
        if (gathered) {
          turnMaterial.set(event.sessionID, gathered)
          gatheredMaterial.delete(event.sessionID)
        }
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
              userAsk: originalAsk,
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
          // THE REGISTER, PINNED: the session's stated facts as prose, in event.system so native compaction never summarises them
          // (compaction.ts skips `system`), with its one legend sentence. A session with a register compacts to the record by default.
          const register = registerBlock(answer)
          markRegistered(event.sessionID, register !== undefined)
          if (register !== undefined) {
            event.system.push({ type: "text", text: register })
            event.system.push({ type: "text", text: REGISTER_LEGEND })
          }
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
        // Default: the append-only projection (projectSteps) — the head is never edited, each fold appends an
        // event, and the dependency chain picks what stays verbatim. FOLD_PROJECTION=0 keeps the epoch fold.
        const projected =
          stable && process.env.FOLD_PROJECTION !== "0"
            ? projectSteps(event.messages, { tools: toolChars(event.tools), system: systemChars(event.system) }, stepProjections.get(event.sessionID), trailStore)
            : undefined
        if (projected) {
          stepProjections.set(event.sessionID, projected.proj)
          event.messages.splice(0, event.messages.length, ...projected.messages)
          if (projected.proj.events.length) {
            folded = true
            proj += `${proj ? "\n" : ""}${projected.proj.events.map((ev) => ev.text).join("\n")}` // L1: disclose the events
          }
        }
        const epoch = stable && !projected
          ? stableStepCut(event.messages, { tools: toolChars(event.tools), system: systemChars(event.system) }, stepEpochs.get(event.sessionID))
          : undefined
        if (epoch) stepEpochs.set(event.sessionID, epoch)
        const stepCount = event.messages.slice(event.messages.findLastIndex((m) => m.role === "user" && m.content.some((p) => p.type === "text")) + 1).filter((m) => m.role === "assistant").length
        const gated = projected
          ? undefined
          : stable
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
        // HOW THE ANSWER IS CHECKED, told before it is written: a model that knows its sentences are typed against what it read
        // reads first. Facts only; the person sees the same marks. FOLD_GROUND_LEGEND=0 turns it off.
        if (facingOn && facingNative && groundLegendOn) event.system.push({ type: "text", text: GROUND_LEGEND })
        yield* foldMessages(event)
        if (trailOn) yield* trailMessages(event)
        // THE HARD CAP: after every fold, the frontier's window is bounded absolutely (FOLD_MAX_CHARS).
        // A request never ends on the fold's own notice: a provider without prefill rejects a trailing assistant message (F5).
        dropTrailingNotices(event.messages, isPersonNotice)
        capContext(event.messages, event.system, { fixed: toolChars(event.tools), store: trailStore })
        // THE LEDGER'S "AFTER": what is actually sent. before - after is what the fold kept out (negative when
        // the notes it added cost more than they removed). `tools` is what the definitions weigh, measured the
        // same way, so a later change that sends fewer tools shows up as its own line.
        windows.set(event.sessionID, { before: windowBefore, after: contextChars(event.messages) + systemChars(event.system), tools: toolChars(event.tools), ...(withheld ? { withheld } : {}) })
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
    yield* ctx.session.hook("generate", (event) => {
      if (!physicsAside.has(event.sessionID)) return Effect.void
      for (const name of Object.keys(event.tools)) delete event.tools[name]
      event.system.splice(0, event.system.length, { type: "text", text: "You are a coding assistant." })
      return Effect.void
    })
    // A gather turn's one model call goes to the door, which answers with what it assembled. No key is sent there: the provider's
    // credentials are removed from the request before it leaves for the local endpoint.
    yield* ctx.session.hook("model.request", (event) => {
      const id = gatherRedirect.get(event.sessionID)
      if (!id || event.kind !== "primary") return Effect.void
      gatherRedirect.delete(event.sessionID)
      event.baseURL = `${base}/v1/gather`
      for (const key of Object.keys(event.headers)) if (/^(authorization|x-api-key|api-key|x-goog-api-key)$/i.test(key)) delete event.headers[key]
      event.headers["x-gather-id"] = id
      return Effect.void
    })
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
        if (noticeWoken.get(sessionID) === lastAsk.get(sessionID)) return
        const workspace = yield* workspaceOf(sessionID)
        const own = ownTexts.get(sessionID) ?? []
        ownTexts.set(sessionID, [...own, text].slice(-20))
        const notes = gatherNotes.get(sessionID)
        // Citation markup is provenance, not a claim: [^1^] / [1] markers and the footnote lines they point to would otherwise be graded as sentences
        // (and, left in a claim, read as "a source comes close, short of stating it").
        const graded = withoutCitations(notes?.size ? text.split("\n").filter((line) => !notes.has(line.trim())).join("\n") : text)
        // the reply to a hand-back revises the sentences it was handed; the reader's own revise notes ride the ask
        // the hand-back's reply revises the sentences it was handed, in whichever of its texts restates them (a reply can open
        // with a preamble before it reads); each is dropped once the door pairs it
        const handed = selfRevising.get(sessionID) ?? []
        const revises = [...(revising.get(sessionID) ?? []), ...handed].filter((r, i, all) => all.findIndex((o) => o.was === r.was) === i)
        const body = { event: "ground", sessionID, agent: sessionID, workspace, universe: process.env.FOLD_UNIVERSE ?? "world", text: graded, ask: lastAsk.get(sessionID) ?? "", passages: gatherPassages(turnMaterial.get(sessionID) ?? []), own, ...(revises.length ? { revises } : {}) }
        // Two passes, one answer: the quick profile (the turn's own material) lands at once; the falsifier's research
        // follows and its profile supersedes the first on the answer (the window shows the latest).
        const answer = yield* post({ ...body, ...(facingNative && researchOn ? { research: false } : {}) }, groundTimeout, true)
        const ground = facingNative ? groundPayload(answer, facingLevel) : undefined
        const paired = new Set(pairedIn(ground?.step?.profile))
        if (handed.length) selfRevising.set(sessionID, handed.filter((r) => !paired.has(r.was)))
        if (ground) {
          // The window draws the ground on the answer from this metadata; the text only keeps the person-notice
          // prefix (never sent to the model) and is the fallback for a window that cannot read the metadata.
          const publish = (payload: typeof ground) =>
            bus.publish(SessionEvent.Synthetic, {
              sessionID: sessionID as never,
              text: groundHead(payload),
              description: "fold facing — how this answer grounds",
              metadata: { notice: "fold-ground", ground: payload },
            })
          yield* publish(ground)
          const replyToSteer = steerOutstanding.delete(sessionID)
          // the hand-back: once the check is final (after research when research is pending), the model is told what it found
          const handBack = (final: typeof ground | undefined) =>
            Effect.gen(function* () {
              const note = groundSteerOn && !replyToSteer ? groundSteer(final?.step?.profile) : undefined
              const ask = lastAsk.get(sessionID) ?? ""
              const contradicted = contradictedIn(final?.step?.profile)
              if (!note || !shouldHandBack({ note, outstanding: steerOutstanding.has(sessionID), gathered: gatheredTurn.has(sessionID), toolResults: turnMaterial.get(sessionID)?.length ?? 0, steeredAsk: steeredAsk.get(sessionID), ask, contradicted: contradicted.length })) return
              steeredAsk.set(sessionID, ask)
              steerOutstanding.add(sessionID)
              if (contradicted.length) selfRevising.set(sessionID, contradicted)
              yield* ctx.session.synthetic({
                sessionID,
                text: note,
                description: "fold grounding — what the check found",
                delivery: "queue",
                resume: true,
              })
            })
          if (!researchOn || (ground.step?.profile?.research?.pending ?? 0) === 0) return yield* handBack(ground)
          const researched = groundPayload(yield* post({ ...body, research: true }, researchTimeout, true), facingLevel)
          if (researched?.step?.profile) yield* publish(researched)
          return yield* handBack(researched?.step?.profile ? researched : ground)
        }
        const note = facingNote(answer)
        if (!note) return
        yield* ctx.session.synthetic({
          sessionID,
          text: note,
          description: "fold facing — how this answer grounds",
          resume: false,
        })
      }).pipe(Effect.ignore)

    // PHYSICS, the reply side: the model's finished text is the content; the op is derived from it and applied or refused.
    const settle = (sessionID: string) =>
      Effect.gen(function* () {
        const held = pending.get(sessionID)
        if (!held) return
        pending.delete(sessionID)
        const { hold, text } = held
        const { plan, ask } = hold
        const steps: Array<Record<string, unknown>> = []
        let by = "local"
        let outcome: Physics.Derived = held.first
        steps.push({ by, ok: outcome.ok, ...(outcome.ok ? {} : { gap: outcome.gap }) })
        // REC: an answer that leaves the void open restructures the frame. First the local model once more, in the other
        // form and told what is still open; then, past the budget or a second miss, the frontier model.
        if (!outcome.ok && physicsRetries > 0 && Date.now() - hold.at < physicsBudget) {
          const pair = { ...plan, form: plan.form === "file" ? ("pair" as const) : ("file" as const) }
          physicsAside.add(sessionID)
          const again = yield* ctx.session
            .generate({ sessionID: sessionID as never, prompt: Physics.restate(pair, ask, text, outcome.gap.reason, pair.form) })
            .pipe(Effect.timeout(physicsBudget), Effect.catchCause(() => Effect.succeed(undefined)))
          physicsAside.delete(sessionID)
          if (again?.text) {
            by = "local-restated"
            outcome = Physics.derive(pair, again.text, ask)
            steps.push({ by, ok: outcome.ok, ...(outcome.ok ? {} : { gap: outcome.gap }) })
          }
        }
        if (!outcome.ok && physicsFrontier) {
          const gap = outcome.gap.reason
          const answer = yield* Effect.tryPromise(() => physicsAskFrontier(Physics.restate({ ...plan, form: "file" }, ask, text, gap, "file"))).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          const after = answer === undefined ? undefined : Physics.wholeFile(answer, plan.before)
          by = "frontier"
          outcome = after === undefined ? { ok: false, gap: { kind: "unreadable", reason: "the frontier gave no file" } } : Physics.accept(plan, after, ask)
          steps.push({ by, ok: outcome.ok, ...(outcome.ok ? {} : { gap: outcome.gap }) })
        }
        const written = outcome.ok ? Physics.commit(plan, outcome.after) : undefined
        if (outcome.ok && written && !written.ok) outcome = { ok: false, gap: written.gap }
        // TEACH: an edit that filled a testable void is kept as a recipe, so the machine answers the next ask of that shape alone.
        let taught = false
        if (outcome.ok && outcome.checked > 0) {
          const recipe = Physics.teach(plan, ask, outcome.after, by)
          if (recipe) taught = Learn.keep(physicsRecipes, recipe)
        }
        if (!outcome.ok) refused.add(sessionID)
        physicsRecord({ sessionID, edit: plan.file, ok: outcome.ok, by, taught, steps, ms: Date.now() - hold.at, ...(outcome.ok ? { act: outcome.op.op, checked: outcome.checked } : { gap: outcome.gap }) })
        yield* ctx.session.synthetic({ sessionID: sessionID as never, text: Physics.notice(plan.file, outcome) + (outcome.ok && by !== "local" ? ` · by ${by}` : "") + (taught ? " · taught" : ""), description: "fold physics — the derived operation", resume: false })
      }).pipe(Effect.ignore)

    // THE LONGFORM ADVANCES when a section's reply ends: the door applies it to the file and grades it, and says what the next call is asked; the armed
    // call (already queued) takes that prompt. After the last section the door has the assembled piece, and the following call is answered by it at no cost.
    // In layers mode the reply is ADMITTED instead: the door places its facing sentences at their addresses, marks the rest, and may hand back new gaps.
    const generateAdvance = (event: Observed) =>
      Effect.gen(function* () {
        if (event.type !== "session.text.ended") return
        const sessionID = event.data.sessionID
        const entry = generateJobs.get(sessionID)
        if (!entry) return
        if (entry.finished) { generateJobs.delete(sessionID); return }
        if (!generateAwaiting.has(sessionID)) return
        generateAwaiting.delete(sessionID)
        const gate = generateInFlight.get(sessionID)
        const text = typeof event.data.text === "string" ? event.data.text : ""
        const prompt = generatePending.get(sessionID)
        const publish = (p: Omit<GenerateNoticeInput, "topic" | "sources" | "startedAt" | "calls">) =>
          bus.publish(SessionEvent.Synthetic, generateNotice(sessionID, { topic: entry.topic, kind: entry.kind, sources: entry.sources, startedAt: entry.startedAt, calls: entry.calls, ...(entry.mode === "layers" ? { layer: "drawn", marked: entry.marked } : {}), ...p }))
        const reask = (reason: string) =>
          Effect.gen(function* () {
            physicsRecord({ sessionID, served: false, reason, job: entry.job })
            // the armed call re-asks the same section; without one, queue a retry call
            if (gate) yield* Deferred.succeed(gate, undefined)
            else yield* ctx.session.synthetic({ sessionID: sessionID as never, text: `${LONGFORM_MARK} re-asking the section`, description: "fold longform — retry", delivery: "queue", resume: true })
          })
        const endRun = (reason: string) =>
          Effect.gen(function* () {
            physicsRecord({ sessionID, served: false, reason, job: entry.job })
            generateJobs.delete(sessionID)
            generatePending.delete(sessionID)
            generateRetries.delete(sessionID)
            if (gate) yield* Deferred.succeed(gate, undefined)
          })
        if (!text.trim()) {
          // the model gave nothing for this section: re-ask it, capped, then end the run cleanly (never hang on a dead model)
          const tries = (generateRetries.get(sessionID) ?? 0) + 1
          if (tries <= 2 && prompt) { generateRetries.set(sessionID, tries); return yield* reask(`longform: the model gave no text; re-asking the section (try ${tries})`) }
          return yield* endRun("longform: the model gave no text after retries; ending the run")
        }
        // THE SHAPE CHECK, before the door sees the reply as a section. Not a judge: a section is measured by the word count it was asked for (more than
        // twice it is not the section), plus the three literal self-descriptions a model uses when it answers the ORIGINAL ask instead of the section
        // ("Here's an essay", "I can answer this directly", "Would you like me to"; ses_e93f6381 wrote a whole generic essay into section 2 with them).
        // Refused once: re-asked with the same prompt; a repeat is left to the door, which grades it and cuts what the lines do not state.
        const asked = Number(/about (\d+) words/.exec(prompt ?? "")?.[1]) || 0
        const wordCount = text.trim().split(/\s+/).length
        const selfDescribed = ["Here's an essay", "I can answer this directly", "Would you like me to"].find((p) => text.includes(p))
        const notSection = (asked > 0 && wordCount > 2 * asked) || selfDescribed !== undefined
        if (notSection && !generateShapeRetried.has(sessionID)) {
          generateShapeRetried.add(sessionID)
          return yield* reask(`longform: reply was not the section (${selfDescribed ? `it says "${selfDescribed}"` : `${wordCount} words for about ${asked} asked`}); re-asking once`)
        }
        if (notSection) physicsRecord({ sessionID, served: false, reason: `longform: reply was not the section again (${selfDescribed ? `it says "${selfDescribed}"` : `${wordCount} words for about ${asked} asked`}); the door grades it`, job: entry.job })
        generateShapeRetried.delete(sessionID)
        // the reply is being judged: the window sees which section, against how many facts (the row goes "judging" until the door answers)
        const judging = entry.current ? { section: entry.current.section, title: entry.current.title, facts: entry.current.facts } : null
        if (judging) {
          const row = entry.outline.find((s) => s.id === judging.section)
          if (row) row.state = "judging"
          yield* publish({ outline: entry.outline, round: 0, done: false, judging })
        }
        if (entry.mode === "layers") return yield* generateAdmit(sessionID, entry, text, gate)
        const r = yield* post({ event: "longform", op: "step", job: entry.job, text }, 180_000, true)
        if (!r || r.ok !== true) return yield* endRun(`longform: the door could not advance (${String(r?.error ?? "no answer")})`)
        const done = r.done as { path?: string } | undefined
        const next = r.next as { prompt?: string; section?: string; round?: number; title?: string; facts?: string[] } | undefined
        const graded = generateGradedOf(r.graded)
        if (done && typeof r.id === "string") {
          entry.finished = true
          entry.current = null
          gatherRedirect.set(sessionID, r.id)
          const assembled = typeof (done as { text?: string }).text === "string" ? (done as { text: string }).text : ""
          generatePending.set(sessionID, assembled ? `Return this piece exactly as written, nothing before or after it:\n\n${yield* withConfession(entry.job, assembled)}` : "Reply with the one word: done.")
          physicsRecord({ sessionID, served: true, kind: "longform-done", job: entry.job, done, calls: entry.calls, graded })
        } else if (next && typeof next.prompt === "string") {
          generatePending.set(sessionID, next.prompt)
          generateRetries.set(sessionID, 0)
          entry.current = { section: String(next.section ?? ""), title: String(next.title ?? next.section ?? ""), facts: Array.isArray(next.facts) ? next.facts.length : 0 }
          physicsRecord({ sessionID, served: true, kind: "longform-next", job: entry.job, section: next.section, round: next.round, calls: entry.calls, graded })
        } else { generateJobs.delete(sessionID); if (gate) yield* Deferred.succeed(gate, undefined); return }
        // the piece's progress as data: the written section "written" or "cut", the next one "writing"; when done, every state is final; the verdict rides along
        const stepOutline = generateOutlineOf(r.outline)
        if (stepOutline.length) entry.outline = stepOutline
        if (stepOutline.length) yield* publish({ outline: stepOutline, round: done ? 0 : Number(next?.round) || 0, done: Boolean(done), graded, judging: null })
        // what this step writes from (the general step-material notice)
        if (next && typeof next.prompt === "string") yield* noticeOnBus(materialNotice(sessionID, String(next.title ?? next.section), Array.isArray(next.facts) ? next.facts : []))
        if (gate) yield* Deferred.succeed(gate, undefined)
      }).pipe(Effect.ignore)

    // LAYER B's reply goes to the door's `admit`: the facing sentences are placed at their addresses, the rest marked as the model's own, and the door may
    // hand back new gaps (drawn next, to the depth and the call budget). When the gaps are exhausted or the budget is spent the piece is done: layer A's
    // text plus the admitted sentences, every sentence at an address or marked.
    const generateAdmit = (sessionID: string, entry: GenerateEntry, text: string, gate: Deferred.Deferred<void> | undefined) =>
      Effect.gen(function* () {
        const gap = entry.gap
        const r = gap ? yield* post({ event: "longform", op: "admit", job: entry.job, slot: gap.slot, drawn: text, text, depth: gap.depth }, 180_000, true) : undefined
        if (!gap || !r || r.ok !== true) {
          // the door lost the job (a restart mid-piece, 2026-10-24) or could not admit: the piece so far (layer A's text, plus what was admitted, from the
          // file on this machine) is still the result, and the window gets it rather than the one word "done"
          physicsRecord({ sessionID, served: false, reason: `longform: the door could not admit the drawn text (${String(r?.error ?? (gap ? "no answer" : "no gap pending"))}); finishing with the piece so far`, job: entry.job, gapsLeft: entry.gaps.length })
          if (entry.path) { try { entry.text = fs.readFileSync(entry.path, "utf8").replace(/<!--[\s\S]*?-->\n?/g, "").replace(/\n{3,}/g, "\n\n").trim() } catch {} }
          entry.finished = true
          entry.gap = null
          entry.current = null
          generatePending.set(sessionID, entry.text ? `Return this piece exactly as written, nothing before or after it:\n\n${yield* withConfession(entry.job, entry.text)}` : "Reply with the one word: done.")
          yield* bus.publish(SessionEvent.Synthetic, generateNotice(sessionID, { topic: entry.topic, kind: entry.kind, outline: entry.outline, round: 0, done: true, sources: entry.sources, startedAt: entry.startedAt, calls: entry.calls, layer: "drawn", marked: entry.marked, judging: null }))
          if (gate) yield* Deferred.succeed(gate, undefined)
          return
        }
        // opencode-stitch.mjs admit: `placed` and `marked` are the sentences themselves (arrays); a door may send counts instead
        const countOf = (v: unknown) => (Array.isArray(v) ? v.length : Number(v) || 0)
        const placed = countOf(r.placed)
        const marked = countOf(r.marked)
        entry.marked = { marked: entry.marked.marked + marked, placed: entry.marked.placed + placed + marked }
        if (typeof r.path === "string" && r.path) entry.path = r.path
        if (typeof r.text === "string" && r.text) entry.text = r.text
        else if (entry.path) { try { entry.text = fs.readFileSync(entry.path, "utf8").replace(/<!--[\s\S]*?-->\n?/g, "").replace(/\n{3,}/g, "\n\n").trim() } catch {} } // the piece file is the door's projection of the log, on this machine; its section markers are not the piece
        const newGaps = gap.depth + 1 <= generateDepth ? generateGapsOf(r.newGaps, gap.depth + 1) : []
        const skipped = generateGapsOf(r.newGaps, gap.depth + 1).length - newGaps.length
        // new gaps are drawn right after their parent, in tree order
        entry.gaps.unshift(...newGaps)
        const graded: GenerateGraded = { section: gap.slot, title: gap.label, round: 0, sentences: placed + marked, supported: placed, accepted: placed > 0, failed: [], marked, newGaps: newGaps.length }
        const row = entry.outline.find((s) => s.id === gap.slot)
        if (row) { row.state = "admitted"; row.sentences = placed + marked; row.supported = placed; row.marked = marked }
        for (const g of newGaps) if (!entry.outline.some((s) => s.id === g.slot)) { const at = row ? entry.outline.indexOf(row) + 1 : entry.outline.length; entry.outline.splice(at, 0, { id: g.slot, title: g.label, state: "gap", facts: g.context.length, layer: "drawn", depth: g.depth }) }
        const treeRows = generateOutlineOf(r.tree)
        if (treeRows.length) entry.outline = treeRows.map((t) => ({ ...(entry.outline.find((s) => s.id === t.id) ?? {}), ...t, layer: t.layer ?? (t.state === "filled" ? "stitched" : "drawn") }))
        physicsRecord({ sessionID, served: true, kind: "longform-admit", job: entry.job, slot: gap.slot, depth: gap.depth, placed, marked, newGaps: newGaps.length, skippedDepth: skipped, calls: entry.calls })
        yield* noticeOnBus({ sessionID, text: `fold measured · ${entry.topic} — admitted "${gap.label}": ${placed} face a source, ${marked} marked${newGaps.length ? `, ${newGaps.length} new gap(s)` : ""}${skipped ? ` (${skipped} below the depth, not drawn)` : ""}`, description: "fold longform — what was admitted" })
        const budgetLeft = entry.calls < generateCallBudget
        const next = budgetLeft ? entry.gaps.shift() : undefined
        if (next) {
          entry.gap = next
          entry.current = { section: next.slot, title: next.label, facts: next.context.length }
          const prompt = generateGapPrompt(entry.topic, next, entry.kind)
          generatePending.set(sessionID, prompt)
          generateRetries.set(sessionID, 0)
          const nrow = entry.outline.find((s) => s.id === next.slot)
          if (nrow) nrow.state = "drawing"
          yield* bus.publish(SessionEvent.Synthetic, generateNotice(sessionID, { topic: entry.topic, kind: entry.kind, outline: entry.outline, round: 0, done: false, sources: entry.sources, startedAt: entry.startedAt, calls: entry.calls, layer: "drawn", marked: entry.marked, graded, judging: null }))
          yield* noticeOnBus(materialNotice(sessionID, next.label, next.context.map(generateSnipLine).filter(Boolean)))
          if (gate) yield* Deferred.succeed(gate, undefined)
          return
        }
        // done: gaps exhausted or budget spent; gaps left undrawn stay marked as gaps in the outline
        entry.finished = true
        entry.gap = null
        entry.current = null
        if (typeof r.id === "string") gatherRedirect.set(sessionID, r.id)
        generatePending.set(sessionID, entry.text ? `Return this piece exactly as written, nothing before or after it:\n\n${yield* withConfession(entry.job, entry.text)}` : "Reply with the one word: done.")
        physicsRecord({ sessionID, served: true, kind: "longform-done", job: entry.job, mode: "layers", calls: entry.calls, marked: entry.marked, gapsLeft: entry.gaps.length, budgetSpent: !budgetLeft })
        yield* bus.publish(SessionEvent.Synthetic, generateNotice(sessionID, { topic: entry.topic, kind: entry.kind, outline: entry.outline, round: 0, done: true, sources: entry.sources, startedAt: entry.startedAt, calls: entry.calls, layer: "drawn", marked: entry.marked, graded, judging: null }))
        if (gate) yield* Deferred.succeed(gate, undefined)
      }).pipe(Effect.ignore)

    const physicsApply = (event: Observed) =>
      Effect.gen(function* () {
        if (event.type !== "session.text.ended") return
        const sessionID = event.data.sessionID
        const hold = armed.get(sessionID)
        if (!hold) return
        armed.delete(sessionID)
        const text = typeof event.data.text === "string" ? event.data.text : ""
        const first = Physics.derive(hold.plan, text, hold.ask)
        pending.set(sessionID, { hold, text, first })
        if (first.ok) return yield* settle(sessionID)
        // A miss restructures (REC), which takes model calls. The loop's follow-up request settles it from the context hook,
        // which holds the session open; with no follow-up, it settles here after a short wait.
        yield* Effect.sleep("4 seconds")
        yield* settle(sessionID)
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
          if (text) turnMaterial.set(event.data.sessionID, [...(turnMaterial.get(event.data.sessionID) ?? []), { name, text }].slice(-32))
          if (text.length >= minChars && !folded.has(event.data.id))
            void foldOnce(event.data.sessionID, name, lastAsk.get(event.data.sessionID) ?? "", lastModel.get(event.data.sessionID), event.data.id, text)
        }
        const derivedApply = event.type === "session.text.ended" ? physicsApply(event) : undefined
        const data = forward(event)
        if (!data) return derivedApply ?? Effect.void
        const sessionID = "sessionID" in event.data ? event.data.sessionID : undefined
        const record = post({ event: "event", type: event.type, sessionID, data }, askTimeout).pipe(Effect.asVoid)
        // The record rides with its side effects — never instead of them, all concurrent, all
        // failure-silent (post()'s own contract). Shadow capture feeds the draft-lint trial; facing
        // renders the typing on the answer. Each is opt-in and neither can delay the other.
        const side: Array<Effect.Effect<void, never, never>> = [record]
        if (facingOn && event.type === "session.text.ended") side.push(facing(event))
        if (derivedApply) side.push(derivedApply)
        if (generateOn && event.type === "session.text.ended") side.push(generateAdvance(event))
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
