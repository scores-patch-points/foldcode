import { expect, test } from "bun:test"
import { contextChars, stepApply, stepPlan } from "../src/plugin/fold.js"

// SAFETY: the step fold reads only role, id, and the text / tool-call / tool-result parts it names; this minimal
// shape exercises plan/apply exactly, and no field the functions do not read is fabricated.
type M = Parameters<typeof stepApply>[0][number]
const user = (id: string, text: string) => ({ id, role: "user", content: [{ type: "text", text }] }) as unknown as M
const call = (id: string, name: string, input: Record<string, unknown>) =>
  ({ id: `a-${id}`, role: "assistant", content: [{ type: "tool-call", id, name, input }] }) as unknown as M
const result = (id: string, name: string, value: string) =>
  ({ id: `r-${id}`, role: "tool", content: [{ type: "tool-result", id, name, result: { type: "text", value } }] }) as unknown as M
const step = (id: string, name: string, input: Record<string, unknown>, out: string) => [call(id, name, input), result(id, name, out)]

const session = () => [
  user("u1", "implement the parser and make the tests pass"),
  ...step("c1", "read_file", { path: "src/a.ts" }, "A_OLD_BYTES ".repeat(50) + "A_OLD_TAIL_MARKER"),
  ...step("c2", "write_file", { path: "src/a.ts", content: "A_NEW_BYTES" }, "wrote src/a.ts"),
  ...step("c3", "read_file", { path: "src/b.ts" }, "B_BYTES_UNTOUCHED ".repeat(30)),
  ...step("c4", "read_file", { path: "src/c.ts" }, "C_BYTES_EDITED ".repeat(30)),
  ...step("c5", "edit_file", { path: "src/c.ts", old: "x", new: "y" }, "edited"),
  ...step("c6", "run_tests", {}, "visible: 3/9 passed"),
  ...step("c7", "read_file", { path: "src/d.ts" }, "D_BYTES_KEPT"),
  ...step("c8", "run_tests", {}, "visible: 9/9 passed"),
]

test("step fold is off by default and when keep is 0", () => {
  expect(stepPlan(session(), 0)).toBeUndefined()
})

test("older whole steps leave the window; the last K stay; no tool result is orphaned", () => {
  const messages = session()
  const before = contextChars(messages)
  const plan = stepPlan(messages, 2)
  expect(plan).toBeTruthy()
  if (!plan) return
  const store = new Map<string, string>()
  stepApply(messages, plan, 2, store)
  const all = JSON.stringify(messages)
  expect(contextChars(messages)).toBeLessThan(before)
  expect(all).not.toContain("A_OLD_TAIL_MARKER") // a folded step's full bytes do not ride (the receipt keeps a 140-char preview only)
  expect(all).toContain("D_BYTES_KEPT") // the last two steps are verbatim
  expect(all).toContain("visible: 9/9 passed")
  expect(messages[0].content.some((p) => p.type === "text" && p.text.includes("implement the parser"))).toBe(true) // the ask survives
  const callIds = new Set(messages.flatMap((m) => m.content.flatMap((p) => (p.type === "tool-call" ? [p.id] : []))))
  for (const m of messages) for (const p of m.content) if (p.type === "tool-result") expect(callIds.has(p.id)).toBe(true)
  for (const st of plan.steps) expect(store.get(st.handle)).toBe(st.raw) // every receipt resolves to its exact bytes
  expect(store.get(plan.steps[0].handle)).toContain("A_OLD_TAIL_MARKER")
  for (const st of plan.steps) expect(st.handle).toMatch(/^r[0-9a-z]{4,16}$/) // the snip tool resolves these locally
})

test("the workspace view holds the LATEST bytes of a file, omits an edited file, and omits a file visible in a kept step", () => {
  const messages = session()
  const plan = stepPlan(messages, 2)
  if (!plan) throw new Error("no plan")
  const paths = plan.view.map(([p]) => p)
  expect(paths).toContain("src/a.ts")
  expect(plan.view.find(([p]) => p === "src/a.ts")?.[1]).toBe("A_NEW_BYTES") // the write superseded the older read
  expect(paths).toContain("src/b.ts")
  expect(paths).not.toContain("src/c.ts") // edited after read: unknown, not shown stale
  expect(paths).not.toContain("src/d.ts") // lives in a kept step
})

test("the view is bounded", () => {
  const prev = process.env.FOLD_VIEW_CHARS
  process.env.FOLD_VIEW_CHARS = "300"
  try {
    const messages = [
      user("u1", "go"),
      ...Array.from({ length: 10 }, (_, i) => step(`c${i}`, "read_file", { path: `f${i}.ts` }, `F${i}_`.repeat(100))).flat(),
      ...step("last", "run_tests", {}, "ok"),
    ]
    const plan = stepPlan(messages, 1)
    if (!plan) throw new Error("no plan")
    expect(plan.view.reduce((n, [, b]) => n + b.length, 0)).toBeLessThanOrEqual(300)
    expect(plan.view.at(-1)?.[0]).toBe("f9.ts") // most recent survives
  } finally {
    if (prev === undefined) delete process.env.FOLD_VIEW_CHARS
    else process.env.FOLD_VIEW_CHARS = prev
  }
})

test("a turn with no more steps than keep is untouched", () => {
  expect(stepPlan(session(), 8)).toBeUndefined()
  expect(stepPlan(session(), 99)).toBeUndefined()
})
