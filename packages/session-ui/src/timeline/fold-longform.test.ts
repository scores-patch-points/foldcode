import { describe, expect, test } from "bun:test"
import { readLongform } from "./fold-longform"

describe("fold longform notice", () => {
  test("reads the piece as given: topic, outline with states, the section being written, round, sources", () => {
    const view = readLongform({
      notice: "fold-longform",
      longform: {
        v: 1,
        topic: "dolphins",
        outline: [
          { id: "s1", title: "What a dolphin is", state: "written", facts: 9 },
          { id: "s2", title: "Echolocation", state: "writing", facts: 7 },
          { id: "s3", title: "Social life", state: "planned", facts: 4 },
          { id: "s4", title: "Dolphins in myth", state: "cut", facts: 0 },
        ],
        current: "s2",
        round: 2,
        done: false,
        sources: 35,
      },
    })!
    expect(view.topic).toBe("dolphins")
    expect(view.outline.map((s) => [s.id, s.state, s.facts])).toEqual([
      ["s1", "written", 9],
      ["s2", "writing", 7],
      ["s3", "planned", 4],
      ["s4", "cut", 0],
    ])
    expect(view.current).toBe("s2")
    expect(view.round).toBe(2)
    expect(view.done).toBe(false)
    expect(view.sources).toBe(35)
  })
  test("another notice, or no longform, is not a longform view", () => {
    expect(readLongform({ notice: "fold-research", research: {} })).toBeUndefined()
    expect(readLongform({ notice: "fold-longform" })).toBeUndefined()
    expect(readLongform({ notice: "fold-longform", longform: "dolphins" })).toBeUndefined()
    expect(readLongform(undefined)).toBeUndefined()
  })
  test("a malformed outline keeps the sections it can read; an unknown state reads as planned", () => {
    const view = readLongform({
      notice: "fold-longform",
      longform: {
        topic: "dolphins",
        outline: [
          { id: "s1", title: "Kept", state: "written", facts: "3" },
          { id: "s2", state: "writing" },
          { title: "no id", state: "planned" },
          "s4",
          null,
          { id: "s5", title: "Odd state", state: "drafted", facts: 2 },
        ],
        current: null,
        round: "two",
        done: "yes",
        sources: -0,
      },
    })!
    expect(view.outline).toEqual([
      { id: "s1", title: "Kept", state: "written", facts: 0 },
      { id: "s5", title: "Odd state", state: "planned", facts: 2 },
    ])
    expect(view.current).toBeUndefined()
    expect(view.round).toBe(0)
    expect(view.done).toBe(false)
    expect(readLongform({ notice: "fold-longform", longform: { topic: "x", outline: "not a list" } })!.outline).toEqual(
      [],
    )
  })
})
