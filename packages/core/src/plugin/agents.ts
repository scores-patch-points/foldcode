export * as AgentsPlugin from "./agents.js"

// THE AGENT BUS — sessions talk to each other, and (deliberately) through each
// other's worktrees.
//
// The stigmergic medium coordinates agents indirectly (they read and write the
// same worknotes); this is the direct channel for the case where one agent needs
// to say something TO another, or to use a piece of another's work.
//
//   agents  list the other live sessions on this project (id, title, directory)
//   tell    deliver a message into a peer's inbox, addressed by id or title
//   reach   pull bytes from a peer's worktree — peek (read) or graft (copy)
//   lend    push bytes from your worktree into a peer's inbox
//
// A message is an ordinary synthetic inbox item: durable, delivered to the
// peer's own session, readable as its own input. Permeation is the deliberate
// hole in worktree isolation: bytes cross a boundary, and the crossing is
// written down. The provenance header is authored by the tool, never the model
// — who, where, which revision, dirty or not, a content hash, and the span —
// and its standing is always "borrowed", never the borrower's own. A graft
// leaves the same record on disk as a sidecar, so the origin survives review.
//
// Peers are scoped to the caller's project: `agents` never lists another
// project's sessions, and `tell`/`reach`/`lend` resolve a title only among them.
// An explicit `ses_…` id is the escape hatch and reaches any session. The peer
// set is observed from the session bus (session.created / renamed / deleted),
// so a session that existed before this plugin loaded — and has not emitted an
// event since — is not listed until it runs; an id handed over out of band still
// works.
//
// OPENCODE_AGENTS=0 removes the tools; OPENCODE_PERMEATE=0 removes only reach
// and lend; OPENCODE_AGENTS_MAX_CHARS caps a message; OPENCODE_PERMEATE_MAX_BYTES
// caps a transfer.

import { ToolFailure } from "@opencode/ai"
import { define, type Context } from "@opencode/plugin/effect/plugin"
import { Session } from "@opencode/schema/session"
import { Effect, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname, isAbsolute, resolve, sep } from "node:path"

const off = process.env.OPENCODE_AGENTS === "0"
const permeateOff = process.env.OPENCODE_PERMEATE === "0"
const maxChars = Number(process.env.OPENCODE_AGENTS_MAX_CHARS ?? 8000) || 8000
const maxPeers = Number(process.env.OPENCODE_AGENTS_MAX ?? 50) || 50
const maxBytes = Number(process.env.OPENCODE_PERMEATE_MAX_BYTES ?? 400_000) || 400_000

export type Peer = {
  readonly id: string
  readonly projectID: string
  title: string
  readonly directory: string
}

export type Address = {
  readonly path: string
  readonly range?: { readonly kind: "line" | "byte"; readonly start: number; readonly end: number }
}

