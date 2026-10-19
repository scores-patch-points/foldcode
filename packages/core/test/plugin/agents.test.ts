import { expect, test } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Plugin } from "@opencode/core/plugin"
import { AgentsPlugin } from "@opencode/core/plugin/agents"
import { PluginHost } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
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

    // Falsifiers: an unknown address, a self-address, and an empty message all refuse.
    const missing = yield* tell!.execute({ to: "ses_nobody", text: "hello", wake: false }, call(sender.id)).pipe(Effect.flip)
    expect(missing).toMatchObject({ _tag: "Tool.Error" })

    const self = yield* tell!.execute({ to: sender.id, text: "hello", wake: false }, call(sender.id)).pipe(Effect.flip)
    expect(self).toMatchObject({ _tag: "Tool.Error" })

    const empty = yield* tell!.execute({ to: target.id, text: "   ", wake: false }, call(sender.id)).pipe(Effect.flip)
    expect(empty).toMatchObject({ _tag: "Tool.Error" })
  }),
)
