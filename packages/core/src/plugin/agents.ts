export * as AgentsPlugin from "./agents.js"

// THE AGENT BUS — sessions talk to each other through the durable session inbox.
//
// The stigmergic medium coordinates agents indirectly (they read and write the
// same worknotes); this is the direct channel for the case where one agent needs
// to say something TO another: a question, a handoff, a correction. Nothing here
// is a shared file — a message is an ordinary synthetic inbox item, delivered to
// the peer's own session and durable until its next turn. Two tools:
//
//   agents  list the other live sessions on this project (id, title, directory)
//   tell    deliver a message into a peer's inbox, addressed by id or title
//
// Peers are scoped to the caller's project: `agents` never lists another
// project's sessions, and `tell` resolves a title only among them. An explicit
// `ses_…` id is the escape hatch and reaches any session. The peer set is
// observed from the session bus (session.created / renamed / deleted), so a
// session that existed before this plugin loaded — and has not emitted an event
// since — is not listed until it runs; an id handed over out of band still works.
//
// OPENCODE_AGENTS=0 removes the tools; OPENCODE_AGENTS_MAX_CHARS caps a message.

import { ToolFailure } from "@opencode/ai"
import { define, type Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Effect, Schema, Stream } from "effect"

const off = process.env.OPENCODE_AGENTS === "0"
const maxChars = Number(process.env.OPENCODE_AGENTS_MAX_CHARS ?? 8000) || 8000
const maxPeers = Number(process.env.OPENCODE_AGENTS_MAX ?? 50) || 50

export type Peer = {
  readonly id: string
  readonly projectID: string
  title: string
  readonly directory: string
}

export const peerLine = (peer: Pick<Peer, "id" | "title" | "directory">) =>
  `${peer.id} · ${peer.title} · ${peer.directory}`

// Every peer an address could mean: an exact id wins alone; otherwise an id
// prefix or a title substring. More than one hit is a refusal, never a guess.
export const peerHits = (peers: ReadonlyArray<Peer>, query: string): Peer[] => {
  const q = query.trim()
  if (q.length === 0) return []
  const exact = peers.filter((peer) => peer.id === q)
  if (exact.length > 0) return exact
  const lower = q.toLowerCase()
  return peers.filter((peer) => peer.id.toLowerCase().startsWith(lower) || peer.title.toLowerCase().includes(lower))
}

export const matchPeer = (peers: ReadonlyArray<Peer>, query: string): Peer | "ambiguous" | undefined => {
  const hits = peerHits(peers, query)
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) return "ambiguous"
  return undefined
}

// Fail closed: without a resolved project there is no peer set, so a caller can
// never see across projects.
export const sameProjectPeers = (peers: Iterable<Peer>, self: string, project: string | undefined): Peer[] =>
  project === undefined ? [] : [...peers].filter((peer) => peer.id !== self && peer.projectID === project)

export const Plugin = define({
  id: "agents.bus",
  effect: Effect.fn(function* (ctx: Context) {
    if (off) return

    const peers = new Map<string, Peer>()

    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) => {
        if (event.type === "session.created")
          peers.set(event.data.sessionID, {
            id: event.data.sessionID,
            projectID: event.data.projectID,
            title: event.data.title ?? event.data.slug,
            directory: event.data.location.directory,
          })
        else if (event.type === "session.renamed") {
          const peer = peers.get(event.data.sessionID)
          if (peer) peer.title = event.data.title
        } else if (event.type === "session.deleted") peers.delete(event.data.sessionID)
        return Effect.void
      }),
      Effect.forkScoped({ startImmediately: true }),
    )

    const projectOf = (sessionID: Session.ID) =>
      ctx.session
        .get({ sessionID })
        .pipe(Effect.map((info) => info.projectID))
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
    const peersFor = (self: string, project: string | undefined) =>
      sameProjectPeers(peers.values(), self, project)

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "agents",
        options: { codemode: false },
        description:
          "List the other live agent sessions on this project you can message with `tell`. Each line is `session-id · title · directory`. Your own session is never listed.",
        input: Schema.Struct({}),
        output: Schema.Struct({
          peers: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, directory: Schema.String })),
        }),
        execute: (_input, context) =>
          Effect.gen(function* () {
            const self = String(context.sessionID)
            const project = yield* projectOf(context.sessionID)
            const list = peersFor(self, project)
              .slice(0, maxPeers)
              .map((peer) => ({ id: peer.id, title: peer.title, directory: peer.directory }))
            return {
              output: { peers: list },
              content: list.length === 0 ? "no other agent sessions on this project yet" : list.map(peerLine).join("\n"),
            }
          }),
      }),
    )

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "tell",
        options: { codemode: false },
        description:
          "Send a message to another agent session's inbox. `to` is a session id from `agents`, or a unique title prefix. The message is durable and the peer reads it as its own input; with wake=true (default) it is picked up at the peer's next idle boundary, otherwise it waits for the peer's next turn. A reply comes back the same way.",
        input: Schema.Struct({
          to: Schema.String.annotate({ description: "Target session id (from `agents`), or a unique title prefix" }),
          text: Schema.String.annotate({ description: "The message to deliver" }),
          wake: Schema.optionalKey(Schema.Boolean).annotate({ description: "Wake the peer now (default true)" }),
        }),
        output: Schema.Struct({ to: Schema.String, title: Schema.String, delivered: Schema.Boolean }),
        execute: (input, context) =>
          Effect.gen(function* () {
            const self = String(context.sessionID)
            const address = input.to.trim()
            const text = input.text.trim()
            if (text.length === 0) return yield* Effect.fail(new ToolFailure({ message: "tell: empty message" }))
            if (text.length > maxChars)
              return yield* Effect.fail(new ToolFailure({ message: `tell: message exceeds ${maxChars} characters` }))
            const project = yield* projectOf(context.sessionID)
            const candidates = peersFor(self, project)
            const match = matchPeer(candidates, address)
            if (match === "ambiguous") {
              const ids = peerHits(candidates, address)
                .map((peer) => peer.id)
                .join(", ")
              return yield* Effect.fail(
                new ToolFailure({ message: `tell: "${address}" matches more than one session (${ids}); use a session id` }),
              )
            }
            const target = match ?? (address.startsWith("ses") ? { id: address, title: address } : undefined)
            if (!target)
              return yield* Effect.fail(
                new ToolFailure({ message: `tell: no session matches "${address}"; call agents to list peers` }),
              )
            if (target.id === self)
              return yield* Effect.fail(new ToolFailure({ message: "tell: cannot message your own session" }))
            const from = yield* ctx.session
              .get({ sessionID: context.sessionID })
              .pipe(Effect.map((info) => info.title ?? ""))
              .pipe(Effect.catch(() => Effect.succeed("")))
            yield* ctx.session.synthetic({
              sessionID: target.id as Session.ID,
              text: `agent message · from ${self}${from ? ` (${from})` : ""}\n\n${text}`,
              description: `agent message from ${self}`,
              metadata: { schema: "AgentMessage@1", from: self, fromTitle: from, to: target.id },
              delivery: "queue",
              resume: input.wake !== false,
            })
            return {
              output: { to: target.id, title: target.title, delivered: true },
              content: `delivered to ${target.id}${target.title !== target.id ? ` (${target.title})` : ""}`,
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ToolFailure ? error : new ToolFailure({ message: "tell failed", error }),
            ),
          ),
      }),
    )
  }),
})
