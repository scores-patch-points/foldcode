import { describe, expect, test } from "bun:test"
import { ago, counts, order, titleOf, type Plan } from "./plans-model"

const plan = (task: string, updated: number, extra: Partial<Plan> = {}): Plan => ({
  task,
  updated,
  marks: [],
  open: [],
  finished: [],
  turns: [],
  ...extra,
})

describe("work plans", () => {
  test("the session's own plan comes first, then by recency", () => {
    const list = order([plan("a", 1), plan("b", 3), plan("c", 2)], "a")
    expect(list.map((item) => item.task)).toEqual(["a", "b", "c"])
  })

  test("a plan is named by its first ask", () => {
    const named = plan("ses_1", 0, { turns: [{ agent: "x", n: 1, ask: "  wire the work tree  ", tools: [], text: "" }] })
    expect(titleOf(named)).toBe("wire the work tree")
    expect(titleOf(plan("ses_2", 0))).toBe("ses_2")
  })

  test("marks are counted by kind", () => {
    const marked = plan("t", 0, {
      marks: [
        { t: 1, agent: "a", kind: "fact", text: "x" },
        { t: 2, agent: "a", kind: "fact", text: "y" },
        { t: 3, agent: "a", kind: "done", text: "z" },
      ],
    })
    expect(counts(marked)).toEqual({ fact: 2, claim: 0, done: 1, block: 0 })
  })

  test("ago reads in the largest sensible unit", () => {
    expect(ago(0, 45_000)).toBe("45s ago")
    expect(ago(0, 5 * 60_000)).toBe("5m ago")
    expect(ago(0, 3 * 3_600_000)).toBe("3h ago")
  })
})
