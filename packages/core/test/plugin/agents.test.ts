import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { AgentsPlugin } from "@opencode/core/plugin/agents"
import { PluginHost } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
import { Location } from "@opencode/schema/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { Tool } from "@opencode/schema/tool"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const peer = (id: string, title: string, projectID = "prj_test") => ({
  id,
  title,
  projectID,
  directory: "/tmp",
})

const call = (sessionID: Session.ID): Tool.Context => ({
  sessionID,
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.create(),
  id: Tool.CallID.make("call_agents_1"),
  progress: () => Effect.void,
})

test("resolves a peer by exact id, unique prefix or title, and refuses ambiguity", () => {
  const peers = [peer("ses_alpha", "parser"), peer("ses_beta", "builder")]

  expect(AgentsPlugin.matchPeer(peers, "ses_alpha")).toMatchObject({ id: "ses_alpha" })
  expect(AgentsPlugin.matchPeer(peers, "ses_b")).toMatchObject({ id: "ses_beta" })
  expect(AgentsPlugin.matchPeer(peers, "build")).toMatchObject({ id: "ses_beta" })
  expect(AgentsPlugin.matchPeer(peers, "SES_ALPHA")).toMatchObject({ id: "ses_alpha" })
  expect(AgentsPlugin.matchPeer(peers, "  ses_beta  ")).toMatchObject({ id: "ses_beta" })
  expect(AgentsPlugin.matchPeer(peers, "")).toBeUndefined()
  expect(AgentsPlugin.matchPeer(peers, "   ")).toBeUndefined()
  expect(AgentsPlugin.matchPeer(peers, "missing")).toBeUndefined()
  expect(AgentsPlugin.matchPeer([peer("ses_a", "one"), peer("ses_ab", "two")], "ses_a")).toMatchObject({ id: "ses_a" })
  expect(AgentsPlugin.matchPeer([peer("ses_x", "shared"), peer("ses_y", "shared")], "shared")).toBe("ambiguous")
  expect(AgentsPlugin.peerLine(peer("ses_a", "parser"))).toBe("ses_a · parser · /tmp")
})

test("scopes peers to the caller's project and fails closed without one", () => {
  const peers = [peer("ses_a", "a", "prj_1"), peer("ses_b", "b", "prj_2"), peer("ses_self", "me", "prj_1")]

  expect(AgentsPlugin.sameProjectPeers(peers, "ses_self", "prj_1")).toEqual([peer("ses_a", "a", "prj_1")])
  expect(AgentsPlugin.sameProjectPeers(peers, "ses_self", undefined)).toEqual([])
  expect(AgentsPlugin.sameProjectPeers(peers, "ses_a", "prj_1")).toEqual([peer("ses_self", "me", "prj_1")])
})

test("parses addresses, confines paths, slices ranges, and writes the provenance header", () => {
  expect(AgentsPlugin.parseAddress("core/foo.mjs")).toEqual({ path: "core/foo.mjs" })
  expect(AgentsPlugin.parseAddress(" core/foo.mjs#L10-L20 ")).toEqual({
    path: "core/foo.mjs",
    range: { kind: "line", start: 10, end: 20 },
  })
  expect(AgentsPlugin.parseAddress("core/foo.mjs#L5")).toEqual({ path: "core/foo.mjs", range: { kind: "line", start: 5, end: 5 } })
  expect(AgentsPlugin.parseAddress("core/foo.mjs#120-340")).toEqual({
    path: "core/foo.mjs",
    range: { kind: "byte", start: 120, end: 340 },
  })
  expect(AgentsPlugin.parseAddress("weird#name.mjs")).toEqual({ path: "weird#name.mjs" })

  expect(AgentsPlugin.withinBase("/tmp/x", "a/b.mjs")).toBe("/tmp/x/a/b.mjs")
  expect(AgentsPlugin.withinBase("/tmp/x", "../y")).toBeUndefined()
  expect(AgentsPlugin.withinBase("/tmp/x", "/etc/passwd")).toBeUndefined()
  expect(AgentsPlugin.withinBase("/tmp/x", "")).toBeUndefined()

  const bytes = new TextEncoder().encode("a\nb\nc\nd")
  expect(new TextDecoder().decode(AgentsPlugin.sliceBytes(bytes, { kind: "line", start: 2, end: 3 }))).toBe("b\nc")
  expect(new TextDecoder().decode(AgentsPlugin.sliceBytes(bytes, { kind: "byte", start: 2, end: 3 }))).toBe("b\n")
  expect(AgentsPlugin.sliceBytes(bytes)).toBe(bytes)

  const header = AgentsPlugin.provenanceHeader({
    from: "ses_owner",
    fromTitle: "owner",
    directory: "/tmp/owner",
    path: "core/foo.mjs",
    range: { kind: "line", start: 1, end: 2 },
    rev: "abc123",
    dirty: true,
    sha256: "deadbeef",
    at: "2026-10-18T00:00:00.000Z",
    bytes: 12,
  })
  expect(header).toContain("[permeation · borrowed]")
  expect(header).toContain("from: ses_owner (owner) · /tmp/owner")
  expect(header).toContain("path: core/foo.mjs#L1-L2 · 12 byte(s) · sha256 deadbeef")
  expect(header).toContain("rev: abc123 · dirty: yes (uncommitted)")
})

