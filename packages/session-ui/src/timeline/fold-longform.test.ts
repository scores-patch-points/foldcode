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

describe("fold longform notice — layers, verdicts and judging", () => {
  test("reads the layer, the slot verdicts, the judging line, the last grade and the marked share", () => {
    const view = readLongform({
      notice: "fold-longform",
      longform: {
        v: 1,
        topic: "elephants",
        kind: "prose",
        layer: "drawn",
        startedAt: 1000,
        calls: 3,
        marked: { marked: 5, placed: 6 },
        stitched: { filled: 6, gaps: 10, text: "# elephants\n\n## Africa" },
        judging: { section: "s2.g1", facts: 5 },
        graded: { section: "s1", title: "Introduction", round: 1, sentences: 2, supported: 2, accepted: true, failed: ["These maps are designed to help."] },
        outline: [
          { id: "s1", title: "Africa and bush", state: "filled", facts: 3, sentences: 3, supported: 3, cut: 0, layer: "stitched", preview: "African bush elephants…" },
          { id: "s2.g1", title: "china", state: "drawing", facts: 5, layer: "drawn" },
          { id: "s2.g2", title: "india", state: "gap", facts: 4 },
          { id: "s3", title: "Trunks", state: "admitted", facts: 2, sentences: 6, supported: 1, marked: 5, layer: "drawn" },
        ],
        current: "s2.g1",
        round: 0,
        done: false,
        sources: 9,
      },
    })!
    expect(view.kind).toBe("prose")
    expect(view.layer).toBe("drawn")
    expect(view.startedAt).toBe(1000)
    expect(view.calls).toBe(3)
    expect(view.marked).toEqual({ marked: 5, placed: 6 })
    expect(view.stitched).toEqual({ filled: 6, gaps: 10, text: "# elephants\n\n## Africa" })
    expect(view.judging).toEqual({ section: "s2.g1", facts: 5 })
    expect(view.graded?.failed).toEqual(["These maps are designed to help."])
    expect(view.outline.map((s) => [s.state, s.sentences, s.supported, s.marked, s.layer])).toEqual([
      ["filled", 3, 3, undefined, "stitched"],
      ["drawing", undefined, undefined, undefined, "drawn"],
      ["gap", undefined, undefined, undefined, undefined],
      ["admitted", 6, 1, 5, "drawn"],
    ])
    expect(view.outline[0].preview).toBe("African bush elephants…")
  })
  test("a notice without the new fields reads as before; a bad graded block is dropped", () => {
    const view = readLongform({ notice: "fold-longform", longform: { topic: "x", outline: [], round: 0, done: false, sources: 0, graded: { nope: 1 }, judging: "s1" } })!
    expect(view.kind).toBe("prose")
    expect(view.layer).toBeUndefined()
    expect(view.graded).toBeUndefined()
    expect(view.judging).toBeUndefined()
  })
})
