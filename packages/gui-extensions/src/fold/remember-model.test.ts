import { describe, expect, test } from "bun:test"
import { emptyReason, groupByTag, isPrompt, whenLabel, type PromptEntry, type RecallEntry } from "./remember-model"

describe("remember model", () => {
  test("isPrompt distinguishes a system prompt from a recall entry", () => {
    expect(isPrompt({ claim: "x", tag: "t" })).toBe(false)
    expect(isPrompt({ name: "n", text: "do it" })).toBe(true)
  })

  test("recall entries group under their tag, first-seen order", () => {
    const entries: RecallEntry[] = [
      { claim: "a", tag: "about:user:repos" },
      { claim: "b", tag: "about:user:accounts" },
      { claim: "c", tag: "about:user:repos" },
    ]

    const groups = groupByTag(entries)
    expect(groups.map((group) => group.tag)).toEqual(["about:user:repos", "about:user:accounts"])
    expect(groups[0]?.entries.map((entry) => entry.claim)).toEqual(["a", "c"])
  })

  test("groupByTag on an empty store is an empty list, never a throw", () => {
    expect(groupByTag([])).toEqual([])
  })

  test("a system prompt's label reads its when-terms, else the fallback", () => {
    expect(whenLabel({ name: "style", when: "commit message", text: "x" })).toBe("when: commit message")
    expect(whenLabel({ name: "style", text: "x" })).toBe("by name and text")
  })

  test("emptyReason discloses the door's own typed gap", () => {
    expect(emptyReason("no-store")).toMatch(/Nothing here yet/)
    expect(emptyReason("unknown-kind")).toMatch(/does not know/)
    expect(emptyReason(undefined)).toMatch(/Nothing here yet/)
    const prompt: PromptEntry = { name: "n", text: "t" }
    expect(prompt.text).toBe("t")
  })
})