export type Permeation = {
  readonly from: string
  readonly fromTitle: string
  readonly directory: string
  readonly path: string
  readonly range?: Address["range"]
  readonly rev: string
  readonly dirty: boolean | null
  readonly sha256: string
  readonly at: string
  readonly bytes: number
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

// `path`, `path#L10-L20` (lines, 1-based inclusive) or `path#120-340` (bytes,
// inclusive). A `#` that is not followed by a span is part of the filename.
export const parseAddress = (input: string): Address => {
  const trimmed = input.trim()
  const hash = trimmed.lastIndexOf("#")
  if (hash < 0) return { path: trimmed }
  const path = trimmed.slice(0, hash).trim()
  const spec = trimmed.slice(hash + 1).trim()
  const line = /^L(\d+)(?:-L?(\d+))?$/.exec(spec)
  if (line) return { path, range: { kind: "line", start: Number(line[1]), end: Number(line[2] ?? line[1]) } }
  const byte = /^(\d+)(?:-(\d+))?$/.exec(spec)
  if (byte) return { path, range: { kind: "byte", start: Number(byte[1]), end: Number(byte[2] ?? byte[1]) } }
  return { path: trimmed }
}

// Resolve a relative path under a base, refusing anything that escapes it
// (absolute paths and `..`). Returns undefined when the path is not contained.
export const withinBase = (base: string, rel: string): string | undefined => {
  if (rel.length === 0 || isAbsolute(rel)) return undefined
  const root = resolve(base)
  const resolved = resolve(root, rel)
  return resolved === root || resolved.startsWith(root + sep) ? resolved : undefined
}

export const sliceBytes = (bytes: Uint8Array, range?: Address["range"]): Uint8Array => {
  if (!range) return bytes
  if (range.kind === "byte") {
    const start = Math.max(0, Math.min(range.start, bytes.length))
    const end = Math.max(start, Math.min(range.end + 1, bytes.length))
    return bytes.subarray(start, end)
  }
  const lines = new TextDecoder().decode(bytes).split("\n")
  const start = Math.max(1, range.start)
  const end = Math.min(lines.length, range.end)
  if (start > end) return new Uint8Array()
  return new TextEncoder().encode(lines.slice(start - 1, end).join("\n"))
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

const rangeLabel = (range?: Address["range"]) =>
  range === undefined ? "" : range.kind === "line" ? `#L${range.start}-L${range.end}` : `#${range.start}-${range.end}`

// The record is written by the tool; the model cannot author or strip it.
export const provenanceHeader = (p: Permeation) =>
  [
    "[permeation · borrowed]",
    `from: ${p.from}${p.fromTitle ? ` (${p.fromTitle})` : ""} · ${p.directory}`,
    `path: ${p.path}${rangeLabel(p.range)} · ${p.bytes} byte(s) · sha256 ${p.sha256}`,
    `rev: ${p.rev} · dirty: ${p.dirty === null ? "unknown" : p.dirty ? "yes (uncommitted)" : "no"}`,
    `at: ${p.at}`,
  ].join("\n")

const runGit = (directory: string, args: ReadonlyArray<string>) => {
  try {
    const proc = Bun.spawnSync({ cmd: ["git", "-C", directory, ...args], stdout: "pipe", stderr: "pipe" })
    return proc.exitCode === 0 ? proc.stdout.toString().trim() : ""
  } catch {
    return ""
  }
}

const gitInfo = (directory: string, rel: string): { rev: string; dirty: boolean | null } => {
  const rev = runGit(directory, ["rev-parse", "HEAD"])
  if (rev.length === 0) return { rev: "unknown", dirty: null }
  return { rev, dirty: runGit(directory, ["status", "--porcelain", "--", rel]).length > 0 }
}

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
        .pipe(Effect.orElseSucceed(() => undefined))
    const infoOf = (sessionID: Session.ID) =>
      ctx.session
        .get({ sessionID })
        .pipe(Effect.map((info) => ({ title: info.title ?? "", directory: info.location.directory })))
        .pipe(Effect.orElseSucceed(() => undefined))
    const peersFor = (self: string, project: string | undefined) =>
      sameProjectPeers(peers.values(), self, project)
    // Resolve an address to a target id: same-project peer by id/prefix/title,
    // else an explicit ses_ id (the escape hatch).
    const resolveTarget = (self: string, candidates: ReadonlyArray<Peer>, query: string) => {
      const address = query.trim()
      const match = matchPeer(candidates, address)
      if (match === "ambiguous")
        return {
          error: `"${address}" matches more than one session (${peerHits(candidates, address)
            .map((peer) => peer.id)
            .join(", ")}); use a session id`,
        } as const
      const id = match?.id ?? (address.startsWith("ses") ? address : undefined)
      if (id === undefined) return { error: `no session matches "${address}"; call agents to list peers` } as const
      if (id === self) return { error: "cannot target your own session" } as const
      return { id, title: match?.title ?? id } as const
    }
    const readBytes = (abs: string) =>
      Effect.tryPromise({
        try: () => Bun.file(abs).arrayBuffer().then((buffer) => new Uint8Array(buffer)),
        catch: () => new ToolFailure({ message: `permeation: cannot read ${abs}` }),
      })

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name: "agents",
        options: { codemode: false },
        description:
          "List the other live agent sessions on this project you can message with `tell` or borrow from with `reach`. Each line is `session-id · title · directory`. Your own session is never listed.",
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
            const text = input.text.trim()
            if (text.length === 0) return yield* Effect.fail(new ToolFailure({ message: "tell: empty message" }))
            if (text.length > maxChars)
              return yield* Effect.fail(new ToolFailure({ message: `tell: message exceeds ${maxChars} characters` }))
            const project = yield* projectOf(context.sessionID)
            const resolved = resolveTarget(self, peersFor(self, project), input.to)
            if ("error" in resolved) return yield* Effect.fail(new ToolFailure({ message: `tell: ${resolved.error}` }))
            const from = yield* infoOf(context.sessionID)
            yield* ctx.session.synthetic({
              sessionID: resolved.id as Session.ID,
              text: `agent message · from ${self}${from?.title ? ` (${from.title})` : ""}\n\n${text}`,
              description: `agent message from ${self}`,
              metadata: { schema: "AgentMessage@1", from: self, fromTitle: from?.title ?? "", to: resolved.id },
              delivery: "queue",
              resume: input.wake !== false,
            })
            return {
              output: { to: resolved.id, title: resolved.title, delivered: true },
              content: `delivered to ${resolved.id}${resolved.title !== resolved.id ? ` (${resolved.title})` : ""}`,
            }
          }).pipe(
            Effect.mapError((error) =>
              error instanceof ToolFailure ? error : new ToolFailure({ message: "tell failed", error }),
            ),
          ),
      }),
    )

    if (!permeateOff) {
      yield* ctx.tool.transform((editor) =>
        editor.add({
          name: "reach",
          options: { codemode: false },
          description:
            "Pull bytes from another session's worktree, wrapped in a provenance header (who, path, git revision, dirty or not, sha256, span) with standing `borrowed`. `ref` is a path inside the owner's worktree with an optional span (core/foo.mjs, core/foo.mjs#L10-L20, core/foo.mjs#120-340). By default it is read-only (peek); set copy=true to graft the bytes into your own worktree at `to` (default the same path), which also writes a `.provenance.json` sidecar. Only sessions in your project are reachable by name; an explicit ses_ id reaches any.",
          input: Schema.Struct({
            from: Schema.String.annotate({ description: "Owner session id (from `agents`), or a unique title prefix" }),
            ref: Schema.String.annotate({
              description: "Path inside the owner's worktree, with an optional span: core/foo.mjs#L10-L20 or core/foo.mjs#120-340",
            }),
            copy: Schema.optionalKey(Schema.Boolean).annotate({
              description: "Graft the bytes into your own worktree (default false = peek only)",
            }),
            to: Schema.optionalKey(Schema.String).annotate({
              description: "Destination path for a graft (default: the same relative path)",
            }),
          }),
          output: Schema.Struct({
            from: Schema.String,
            path: Schema.String,
            rev: Schema.String,
            dirty: Schema.NullOr(Schema.Boolean),
            sha256: Schema.String,
            grafted: Schema.NullOr(Schema.String),
            bytes: Schema.String,
          }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const self = String(context.sessionID)
              const project = yield* projectOf(context.sessionID)
              const resolved = resolveTarget(self, peersFor(self, project), input.from)
              if ("error" in resolved) return yield* Effect.fail(new ToolFailure({ message: `reach: ${resolved.error}` }))
              const owner = yield* infoOf(resolved.id as Session.ID)
              if (owner === undefined)
                return yield* Effect.fail(new ToolFailure({ message: `reach: owner ${resolved.id} is gone` }))
              const address = parseAddress(input.ref)
              const source = withinBase(owner.directory, address.path)
              if (source === undefined)
                return yield* Effect.fail(
                  new ToolFailure({ message: `reach: "${address.path}" escapes the owner's worktree` }),
                )
              const bytes = sliceBytes(yield* readBytes(source), address.range)
              if (bytes.length > maxBytes)
                return yield* Effect.fail(
                  new ToolFailure({
                    message: `reach: ${bytes.length} bytes exceeds ${maxBytes}; narrow the span with #Lx-Ly or #a-b`,
                  }),
                )
              const git = gitInfo(owner.directory, address.path)
              const at = new Date().toISOString()
              const header = provenanceHeader({
                from: resolved.id,
                fromTitle: owner.title,
                directory: owner.directory,
                path: address.path,
                range: address.range,
                rev: git.rev,
                dirty: git.dirty,
                sha256: sha256Hex(bytes),
                at,
                bytes: bytes.length,
              })
              const text = new TextDecoder().decode(bytes)
              let grafted: string | null = null
              if (input.copy === true) {
                const mine = yield* infoOf(context.sessionID)
                if (mine === undefined) return yield* Effect.fail(new ToolFailure({ message: "reach: your session is gone" }))
                const destRel = (input.to ?? address.path).trim()
                const destination = withinBase(mine.directory, destRel)
                if (destination === undefined)
                  return yield* Effect.fail(new ToolFailure({ message: `reach: destination "${destRel}" escapes your worktree` }))
                mkdirSync(dirname(destination), { recursive: true })
                yield* Effect.tryPromise({
                  try: () => Bun.write(destination, bytes),
                  catch: () => new ToolFailure({ message: `reach: cannot write ${destRel}` }),
                })
                const sidecar = {
                  schema: "Permeation@1",
                  from: resolved.id,
                  fromTitle: owner.title,
                  sourceDirectory: owner.directory,
                  path: address.path,
                  to: destRel,
                  range: address.range,
                  rev: git.rev,
                  dirty: git.dirty,
                  sha256: sha256Hex(bytes),
                  at,
                }
                yield* Effect.tryPromise({
                  try: () => Bun.write(`${destination}.provenance.json`, JSON.stringify(sidecar, null, 2)),
                  catch: () => new ToolFailure({ message: `reach: cannot write the provenance sidecar` }),
                })
                grafted = destRel
              }
              return {
                output: {
                  from: resolved.id,
                  path: address.path,
                  rev: git.rev,
                  dirty: git.dirty,
                  sha256: sha256Hex(bytes),
                  grafted,
                  bytes: text,
                },
                content: `${header}${grafted ? `\ngrafted: ${grafted} (+ .provenance.json)` : ""}\n\n${text}`,
                metadata: { schema: "Permeation@1", from: resolved.id, path: address.path, sha256: sha256Hex(bytes) },
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "reach failed", error }),
              ),
            ),
        }),
      )

      yield* ctx.tool.transform((editor) =>
        editor.add({
          name: "lend",
          options: { codemode: false },
          description:
            "Push bytes from YOUR worktree into another session's inbox, wrapped in the same provenance header (standing `borrowed`). `ref` is a path inside your worktree with an optional span. The bytes ride inline when they fit; otherwise the message carries the header and a pointer telling the peer to `reach` back for the rest. The recipient still decides whether to graft it.",
          input: Schema.Struct({
            to: Schema.String.annotate({ description: "Recipient session id (from `agents`), or a unique title prefix" }),
            ref: Schema.String.annotate({
              description: "Path inside YOUR worktree, with an optional span: core/foo.mjs#L10-L20",
            }),
            inline: Schema.optionalKey(Schema.Boolean).annotate({
              description: "Include the bytes in the message when they fit (default true)",
            }),
          }),
          output: Schema.Struct({ to: Schema.String, path: Schema.String, sha256: Schema.String, inlined: Schema.Boolean }),
          execute: (input, context) =>
            Effect.gen(function* () {
              const self = String(context.sessionID)
              const project = yield* projectOf(context.sessionID)
              const resolved = resolveTarget(self, peersFor(self, project), input.to)
              if ("error" in resolved) return yield* Effect.fail(new ToolFailure({ message: `lend: ${resolved.error}` }))
              const mine = yield* infoOf(context.sessionID)
              if (mine === undefined) return yield* Effect.fail(new ToolFailure({ message: "lend: your session is gone" }))
              const address = parseAddress(input.ref)
              const source = withinBase(mine.directory, address.path)
              if (source === undefined)
                return yield* Effect.fail(new ToolFailure({ message: `lend: "${address.path}" escapes your worktree` }))
              const bytes = sliceBytes(yield* readBytes(source), address.range)
              if (bytes.length > maxBytes)
                return yield* Effect.fail(
                  new ToolFailure({
                    message: `lend: ${bytes.length} bytes exceeds ${maxBytes}; narrow the span with #Lx-Ly or #a-b`,
                  }),
                )
              const git = gitInfo(mine.directory, address.path)
              const at = new Date().toISOString()
              const sha = sha256Hex(bytes)
              const header = provenanceHeader({
                from: self,
                fromTitle: mine.title,
                directory: mine.directory,
                path: address.path,
                range: address.range,
                rev: git.rev,
                dirty: git.dirty,
                sha256: sha,
                at,
                bytes: bytes.length,
              })
              const text = new TextDecoder().decode(bytes)
              const inlined = input.inline !== false && text.length <= maxChars
              const body = inlined
                ? `${header}\n\n${text}`
                : `${header}\n\n(too large to inline — call reach with from="${self}" ref="${input.ref}" to pull it)`
              yield* ctx.session.synthetic({
                sessionID: resolved.id as Session.ID,
                text: `permeation · lent from ${self}${mine.title ? ` (${mine.title})` : ""}\n\n${body}`,
                description: `permeation · lent from ${self}`,
                metadata: {
                  schema: "Permeation@1",
                  from: self,
                  fromTitle: mine.title,
                  sourceDirectory: mine.directory,
                  path: address.path,
                  range: address.range,
                  rev: git.rev,
                  dirty: git.dirty,
                  sha256: sha,
                  at,
                },
                delivery: "queue",
                resume: true,
              })
              return {
                output: { to: resolved.id, path: address.path, sha256: sha, inlined },
                content: `lent ${address.path} to ${resolved.id}${inlined ? "" : " (pointer only)"}`,
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure ? error : new ToolFailure({ message: "lend failed", error }),
              ),
            ),
        }),
      )
    }
  }),
})
