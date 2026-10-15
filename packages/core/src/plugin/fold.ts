export * as FoldPlugin from "./fold.js"

// The Fold doorway client. Everything here is a thin forwarder: the fold stack
// (khora's POST /v1/hooks/opencode) decides what a prompt becomes, what a tool
// output folds into, and what a finished turn teaches. This file carries no
// fold logic, so it does not change when the fold does, and it is the only
// fold-specific code in the fork.
//
// Fails open: with the door unreachable, slow, or answering nonsense, opencode
// behaves exactly as upstream. FOLD_OFF=1 removes the plugin's effect entirely.

import { Message } from "@opencode/ai"
import { define, type Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Stream } from "effect"

const base = (process.env.FOLD_URL ?? "http://127.0.0.1:11436").replace(/\/+$/, "")
const off = process.env.FOLD_OFF === "1"
const askTimeout = Number(process.env.FOLD_TIMEOUT_MS ?? 1500)
const foldTimeout = Number(process.env.FOLD_FOLD_TIMEOUT_MS ?? 20_000)
const minChars = Number(process.env.FOLD_MIN_CHARS ?? 4000)
const coolDown = 30_000
const debug = process.env.FOLD_DEBUG === "1"

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
        const missing = ["context", "title", "fold"].filter((event) => !events.includes(event))
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

    const context = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
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
        description: "fold savings (`/fold`) or how this turn was prompted (`/fold audit`)",
        execute: (input) => {
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
        return post({ event: "event", type: event.type, sessionID, data }, askTimeout).pipe(Effect.asVoid)
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
