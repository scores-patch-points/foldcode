import { expect, test } from "bun:test"
import { REGISTER_LEGEND, compactMode, compactionTools, dropTrailingNotices, gateTools, hasRegister, markRegistered, registerBlock, registerHit } from "../src/plugin/fold-register.js"
import { isPersonNotice } from "../src/plugin/fold.js"

// SAFETY: these helpers read only role and text parts; the minimal shapes below fabricate no field they do not read.
type M = { role: string; content: Array<{ type: string; text?: string }> }
const msg = (role: string, text: string): M => ({ role, content: [{ type: "text", text }] })

test("registerHit: a value, a contradiction or a provenance is a hit; a gap, a miss or a dead door is not", () => {
  expect(registerHit({ ok: true, answer: { value: "Orbit", turn: 1, kind: "lookup" } })).toBe(true)
  expect(registerHit({ ok: true, answer: { contradiction: { stored: "Orbit", claimed: "Comet" }, kind: "contradiction" } })).toBe(true)
  expect(registerHit({ ok: true, answer: { value: "Orbit", turns: [{ turn: 1 }], kind: "provenance" } })).toBe(true)
  expect(registerHit({ ok: true, answer: { gap: "not-found" } })).toBe(false)
  expect(registerHit({ ok: true, answer: null })).toBe(false)
  expect(registerHit({ ok: false, gap: "off" })).toBe(false)
  expect(registerHit(undefined)).toBe(false)
})

test("registerBlock: only a <fold-register> block rides; anything else is nothing", () => {
  expect(registerBlock({ register: "<fold-register>\nThe x is y — you said so in turn 1.\n</fold-register>" })).toMatch(/^<fold-register>/)
  expect(registerBlock({ note: "<fold-register>\nline\n</fold-register>" })).toMatch(/^<fold-register>/)
  expect(registerBlock({ register: "" })).toBeUndefined()
  expect(registerBlock({ register: "fold measured · something" })).toBeUndefined()
  expect(registerBlock(undefined)).toBeUndefined()
})

test("the legend states a fact, never a prohibition", () => {
  expect(REGISTER_LEGEND).toMatch(/<fold-register>/)
  expect(REGISTER_LEGEND).not.toMatch(/\b(?:never|do not|don't|must not)\b/i)
})

test("compaction mode: FOLD_COMPACT decides when set; unset, a session with a register compacts to the record", () => {
  expect(compactMode("record", false)).toBe("record")
  expect(compactMode("model", true)).toBe("model")
  expect(compactMode(undefined, true)).toBe("record")
  expect(compactMode(undefined, false)).toBe("model")
  markRegistered("s1", true)
  expect(hasRegister("s1")).toBe(true)
  markRegistered("s1", false)
  expect(hasRegister("s1")).toBe(false)
})

test("a request never ends on the fold's own notice: trailing assistant notices are dropped, a real answer is kept", () => {
  const a: M[] = [msg("user", "what is it called?"), msg("assistant", "fold measured · research — 3 source(s) read: a.com")]
  expect(dropTrailingNotices(a, isPersonNotice)).toBe(1)
  expect(a.length).toBe(1)
  const b: M[] = [msg("user", "hi"), msg("assistant", "Hello."), msg("assistant", "fold facing · the ground · 2 grounded")]
  expect(dropTrailingNotices(b, isPersonNotice)).toBe(1)
  expect(b.at(-1)?.content[0]?.text).toBe("Hello.")
  const c: M[] = [msg("user", "hi"), msg("assistant", "Hello.")]
  expect(dropTrailingNotices(c, isPersonNotice)).toBe(0)
  expect(c.length).toBe(2)
})

test("tool gate: research and media tools leave a chat turn; snip and fold always ride; a media ask keeps perceive", () => {
  const tools = () => ({ fold: {}, snip: {}, swarm: {}, cube: {}, perceive: {}, transcribe: {}, bash: {} }) as Record<string, unknown>
  const chat = tools()
  expect(gateTools(chat, "what is the mascot service called?", { research: false }).sort()).toEqual(["cube", "perceive", "swarm", "transcribe"])
  expect(Object.keys(chat).sort()).toEqual(["bash", "fold", "snip"])
  const research = tools()
  expect(gateTools(research, "tell me about dolphins", { research: true }).sort()).toEqual(["perceive", "transcribe"])
  const media = tools()
  expect(gateTools(media, "read ./scan.pdf and summarise it", { research: false }).sort()).toEqual(["cube", "swarm"])
  const prefixed = { fold_swarm: {}, "tool:cube": {} } as Record<string, unknown>
  expect(gateTools(prefixed, "hello", { research: false }).sort()).toEqual(["fold_swarm", "tool:cube"])
})

// F7: a compaction summary request carries none of the fold. The context hook never runs for it (so no register, legend or note
// rides), and the fold's six tools, the one thing of the fold's it carried, come off; the session's own tools stay.
test("compactionTools: the fold's own tools come off a compaction request, the session's tools stay", () => {
  const tools: Record<string, unknown> = {
    read: 1, bash: 1, write: 1, edit: 1, grep: 1, webfetch: 1,
    fold: 1, snip: 1, swarm: 1, cube: 1, perceive: 1, transcribe: 1,
    "mcp_fold-door_snip": 1,
  }
  const removed = compactionTools(tools)
  expect(removed.sort()).toEqual(["cube", "fold", "mcp_fold-door_snip", "perceive", "snip", "swarm", "transcribe"])
  expect(Object.keys(tools).sort()).toEqual(["bash", "edit", "grep", "read", "webfetch", "write"])
  // nothing of the fold's is put in: the hook adds no block, so an empty set stays empty
  const none: Record<string, unknown> = {}
  expect(compactionTools(none)).toEqual([])
  expect(none).toEqual({})
})
