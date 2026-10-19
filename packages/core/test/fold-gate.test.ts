import { expect, test } from "bun:test"
import { capContext, contextChars, gateStepPlan, stepApply } from "../src/plugin/fold.js"

// THE GATE: the whole prompt (tool definitions = `fixed`, plus system and messages) stays under FOLD_GATE_CHARS,
// and getting there loses nothing — every byte that leaves the window is held under a snip handle.
type M = Parameters<typeof capContext>[0][number]
// SAFETY: the minimal shapes the fold reads (role, part type, id/name/input, result text); nothing else is fabricated.
const ask = (text: string) => ({ id: "u1", role: "user", content: [{ type: "text", text }] }) as unknown as M
const call = (id: string, path: string) => ({ role: "assistant", content: [{ type: "tool-call", id, name: "read", input: { path } }] }) as unknown as M
const result = (id: string, value: string) =>
  ({ role: "tool", content: [{ type: "tool-result", id, name: "read", result: { type: "text", value } }] }) as unknown as M

const withEnv = <T>(env: Record<string, string>, fn: () => T): T => {
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}

// The dolphin loop's shape: one ask, then many steps that each read a large file.
const session = (steps: number) => [
  ask("build me a website that look reddit but only about dolphin content"),
  ...Array.from({ length: steps }, (_, i) => [call(`c${i}`, i % 2 ? "README.md" : "dolphinit.html"), result(`c${i}`, `${i}:` + "d".repeat(i % 2 ? 300 : 21_000))]).flat(),
]

test("over the gate, the step fold picks the most steps that fit — even with FOLD_KEEP_STEPS off", () => {
  withEnv({ FOLD_GATE_CHARS: "48000", FOLD_KEEP_STEPS: "0", FOLD_MAX_CHARS: "1000000" }, () => {
    const messages = session(20)
    const fixed = 31_000 // ~7.8k tokens of system + tool definitions, measured on the live prompt
    const gated = gateStepPlan(messages, fixed, 4)
    expect(gated).toBeTruthy()
    stepApply(messages, gated!.plan, gated!.keep, new Map())
    expect(contextChars(messages) + fixed).toBeLessThanOrEqual(48_000)
  })
})

test("the gate never refuses: the cap brings any window under it, and every cut is held by handle", () => {
  withEnv({ FOLD_GATE_CHARS: "20000", FOLD_MAX_CHARS: "1000000" }, () => {
    const messages = session(6)
    const originals = new Map(messages.flatMap((m) => m.content.flatMap((p) => (p.type === "tool-result" ? [[p.id, (p.result as { value: string }).value]] : []))))
    const store = new Map<string, string>()
    capContext(messages, [], { fixed: 8_000, store })
    expect(contextChars(messages) + 8_000).toBeLessThanOrEqual(20_000)
    // lossless: each cut names a handle, and the handle returns the exact original bytes
    const shown = messages.flatMap((m) => m.content.flatMap((p) => (p.type === "tool-result" ? [[p.id, (p.result as { value: string }).value] as const] : [])))
    for (const [id, value] of shown) {
      const handle = value.match(/snip (r[0-9a-z]{4,16}) returns all of it/)?.[1]
      if (value !== originals.get(id)) expect(store.get(handle!)).toBe(originals.get(id)!)
    }
    // a step that left whole is a receipt in the head, and its handle holds its exact bytes
    for (const receipt of messages[0].content.flatMap((p) => (p.type === "text" ? [p.text] : [])).filter((t) => t.includes("left the window"))) {
      const handle = receipt.match(/snip (r[0-9a-z]{4,16})/)![1]
      expect(store.has(handle)).toBe(true)
    }
    expect(store.size).toBeGreaterThan(0)
  })
})

test("under the gate nothing changes", () => {
  withEnv({ FOLD_GATE_CHARS: "48000", FOLD_MAX_CHARS: "1000000" }, () => {
    const messages = session(2)
    const before = JSON.stringify(messages)
    expect(gateStepPlan(messages, 1_000, 4)).toBeUndefined()
    capContext(messages, [], { fixed: 1_000, store: new Map() })
    expect(JSON.stringify(messages)).toBe(before)
  })
})

// PREFIX STABILITY — the cache only reuses an unchanged prefix. Grow one turn step by step, as a live session
// does, and require every request to be the previous request plus the new step, except at the rare jumps.
import { stableStepCut, stepPlan, type StepEpoch } from "../src/plugin/fold.js"

test("a growing turn is append-only between fold jumps, and the jumps are rare", () => {
  withEnv({ FOLD_GATE_CHARS: "48000", FOLD_MAX_CHARS: "1000000", FOLD_VIEW_CHARS: "40000" }, () => {
    const fixed = 31_000
    let epoch: StepEpoch | undefined
    let prev = ""
    let jumps = 0
    for (let n = 1; n <= 40; n++) {
      const messages = session(n).map((m) => ({ ...m, content: m.content.map((p) => ({ ...p })) })) as M[]
      epoch = stableStepCut(messages, { tools: fixed, system: 0 }, epoch)
      const steps = n
      if (epoch && epoch.cut > 0) stepApply(messages, stepPlan(messages, steps - epoch.cut, epoch.view)!, steps - epoch.cut, new Map())
      capContext(messages, [], { fixed, store: new Map() }) // the pipeline: fold, then the cap
      const body = JSON.stringify(messages)
      expect(contextChars(messages) + fixed).toBeLessThanOrEqual(48_000)
      // How far the previous request survives into this one. A step that only appended keeps nearly all of it;
      // the cap may cut the previous step's own large result to its floor, so "nearly" is 85%.
      if (prev) {
        let k = 0
        while (k < prev.length && prev[k] === body[k]) k++
        if (k < prev.length * 0.85) jumps++
      }
      prev = body
    }
    expect(jumps).toBeLessThanOrEqual(10) // was 35 of 40 when every request re-folded
  })
})