it.live("permeates a peer's worktree with provenance (peek, graft, lend) and refuses escapes", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const host = yield* PluginHost.make(plugins)
    yield* AgentsPlugin.Plugin.effect(host)

    const ownerDir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-owner-"))
    const borrowerDir = fs.mkdtempSync(path.join(os.tmpdir(), "perm-borrower-"))
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", ownerDir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" })
    try {
      fs.mkdirSync(path.join(ownerDir, "core"), { recursive: true })
      fs.writeFileSync(path.join(ownerDir, "core", "thing.mjs"), "export const x = 1\nexport const y = 2\n")
      git("init")
      git("add", "-A")
      git("commit", "-m", "init")
      // An uncommitted change: the header must disclose it as dirty.
      fs.writeFileSync(path.join(ownerDir, "core", "thing.mjs"), "export const x = 1\nexport const y = 3\n")

      const owner = yield* host.session.create({ title: "owner", location: Location.Ref.make({ directory: AbsolutePath.make(ownerDir) }) })
      const borrower = yield* host.session.create({
        title: "borrower",
        location: Location.Ref.make({ directory: AbsolutePath.make(borrowerDir) }),
      })
      yield* Effect.sleep("50 millis")

      const tools = yield* host.tool.list()
      const reach = tools.find((tool) => tool.id === "reach")
      const lend = tools.find((tool) => tool.id === "lend")
      expect(reach).toBeDefined()
      expect(lend).toBeDefined()

      // Peek: read-only, with a real revision and a dirty flag.
      const peeked = yield* reach!.execute({ from: owner.id, ref: "core/thing.mjs#L2-L2" }, call(borrower.id))
      expect(peeked.output.bytes).toBe("export const y = 3")
      expect(peeked.output.dirty).toBe(true)
      expect(peeked.output.rev).not.toBe("unknown")
      expect(peeked.output.grafted).toBeNull()
      expect(peeked.output.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(peeked.content).toContain("[permeation · borrowed]")

      // Graft: the bytes land in my tree, with a sidecar that carries the origin.
      const grafted = yield* reach!.execute(
        { from: owner.id, ref: "core/thing.mjs", copy: true, to: "vendor/thing.mjs" },
        call(borrower.id),
      )
      expect(grafted.output.grafted).toBe("vendor/thing.mjs")
      expect(fs.readFileSync(path.join(borrowerDir, "vendor", "thing.mjs"), "utf8")).toContain("export const y = 3")
      const sidecar = JSON.parse(fs.readFileSync(path.join(borrowerDir, "vendor", "thing.mjs.provenance.json"), "utf8"))
      expect(sidecar).toMatchObject({ schema: "Permeation@1", from: owner.id, dirty: true, to: "vendor/thing.mjs" })

      // Lend: the owner pushes a slice into the borrower's inbox.
      yield* lend!.execute({ to: borrower.id, ref: "core/thing.mjs#L1-L1" }, call(owner.id))
      const inbox = yield* sessions.inbox(borrower.id)
      const lent = inbox.find((item) => item.type === "synthetic")
      expect(lent?.type === "synthetic" && lent.payload.text).toContain("[permeation · borrowed]")
      expect(lent?.type === "synthetic" && lent.payload.text).toContain("export const x = 1")

      // Falsifiers: escapes, unknown owners, missing files, and self-reach all refuse.
      const escape = yield* reach!.execute({ from: owner.id, ref: "../../etc/passwd" }, call(borrower.id)).pipe(Effect.flip)
      expect(escape).toMatchObject({ _tag: "Tool.Error" })
      const unknown = yield* reach!.execute({ from: "ses_nobody", ref: "core/thing.mjs" }, call(borrower.id)).pipe(Effect.flip)
      expect(unknown).toMatchObject({ _tag: "Tool.Error" })
      const missing = yield* reach!.execute({ from: owner.id, ref: "core/absent.mjs" }, call(borrower.id)).pipe(Effect.flip)
      expect(missing).toMatchObject({ _tag: "Tool.Error" })
      const self = yield* reach!.execute({ from: borrower.id, ref: "core/thing.mjs" }, call(borrower.id)).pipe(Effect.flip)
      expect(self).toMatchObject({ _tag: "Tool.Error" })
      const lendEscape = yield* lend!.execute({ to: borrower.id, ref: "../escape" }, call(owner.id)).pipe(Effect.flip)
      expect(lendEscape).toMatchObject({ _tag: "Tool.Error" })
    } finally {
      fs.rmSync(ownerDir, { recursive: true, force: true })
      fs.rmSync(borrowerDir, { recursive: true, force: true })
    }
  }),
)

