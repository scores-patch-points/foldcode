export * as FoldPlugin from "./fold.js"

// The Fold doorway client. Everything here is a thin forwarder: the fold stack
// (khora's POST /v1/hooks/opencode) decides what a prompt becomes and what a
// finished turn teaches. This file carries no fold logic, so it does not change
// when the fold does, and it is the only fold-specific code in the fork.
//
// Fails open: with the door unreachable, slow, or answering nonsense, opencode
// behaves exactly as upstream. FOLD_OFF=1 removes the plugin's effect entirely.

import { define, type Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Stream } from "effect"

const base = (process.env.FOLD_URL ?? "http://127.0.0.1:11436").replace(/\/+$/, "")
const off = process.env.FOLD_OFF === "1"
const askTimeout = Number(process.env.FOLD_TIMEOUT_MS ?? 1500)
const coolDown = 30_000

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

export const Plugin = define({
  id: "fold.doorway",
  effect: Effect.fn(function* (ctx) {
    if (off) return

    const context = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        if (!isNewAsk(event.messages)) return
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
      })

    const title = (event: SessionHooks["title"]) =>
      Effect.gen(function* () {
        const answer = yield* post(
          { event: "title", sessionID: event.sessionID, model: event.model, ask: lastUserText(event.messages) },
          askTimeout * 4,
        )
        const result = answer?.title
        if (typeof result === "string" && result.trim().length > 0) event.result = result.trim()
      })

    yield* ctx.session.hook("context", context)
    yield* ctx.session.hook("title", title)

    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        const data = forward(event)
        if (!data) return Effect.void
        const sessionID = "sessionID" in event.data ? event.data.sessionID : undefined
        return post({ event: "event", type: event.type, sessionID, data }, askTimeout).pipe(Effect.asVoid)
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
