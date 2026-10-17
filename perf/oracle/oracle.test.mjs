import test from "node:test"
import assert from "node:assert/strict"
import { makeTasks } from "./tasks.mjs"
import { identity, truncate, pointerDemo, render } from "./arms.mjs"
import { mock } from "./adapters.mjs"
import { evaluate } from "./run.mjs"
import { wilson, summarize, nonInferior } from "./stats.mjs"

test("tasks are reproducible by seed and differ across seeds", () => {
  const a = makeTasks({ seed: 3 }), b = makeTasks({ seed: 3 }), c = makeTasks({ seed: 4 })
  assert.deepEqual(a.map((t) => [t.id, t.expect, t.probe]), b.map((t) => [t.id, t.expect, t.probe]))
  assert.notDeepEqual(a.map((t) => t.expect), c.map((t) => t.expect))
})

test("the answer is in the baseline context exactly where the task says, and the probe does not leak it", () => {
  for (const seed of [1, 2, 3, 4, 5]) for (const t of makeTasks({ seed })) {
    const ctx = render(t.turns)
    assert.ok(!t.probe.includes(t.expect), `${t.id} probe leaks the answer`)
    if (t.kind !== "twohop") assert.ok(new RegExp(`(?<![\\w.])${t.expect}(?!\\w|\\.\\d)`).test(ctx), `${t.id} answer absent from baseline`)
    // a value must not occur by accident: planted values are the only 3-5 digit tokens outside filler's 6 digits
    const hits = ctx.match(new RegExp(`(?<![\\w.])${t.expect}(?!\\w|\\.\\d)`, "g")) ?? []
    if (t.kind !== "twohop") assert.ok(hits.length >= 1 && hits.length <= 2, `${t.id}: ${hits.length} occurrences`)
  }
})

test("graders: exact match passes, stale-first fails, mentioning stale as superseded passes, UNKNOWN fails", () => {
  const t = makeTasks({ seed: 1 }).find((x) => x.kind === "supersede")
  assert.equal(t.grade(`It is ${t.expect}.`).pass, true)
  assert.equal(t.grade(`${t.expect} (an earlier note said ${t.stale})`).pass, true)
  assert.equal(t.grade(`It was ${t.stale}, now ${t.expect}`).pass, false) // commits to the stale value first
  assert.equal(t.grade("UNKNOWN").pass, false)
  assert.equal(t.grade(`${t.expect}0`).pass, false) // 10x the value is not the value
})

test("oracle sensitivity: baseline scores full marks, the truncation negative control is seen as worse", async () => {
  const rows = await evaluate({ adapter: mock, arms: [identity, truncate(6)], n: 2, seeds: [1, 2, 3] })
  const id = rows.filter((r) => r.arm === "identity"), tr = rows.filter((r) => r.arm.startsWith("truncate"))
  assert.equal(summarize(id).p, 1)
  const byId = new Map(makeTasks({ seed: 1 }).concat(makeTasks({ seed: 2 }), makeTasks({ seed: 3 })).map((x) => [x.id, x]))
  for (const r of tr) { // passes exactly when every referent it needs is inside the 6 kept turns
    const task = byId.get(r.task), kept = task.needs.every((n) => n.turn >= task.turns.length - 6)
    assert.equal(r.pass, kept, `${r.task}: truncation should pass iff its needs are kept`)
  }
  assert.ok(summarize(tr).p < 0.6)
  assert.equal(nonInferior(id, tr).ok, false) // the oracle must reject a known-bad arm
  assert.equal(tr.filter((r) => r.depth === 0 && r.kind !== "twohop").every((r) => r.pass), true) // recent control survives truncation
})

test("pointer round-trip: lossless-by-address recovers what truncation loses, at a fraction of the context", async () => {
  const rows = await evaluate({ adapter: mock, arms: [identity, pointerDemo(6)], n: 1, seeds: [1, 2] })
  const id = rows.filter((r) => r.arm === "identity"), pd = rows.filter((r) => r.arm.startsWith("pointer"))
  assert.equal(summarize(pd).p, summarize(id).p)
  assert.ok(summarize(pd).ctxChars < 0.6 * summarize(id).ctxChars)
  assert.ok(pd.some((r) => r.rounds > 0))
  assert.equal(nonInferior(id, pd).ok, true)
})