it.live("delivers a message into another session's inbox and lists peers", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const sessions = yield* Session.Service
    const host = yield* PluginHost.make(plugins)

    yield* AgentsPlugin.Plugin.effect(host)

    const sender = yield* host.session.create({ title: "sender" })
    const target = yield* host.session.create({ title: "target" })
    yield* Effect.sleep("50 millis")

    const tools = yield* host.tool.list()
    const tell = tools.find((tool) => tool.id === "tell")
    const agents = tools.find((tool) => tool.id === "agents")
    expect(tell).toBeDefined()
    expect(agents).toBeDefined()

    const listing = yield* agents!.execute({}, call(sender.id))
    expect(listing.output.peers).toContainEqual(expect.objectContaining({ id: target.id, title: "target" }))
    expect(listing.output.peers).not.toContainEqual(expect.objectContaining({ id: sender.id }))

    // An explicit id survives surrounding whitespace (the address is trimmed).
    const delivered = yield* tell!.execute(
      { to: `  ${target.id}  `, text: "please take the parser task", wake: false },
      call(sender.id),
    )
    expect(delivered.output).toMatchObject({ to: target.id, delivered: true })

    const inbox = yield* sessions.inbox(target.id)
    const message = inbox.find((item) => item.type === "synthetic")
    expect(message?.type === "synthetic" && message.payload.text).toContain("please take the parser task")
    expect(message?.type === "synthetic" && message.payload.text).toContain(sender.id)
    expect(message?.type === "synthetic" && message.payload.metadata).toMatchObject({ from: sender.id })

    const missing = yield* tell!.execute({ to: "ses_nobody", text: "hello", wake: false }, call(sender.id)).pipe(Effect.flip)
    expect(missing).toMatchObject({ _tag: "Tool.Error" })

    const self = yield* tell!.execute({ to: sender.id, text: "hello", wake: false }, call(sender.id)).pipe(Effect.flip)
    expect(self).toMatchObject({ _tag: "Tool.Error" })

    const empty = yield* tell!.execute({ to: target.id, text: "   ", wake: false }, call(sender.id)).pipe(Effect.flip)
    expect(empty).toMatchObject({ _tag: "Tool.Error" })
  }),
)
