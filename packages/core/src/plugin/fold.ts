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
import { Effect, Schema, Stream } from "effect"

const base = (process.env.FOLD_URL ?? "http://127.0.0.1:11436").replace(/\/+$/, "")
const off = process.env.FOLD_OFF === "1"
const askTimeout = Number(process.env.FOLD_TIMEOUT_MS ?? 1500)
const foldTimeout = Number(process.env.FOLD_FOLD_TIMEOUT_MS ?? 20_000)
const minChars = Number(process.env.FOLD_MIN_CHARS ?? 4000)
const coolDown = 30_000
const debug = process.env.FOLD_DEBUG === "1"
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
// DRAFT-LINT (the-fold/docs/DRAFT-LINT.md): draft + act are the new door
// events. FOLD_DRAFT=0 disables them; FOLD_OFF=1 still disables everything.
// Rollout step 1 is observe-only — the door records verdicts it never
// enforces — so these posts change no turn by default.

let downUntil = 0

const post = (body: unknown, timeout: number) =>
  Effect.tryPromise(async () => {
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
    return (await response.json()) as Record<string, unknown>
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))

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

const surfLocal = (turns: NonNullable<ReturnType<typeof surfPlan>>["turns"]) =>
  `[fold: ${turns.length} earlier turn(s) kept out of this context; the full history remains in the session]\n` +
  turns
    .map((t) => `- ask: ${short(t.ask, 300)}\n  outcome: ${t.answer ? short(t.answer, 400) : "(no text reply)"}`)
    .join("\n")

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
    `kept out of the frontier: ${num(savings.foldedChars).toLocaleString()} chars ≈ ${num(savings.savedTokensEst).toLocaleString()} tokens (folds ${num(savings.folds)})`,
    `titles served by rule: ${num(meter.titlesServedLocally)} ≈ ${num(savings.titleTokensEst).toLocaleString()} frontier tokens avoided`,
    `estimated saved: $${num(savings.savedUSD).toFixed(4)} (${String(savings.note ?? "")})`,
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

export const Plugin = define({
  id: "fold.doorway",
  effect: Effect.fn(function* (ctx) {
    if (off) return

    // The price of the model actually in use, from the operator's own catalog;
    // sent with each fold so the door's dollars are the running model's dollars.
    let prices = new Map<string, number>()
    yield* ctx.model.transform((editor) => {
      prices = new Map(
        editor.list().flatMap((model) =>
          model.cost.length > 0 ? [[`${model.providerID}/${model.id}`, model.cost[0].input] as const] : [],
        ),
      )
    })
    const priceIn = (model: { providerID: string; id: string }) => prices.get(`${model.providerID}/${model.id}`)

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

    // The task a session's marks belong to: FOLD_TASK when set, else the root
    // of its parent chain, so a tab's subagents share one worknotes directory
    // with no setup. Cached per session; any lookup failure falls back to the
    // session's own id (a private task), never blocking a turn.
    const roots = new Map<string, string>()
    const taskOf = (sessionID: string) =>
      Effect.gen(function* () {
        if (process.env.FOLD_TASK) return process.env.FOLD_TASK
        const hit = roots.get(sessionID)
        if (hit) return hit
        let current: string = sessionID
        for (let depth = 0; depth < 8; depth++) {
          const session = yield* ctx.session.get(current as never).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const parent = (session as { parentID?: string } | undefined)?.parentID
          if (!parent) break
          current = parent
        }
        roots.set(sessionID, current)
        return current
      })

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
            const text = cached ?? (yield* post(
              {
                event: "fold",
                sessionID: event.sessionID,
                tool: target.name,
                ask: lastUserText(event.messages),
                text: target.text,
                priceIn: priceIn(event.model),
              },
              foldTimeout,
            ))?.folded
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

    const context = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        // Perception first: media becomes local transcription before recall
        // or folding reads the turn, so everything downstream sees text.
        yield* perceiveMessages(event)
        // The recall and the fold both knock on the door; the recall first, so
        // the turn exists before any fold can be attributed to it.
        if (isNewAsk(event.messages)) {
          const answer = yield* post(
            {
              event: "context",
              sessionID: event.sessionID,
              model: event.model,
              agent: event.agent,
              ask: lastUserText(event.messages),
              messages: event.messages.length,
              tools: Object.keys(event.tools),
            },
            askTimeout,
          )
          const note = answer?.system
          if (typeof note === "string" && note.length > 0) event.system.push({ type: "text", text: note })
          // Step 1 of the doorway plan: the archon ground note rides only
          // when the door computed and injected it (FOLD_ARCHONS=1 on the
          // door; default is shadow — recorded, never injected). The fork
          // carries no archon logic; the note arrives credited or not at all.
          const archons = answer?.archons as { note?: unknown } | undefined
          if (archons && typeof archons.note === "string" && archons.note.length > 0)
            event.system.push({ type: "text", text: archons.note })
        }
        // Surf: the window must not grow per prompt. The door's ladder (figure /
        // kind / pattern, each line addressed) answers; with it down, local
        // truncation does, so growth is bounded either way.
        const plan = surfPlan(event.messages)
        if (plan) {
          const task = yield* taskOf(event.sessionID)
          const answer = yield* post({ event: "surf", sessionID: event.sessionID, task, ask: lastUserText(event.messages), turns: plan.turns }, askTimeout)
          surfApply(event.messages, plan.cut, typeof answer?.note === "string" && answer.note.length > 0 ? answer.note : surfLocal(plan.turns))
        }
        yield* foldMessages(event)
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
          "fold savings (`/fold`), how this turn was prompted (`/fold audit`), or the resumable record (`/fold matrix|drive [login|pull|push|logout]`; matrix login takes <homeserver> <user>)",
        execute: (input) => {
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

    yield* ctx.session.hook("context", context)
    yield* ctx.session.hook("title", title)
    yield* ctx.session.hook("http.request", (event) => {
      capturePrompt(event)
      return Effect.void
    })

    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        const data = forward(event)
        if (!data) return Effect.void
        const sessionID = "sessionID" in event.data ? event.data.sessionID : undefined
        const record = post({ event: "event", type: event.type, sessionID, data }, askTimeout).pipe(Effect.asVoid)
        // Shadow capture rides alongside, never instead: concurrent, so
        // the record path never waits on the trial path; failure-silent
        // by post()'s own contract.
        if (!shadowOn) return record
        const shadow = shadowOf(event)
        if (!shadow || !sessionID) return record
        return Effect.all(
          [record, post({ event: "shadow", sessionID, ...shadow }, askTimeout).pipe(Effect.asVoid)],
          { concurrency: 2, discard: true },
        )
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
