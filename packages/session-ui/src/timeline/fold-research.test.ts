import { describe, expect, test } from "bun:test"
import { readResearch } from "./fold-research"

describe("fold research notice", () => {
  test("reads the door's progress as given: queries, the page being read, the pages read", () => {
    const view = readResearch({
      notice: "fold-research",
      research: {
        v: 1,
        elapsedMs: 24_000,
        searches: [{ q: "dolphins", n: 20 }, { q: "Dolphin marine mammal", n: 10 }],
        candidates: 18,
        read: [{ host: "wwf.org.uk", title: "Fascinating facts about dolphins" }, "animals.net"],
        reading: { host: "nationalgeographic.com", title: "Dolphins" },
        stop: null,
        done: false,
      },
    })!
    expect(view.elapsedMs).toBe(24_000)
    expect(view.searches).toEqual([{ q: "dolphins", n: 20 }, { q: "Dolphin marine mammal", n: 10 }])
    expect(view.read).toEqual([{ host: "wwf.org.uk", title: "Fascinating facts about dolphins" }, { host: "animals.net" }])
    expect(view.reading).toEqual({ host: "nationalgeographic.com", title: "Dolphins" })
    expect(view.done).toBe(false)
  })
  test("another notice, or no research, is not a research view", () => {
    expect(readResearch({ notice: "fold-ground", ground: {} })).toBeUndefined()
    expect(readResearch({ notice: "fold-research" })).toBeUndefined()
    expect(readResearch(undefined)).toBeUndefined()
  })
})