test("noise floor: identical arms identical runs agree; wilson interval brackets", async () => {
  const rows = await evaluate({ adapter: mock, arms: [identity], n: 4, seeds: [1] })
  assert.equal(summarize(rows).repScoreSD, 0) // the deterministic double has no noise; a real model's SD is what the runner reports
  const w = wilson(45, 50); assert.ok(w.lo < 0.9 && w.hi > 0.9 && w.hi <= 1)
})

import { gate } from "./gary-gate.mjs"
import { handles } from "./arms.mjs"
import { mockFabricating, mechanicalStack, ask } from "./adapters.mjs"

test("gary gate: the instruction and the handle stubs pass; an address or a prohibition in our own text does not", () => {
  const t = makeTasks({ seed: 1 })[0]
  const b = handles(6).build(t)
  assert.equal(gate({ authored: b.authored, context: b.context, probe: t.probe, profile: "small" }).pass, true)
  const addr = gate({ authored: "see [src/a.js#0-75]", probe: "q", profile: "frontier" })
  assert.equal(addr.pass, false)
  assert.ok(addr.gating.some((f) => f.rule === "no-address"))
  const neg = gate({ authored: "do not rename the field", probe: "q", profile: "small" })
  assert.equal(neg.pass, false) // strict Gary gates a prohibition
  assert.equal(gate({ authored: "do not rename the field", probe: "q", profile: "frontier" }).pass, true) // frontier records it, does not gate
  assert.equal(gate({ authored: "do not rename the field", probe: "q", profile: "small", widen: ["information-not-prohibition"] }).pass, true)
})

test("gary gate: a prompt over the loaded window is blocked on the small profile only", () => {
  const t = makeTasks({ seed: 1 })[0]
  const b = identity.build(t)
  assert.equal(gate({ authored: b.authored, context: b.context, probe: t.probe, profile: "small" }).pass, false)
  assert.equal(gate({ authored: b.authored, context: b.context, probe: t.probe, profile: "frontier" }).pass, true)
})

