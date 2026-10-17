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
import { record as rulerRecord, recordTokens as rulerTokens } from "./fold-ruler.js"

const base = (process.env.FOLD_URL ?? "http://127.0.0.1:11436").replace(/\/+$/, "")
const off = process.env.FOLD_OFF === "1"
// The door sits on the request path, so its recall/surf/title calls get a small
// budget by default: a healthy local door answers in milliseconds, and a wedged
// or slow one fails open fast (the turn then sends native content) instead of
// stalling the frontier. FOLD_TIMEOUT_MS raises it if a door legitimately needs longer.
const askTimeout = Number(process.env.FOLD_TIMEOUT_MS ?? 250)
const foldTimeout = Number(process.env.FOLD_FOLD_TIMEOUT_MS ?? 20_000)
// The swarm is model-free but reads the material through the door's capacity
// organs; it gets a longer budget than a recall note while still failing open.
const swarmTimeout = Number(process.env.FOLD_SWARM_TIMEOUT_MS ?? 60_000)
const minChars = Number(process.env.FOLD_MIN_CHARS ?? 4000)
const coolDown = 30_000
const debug = process.env.FOLD_DEBUG === "1"
// FOLD_RULER_FILE=<path.jsonl> measures every primary request by segment (measurement only; see fold-ruler.ts).
const rulerFile = process.env.FOLD_RULER_FILE
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

