import { expect, test } from "bun:test"
import { REGISTER_LEGEND, compactMode, dropTrailingNotices, foldOwnsWindow, gateTurn, gateTools, hasRegister, markRegistered, registerBlock, registerHit } from "../src/plugin/fold-register.js"
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

test("the fold owns the window: no automatic compaction unless FOLD_OFF=1 or FOLD_NATIVE_COMPACT=1", () => {
  expect(foldOwnsWindow({})).toBe(true)
  expect(foldOwnsWindow({ FOLD_OFF: "1" })).toBe(false)
  expect(foldOwnsWindow({ FOLD_NATIVE_COMPACT: "1" })).toBe(false)
  expect(foldOwnsWindow({ FOLD_OFF: "0", FOLD_NATIVE_COMPACT: "0" })).toBe(true)
})

test("the tool gate holds for the whole turn: later steps of the same ask drop the same tools, a new ask decides again", () => {
  const held = new Map<string, { ask: string; removed: string[] }>()
  const all = () => ({ read: 1, snip: 1, swarm: 1, cube: 1, perceive: 1, transcribe: 1 })
  const step1 = all()
  expect(gateTurn(held, "s", "what is X?", step1, () => gateTools(step1, "what is X?", { research: false })).sort()).toEqual(["cube", "perceive", "swarm", "transcribe"])
  expect(Object.keys(step1).sort()).toEqual(["read", "snip"])
  // step 2 of the same ask: the harness rebuilt the full tool set; the held decision removes the same names
  const step2 = all()
  expect(gateTurn(held, "s", "what is X?", step2).sort()).toEqual(["cube", "perceive", "swarm", "transcribe"])
  expect(Object.keys(step2).sort()).toEqual(Object.keys(step1).sort())
  // another session is untouched, and a different ask without a decision removes nothing
  expect(gateTurn(held, "other", "what is X?", all())).toEqual([])
  expect(gateTurn(held, "s", "something else", all())).toEqual([])
  // a research ask keeps swarm and cube, and that choice is held too
  const r1 = all()
  gateTurn(held, "s", "research Y", r1, () => gateTools(r1, "research Y", { research: true }))
  const r2 = all()
  gateTurn(held, "s", "research Y", r2)
  expect("swarm" in r2 && "cube" in r2 && !("perceive" in r2)).toBe(true)
})