test("handles are opaque and per-prompt: no content-shaped address, different between builds, resolvable", () => {
  const t = makeTasks({ seed: 1 }).find((x) => x.kind === "needle" && x.depth === 28)
  const a = handles(6).build(t), b = handles(6).build(t)
  assert.ok(!/#\d|turn\d+/.test(a.context.replace(/\[turn \d+\]/g, "")))
  assert.notDeepEqual([...a.index.keys()].sort(), [...b.index.keys()].sort())
  const h = [...a.index.entries()].find(([, v]) => v.planted)[0]
  assert.ok(a.resolve(h).includes(t.expect))
})

test("fabricated-handle metric: a model that asks for a handle never issued is counted, and still recovers", async () => {
  const t = makeTasks({ seed: 1 }).find((x) => x.kind === "needle" && x.depth === 28)
  const r = await ask({ adapter: mockFabricating, arm: handles(6), task: t })
  assert.equal(r.fabricated, 1)
  assert.ok(r.snips >= 2)
  assert.equal(t.grade(r.answer).pass, true)
  const clean = await ask({ adapter: mock, arm: handles(6), task: t })
  assert.equal(clean.fabricated, 0)
  assert.equal(clean.leaked, 0)
})

test("mechanical stack eye answers what agents said, and reports a gap for a fact only a tool result held", async () => {
  const tasks = makeTasks({ seed: 1 })
  const prose = tasks.find((x) => x.kind === "prose" && x.depth === 10)
  const needle = tasks.find((x) => x.kind === "needle" && x.depth === 10)
  const p = await mechanicalStack.ask("", { task: prose })
  const n = await mechanicalStack.ask("", { task: needle })
  assert.match(n.text, /UNKNOWN/)
  assert.ok(/ANSWER: \d+|UNKNOWN/.test(p.text)) // may or may not hit; the eyes report measures which
})

import { sealedArm, mechanicalSelector } from "./arms.mjs"
import { selectPrompt, parseSelection, referentsOf, beingsOf, sealedEnabled } from "../../../khora/opencode-sealed.mjs"

test("sealed toggle: FOLD_SEALED=1 is on, anything else is off; off delegates to the handles shape", async () => {
  assert.equal(sealedEnabled({ FOLD_SEALED: "1" }), true)
  assert.equal(sealedEnabled({ FOLD_SEALED: "0" }), false)
  assert.equal(sealedEnabled({}), false)
  const t = makeTasks({ seed: 1 }).find((x) => x.kind === "needle" && x.depth === 10)
  const off = await sealedArm({ enabled: false }).build(t)
  assert.equal(off.meta.sealed, false)
  assert.ok(off.index instanceof Map && off.index.size > 0) // handles shape: names are SNIP-able
  const on = await sealedArm({ enabled: true }).build(t)
  assert.equal(on.meta.sealed, true)
})

test("sealed is much smaller than the identity prompt and keeps the answer when the selector picks the right referent", async () => {
  const tasks = makeTasks({ seed: 1 }), arm = sealedArm({ enabled: true })
  let ok = 0, n = 0
  for (const t of tasks.filter((x) => x.kind === "needle")) {
    const b = await arm.build(t), full = identity.build(t).context
    assert.ok(b.context.length < 0.3 * full.length, `${t.id}: ${b.context.length} vs ${full.length}`)
    n++; if (b.meta.needOld === 0 || b.meta.gotOld === b.meta.needOld) ok++
  }
  assert.ok(ok >= 2, `mechanical selector should find most name-matchable needles, got ${ok}/${n}`) // it may miss some: that is the delta a local model exists to close
})

test("an oracle selector gets full recall and full marks; a blind selector falls back to unsealed and still answers via SNIP", async () => {
  const oracleSel = (task) => ({ name: "oracle", select: async (_p, refs) => refs.map((r, i) => (task.needs.some((n) => n.turn === r.turn && n.part === r.part) ? i : -1)).filter((i) => i >= 0) })
  const rows = []
  for (const t of makeTasks({ seed: 2 })) {
    const arm = sealedArm({ enabled: true, selector: oracleSel(t) })
    const out = await ask({ adapter: mock, arm, task: t })
    rows.push(t.grade(out.answer).pass)
    assert.equal(out.meta.gotOld, out.meta.needOld)
  }
  assert.ok(rows.every(Boolean), "oracle selector -> all pass")
  const blind = sealedArm({ enabled: true, selector: { name: "blind", select: async () => [] } })
  const t = makeTasks({ seed: 2 }).find((x) => x.kind === "needle" && x.depth === 28)
  const out = await ask({ adapter: mock, arm: blind, task: t })
  assert.equal(out.meta.unsealed, true)
  assert.equal(t.grade(out.answer).pass, true)
  assert.ok(out.snips >= 1)
})

test("the selector prompt is tiny, shows names only, and passes Gary on the small profile; parse tolerates chatter", () => {
  const t = makeTasks({ seed: 1 }).find((x) => x.kind === "needle")
  const { refs } = referentsOf(t.turns, { keep: 6 })
  const p = selectPrompt(t.probe, refs)
  assert.ok(p.length < 4500, `selector prompt ${p.length} chars`)
  assert.ok(!p.includes(t.turns[0].calls[0].output.slice(0, 60)), "no bytes in the selector prompt")
  assert.equal(gate({ authored: p, probe: "", profile: "small" }).pass, true, JSON.stringify(gate({ authored: p, probe: "", profile: "small" }).gating))
  assert.deepEqual(parseSelection("I think 3, 7 and 99.", 24), [2, 6])
  assert.deepEqual(parseSelection("NONE", 24), [])
  assert.deepEqual(beingsOf("export const FOO_BAR = 1\nconst x = LEASE_BYTES"), ["FOO_BAR", "LEASE_BYTES"])
})

import * as TR from "../../../khora/opencode-trail.mjs"
import { trailArm } from "./arms.mjs"

test("trail: a key read again and again outranks a one-off, which plain age would not", () => {
  const results = [{ id: "x", key: "old.js", step: 5 }, ...[6, 7, 8, 9].map((s) => ({ id: `a${s}`, key: "a.js", step: s })), { id: "z", key: "z.js", step: 4 }]
  const p = TR.plan({ results, now: 10, keep: 1 })
  assert.deepEqual([...p.keep], ["a9"], "the reinforced key's latest result stands; its older reads and the one-offs become handles")
  assert.equal(p.point.size, 5)
})
test("trail: handles are opaque (nothing of turn, path or bytes), deterministic, and unique", () => {
  const h = TR.handleOf("tool_call_abc123")
  assert.match(h, /^r[0-9a-z]{5,}$/)
  assert.equal(h, TR.handleOf("tool_call_abc123"))
  assert.notEqual(h, TR.handleOf("tool_call_abc124"))
  const taken = new Set([h])
  assert.notEqual(TR.handleOf("tool_call_abc123", taken), h)
})
test("trail: monotone - a result already pointerized never comes back verbatim", () => {
  const results = [{ id: "a", key: "k", step: 1 }, { id: "b", key: "k", step: 2 }]
  const p = TR.plan({ results, now: 2, keep: 5, already: new Set(["b"]) })
  assert.ok(!p.keep.has("b") && p.point.has("b"))
})
test("trail: the cost gate - no compaction while the cache is warm and the prompt small; yes when cold or near the window", () => {
  assert.deepEqual(TR.shouldCompact({ idleMs: 1000, tokens: 20_000, env: {} }), { go: false, why: "cache_warm" })
  assert.equal(TR.shouldCompact({ idleMs: 400_000, tokens: 20_000, env: {} }).why, "cache_cold")
  assert.equal(TR.shouldCompact({ idleMs: 1000, tokens: 120_000, window: 200_000, env: {} }).why, "window_pressure")
  assert.equal(TR.trailEnabled({ FOLD_TRAIL: "1" }), true)
  assert.equal(TR.trailEnabled({}), false)
})
test("trail arm: toggle off is the identity prompt; on cuts most of it and every pointer resolves", async () => {
  for (const t of makeTasks({ seed: 1 })) {
    const off = await trailArm({ enabled: false }).build(t), id = identity.build(t)
    assert.equal(off.context, id.context)
    const on = await trailArm({ keep: 5, enabled: true }).build(t)
    assert.ok(on.context.length < 0.4 * id.context.length, `${t.id}: ${on.context.length} vs ${id.context.length}`)
    assert.equal(on.meta.kept, 5)
    for (const h of on.index.keys()) assert.ok(on.resolve(h).length > 100)
  }
})
test("trail arm + mock: facts in the 5 kept results are read directly, the rest are recovered by SNIP", async () => {
  const rows = []
  for (const t of makeTasks({ seed: 3 })) {
    const out = await ask({ adapter: mock, arm: trailArm({ keep: 5, enabled: true }), task: t })
    rows.push({ pass: t.grade(out.answer).pass, rounds: out.rounds, fabricated: out.fabricated, depth: t.depth })
  }
  assert.ok(rows.every((r) => r.pass), JSON.stringify(rows.filter((r) => !r.pass)))
  assert.ok(rows.every((r) => r.fabricated === 0))
  assert.ok(rows.filter((r) => r.depth === 0).every((r) => r.rounds === 0), "a fact in the newest results costs no SNIP")
})

test("non-inferiority never passes on errored rows: no data is not a tie", () => {
  const bad = [{ task: "a", pass: false, error: "boom" }, { task: "b", pass: false, error: "boom" }]
  assert.equal(nonInferior(bad, bad).ok, false)
  assert.equal(nonInferior(bad, bad).tasks, 0)
})