const surfPlan = (messages: SessionHooks["context"]["messages"]) => {
  if (keepTurns <= 0) return undefined
  const starts = messages.flatMap((item, index) =>
    item.role === "user" && item.content.some((part) => part.type === "text") ? [index] : [],
  )
  if (starts.length <= keepTurns) return undefined
  const cut = starts[starts.length - keepTurns]
  const turns = starts.slice(0, starts.length - keepTurns).map((start, i, all) => {
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
export const surfLocal = (turns: NonNullable<ReturnType<typeof surfPlan>>["turns"], ask = "") => {
  const byAsk = new Map<string, (typeof turns)[number]>()
  for (const t of turns) byAsk.set(short(t.ask, 300), t) // last-wins per ask (the DMD)
  const kept = [...byAsk.values()]
  const askW = wordsOf(ask)
  const about = [
    ...new Set(kept.flatMap((t) => [...wordsOf(`${t.ask} ${t.answer}`)].filter((w) => askW.has(w)))),
  ].slice(0, 6)
  return [
    `[fold: the thread — ${kept.length} earlier ask(s) settled (of ${turns.length} turns); the full history remains in the session]`,
    ...(about.length ? [`about: ${about.join(", ")}`] : []),
    ...kept.map(
      (t) => `- asked: ${short(t.ask, 300)} → ${t.answer ? `settled: ${short(t.answer, 400)}` : "(open, no reply)"}`,
    ),
  ].join("\n")
}

const surfApply = (messages: SessionHooks["context"]["messages"], cut: number, note: string) => {
  const head = messages[cut]
  messages.splice(0, cut)
  messages[0] = Message.make({
    id: head.id,
    role: head.role,
    content: [{ type: "text" as const, text: note }, ...head.content],
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
export const capContext = (messages: SessionHooks["context"]["messages"]) => {
  const max = Number(process.env.FOLD_MAX_CHARS ?? 32_000)
  if (!(max > 0)) return
  // Drop the OLDEST message after the head, one at a time, while over the ceiling. The head (index 0, which
  // carries the fold note) and the last (the current ask) are pinned — the window shrinks from the middle of
  // its own history, and can never exceed the filed max however long the session runs.
  for (let guard = 0; guard < 5000 && messages.length > 2 && contextChars(messages) > max; guard++) messages.splice(1, 1)
}

const isNewAsk = (messages: SessionHooks["context"]["messages"]) => messages.at(-1)?.role === "user"

// Event payloads are trimmed before they leave the process: the record needs the
// shape of a turn (which tools, in what order, how it ended), not its bytes.
const clip = (value: unknown, max = 2000) => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""
  return text.length > max ? `${text.slice(0, max)}…[${text.length - max} more]` : text
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
      return { id: event.data.id, input: clip(event.data.input, 1000), executed: event.data.executed }
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
  if (facingLevel === "off") return ""
  if (facingLevel === "line") return [head, where].filter(Boolean).join("\n")
  if (facingLevel === "standing") return [where, ...flagLines].filter(Boolean).join("\n")
  return [head, where, ...lines, ...flagLines].filter(Boolean).join("\n")
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

    // The contract check: the fork speaks events the door's handshake lists.
    // A drifted door logs; it never blocks (everything here fails open).
    yield* Effect.tryPromise(async () => {
      const response = await fetch(`${base}/v1/hooks/opencode`, { signal: AbortSignal.timeout(3000) })
      return (await response.json()) as { door?: string; events?: string[] }
    }).pipe(
      Effect.tap((door) => {
        const events = door?.events ?? []
        const missing = ["context", "title", "fold", "perceive"].filter((event) => !events.includes(event))
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
    const trailDone = new Map<string, Map<string, string>>()
    const lastCall = new Map<string, number>()

    // The precompute: a tool result is folded the moment it lands (event-time,
    // off the request path) and cached by part id; the context hook reads the
    // cache and only falls back to a cold door call when the fold has not landed
    // yet. Precompute posts with the full fold budget; the request path races it
    // against the small ask budget, so a slow door never stalls the turn — it
    // just sends the raw bytes this once.
    const folding = new Map<string, Promise<string | undefined>>()
    const foldOnce = (
      sessionID: string,
      tool: string,
      ask: string,
      model: { providerID: string; id: string } | undefined,
      id: string,
      text: string,
    ) => {
      const existing = folding.get(id)
      if (existing) return existing
      const promise = postRaw({ event: "fold", sessionID, tool, ask, text, priceIn: model ? priceIn(model) : undefined }, foldTimeout)
        .then((answer) => {
          const value = answer === undefined ? undefined : typeof answer.folded === "string" && answer.folded.length > 0 ? answer.folded : undefined
          if (value !== undefined) folded.set(id, value)
          return value
        })
        .catch(() => undefined)
        .finally(() => folding.delete(id))
      folding.set(id, promise)
      return promise
    }
    const foldBudget = (promise: Promise<string | undefined>, ms: number) =>
      Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))])

    // The turn's ask and model, so an event-time fold knows what to fold toward,
    // and tool id -> name, so a result folded at event time is attributed to its tool.
    const lastAsk = new Map<string, string>()
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
            if (target && target.text.length >= trailMinChars) results.push({ id: target.id, key: keyOf.get(target.id) ?? `${target.name}:${target.id}`, step })
          }
        }
        if (!results.length && done.size === 0) return
        // a result already pointerized stays pointerized on every later call; new ones only when the door says go
        let point = new Map<string, string>(done)
        const tokens = Math.round(event.messages.reduce((n, m) => n + m.content.reduce((k, p) => k + (p.type === "text" ? p.text.length : p.type === "tool-result" ? JSON.stringify(p.result).length : 0), 0), 0) / 4)
        const answer = yield* post({ event: "trail", sessionID: event.sessionID, results, already: [...done.keys()], idleMs, tokens, window: 200_000 }, askTimeout)
        if (answer?.go === true && answer.point && typeof answer.point === "object") for (const [id, handle] of Object.entries(answer.point as Record<string, string>)) if (!point.has(id)) point.set(id, String(handle))
        if (point.size === 0) return
        for (const [index, message] of event.messages.entries()) {
          let changed = false
          const content = message.content.map((part) => {
            const target = foldable(part)
            const handle = target ? point.get(target.id) : undefined
            if (!target || !handle || target.text.startsWith("[") && target.text.includes("kept out; SNIP")) return part
            trailStore.set(handle, target.text)
            done.set(target.id, handle)
            changed = true
            return { ...part, result: { type: "text" as const, value: `[${target.text.length} chars kept out; SNIP ${handle}]` } }
          })
          if (changed)
            event.messages[index] = Message.make({ id: message.id, role: message.role, content, metadata: message.metadata, providerMetadata: message.providerMetadata, native: message.native })
        }
      })

    const context = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        // THE NOTICES ARE OUTPUT, NEVER INPUT. A `synthetic` notice still rides in the session, so a fold
        // notice rendered for the PERSON (facing, chase, matrix, view, savings, audit) is stripped here before
        // anything is sent — otherwise the model ANSWERS the notice itself. Measured without this: over two
        // turns the model replied to the facing text and the window inflated to 219k tokens.
        for (let i = event.messages.length - 1; i >= 0; i--) {
          const text = event.messages[i].content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
          if (/^(?:fold facing ·|fold chase|fold matrix|fold view |fold savings|fold audit|fold door unreachable)/m.test(text))
            event.messages.splice(i, 1)
        }
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
        }
        // Surf: the window must not grow per prompt. The door's ladder (figure /
        // kind / pattern, each line addressed) answers; with it down, local
        // truncation does, so growth is bounded either way.
        const plan = surfPlan(event.messages)
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
            { event: "surf", sessionID: event.sessionID, task, workspace, ask: lastUserText(event.messages), turns: plan.turns, keptOutChars, priceIn: priceIn(event.model), ...priceCache(event.model) },
            askTimeout,
          ).pipe(Effect.timeout(askTimeout + 100), Effect.catch(() => Effect.succeed(undefined)))
          // not cut when the history is shorter than its own ladder, or when the door's cost gate prices the cut above
          // the cached prefix it would burn (the door says `uncut`): the turns stay, only the note rides
          if (answer?.uncut === true) {
            if (typeof answer.note === "string" && answer.note.length > 0) event.system.push({ type: "text", text: answer.note })
          } else
            surfApply(
              event.messages,
              plan.cut,
              typeof answer?.note === "string" && answer.note.length > 0
                ? answer.note
                : surfLocal(plan.turns, lastUserText(event.messages)),
            )
        }
        yield* foldMessages(event)
        if (trailOn) yield* trailMessages(event)
        // THE HARD CAP: after every fold, the frontier's window is bounded absolutely (FOLD_MAX_CHARS).
        capContext(event.messages)
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
            body: JSON.stringify({ event: "prompt", sessionID: event.sessionID, model: event.model, body }),
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
          "Exact bytes by address: path#L10-L20, path#120-340, or an address shown in <fold-commons> (e.g. 8f3a2b1c#t3.s1). Returns the verbatim bytes and their standing (witnessed or asserted).",
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
              return { output: { bytes: kept, standing: "witnessed", from: "tool result" }, content: kept, metadata: { schema: "EOTSnip@1", ref: input.ref, standing: "witnessed", from: "tool result", origin: "mechanical" } }
            }
            const answer = yield* post({ event: "snip", sessionID, agent: sessionID, workspace, ref: input.ref }, askTimeout * 4)
            if (answer === undefined) return yield* Effect.fail(new ToolFailure({ message: `snip: the fold door is unreachable at ${base}` }))
            if (answer.ok !== true)
              return yield* Effect.fail(new ToolFailure({ message: `snip ${String(answer.gap ?? "failed")}: ${input.ref}` }))
            const prov = (answer.provenance ?? {}) as Record<string, unknown>
            const from = [prov.kind, prov.file ?? prov.agent, prov.range ? JSON.stringify(prov.range) : null, prov.sha256]
              .filter((x) => typeof x === "string" && x.length > 0)
              .join(" ")
            const bytes = String(answer.bytes ?? "")
            const standing = String(answer.standing ?? "asserted")
            return {
              output: { bytes, standing, from },
              content: bytes,
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
              .synthetic({ sessionID, text: report, description: "the swarm — the ants' reading, measured", resume: false })
              .pipe(Effect.catchCause(() => Effect.void))
            return {
              output: { reading, standing, holes, giver },
              content: report,
              metadata: { schema: "EOSwarm@1", reading, standing, holes, giver, modality, origin: "mechanical" },
            }
          }).pipe(Effect.mapError((error) => (error instanceof ToolFailure ? error : new ToolFailure({ message: "swarm failed", error })))),
      }),
    )

    yield* ctx.session.hook("context", context)
    yield* ctx.session.hook("title", title)
    yield* ctx.session.hook("http.request", (event) => {
      capturePrompt(event)
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
        const answer = yield* post({ event: "ground", sessionID, agent: sessionID, workspace, text }, askTimeout)
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
