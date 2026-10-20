import { describe, expect, test } from "bun:test"
import { gatherPassages, groundHead, groundPayload } from "../src/plugin/fold-ground"

const answer = {
  sentences: [{ text: "Curie discovered radium." }],
  step: {
    output: "Curie discovered radium. The element glows.",
    superseded: null,
    grounded: [
      {
        text: "Curie discovered radium.",
        standing: "grounded",
        ref: "mat.txt#9",
        sources: [{ passage: "mat.txt", text: "Marie Curie discovered radium." }],
      },
      { text: "The element glows.", standing: "self:model", source: "the mouth" },
    ],
  },
}

describe("fold ground payload", () => {
  test("carries the door's step untouched", () => {
    const p = groundPayload(answer, "full")!
    expect(p.step?.grounded).toEqual(answer.step.grounded)
    expect(p.step?.output).toBe(answer.step.output)
    expect(groundHead(p)).toBe("fold facing · the ground · 1 grounded · 0 identity-only · 1 self:model")
  })
  test("off drops it", () => {
    expect(groundPayload(answer, "off")).toBeUndefined()
  })
  test("no step is a typed gap, never an invented one", () => {
    expect(groundPayload({ sentences: [{ text: "x" }] }, "full")).toEqual({
      v: 1,
      step: null,
      gap: "no step this turn",
    })
    expect(groundPayload({}, "full")).toBeUndefined()
    expect(groundPayload(undefined, "full")?.gap).toBe("no step this turn")
  })
  test("passages keep the newest within budget, labelled; a read's header names the passage", () => {
    expect(
      gatherPassages(
        [
          { name: "read", text: "aaaa" },
          { name: "grep", text: "bbbb" },
        ],
        6,
      ),
    ).toEqual([
      { name: "read", text: "aa" },
      { name: "grep", text: "bbbb" },
    ])
    expect(gatherPassages([{ name: "read", text: "Read file /a/mat.txt, lines 1-2\n1: Marie Curie." }])).toEqual([
      { name: "/a/mat.txt", text: "Marie Curie." },
    ])
    expect(gatherPassages([{ name: "read", text: "Read file /a/mat.txt, lines 3-4\n3: She won twice.\n4: 12 papers." }])).toEqual([
      { name: "/a/mat.txt", text: "\n\nShe won twice.\n12 papers." },
    ])
  })
  test("the door's profile rides the payload untouched and heads the notice", () => {
    const profile = {
      v: 2 as const,
      kind: "essay",
      counts: { supported: 2, contradicted: 1, unsupported: 1, not_found: 0, symbol_contradicted: 0 },
      claims: [{ text: "She was born in 1869.", standing: "contradicted" }],
      symbols: [],
      research: { on: false, pending: 1 },
    }
    const p = groundPayload({ step: { ...answer.step, profile } }, "full")!
    expect(p.step?.profile).toEqual(profile)
    expect(groundHead(p)).toBe("fold facing · the profile · essay · 2 supported · 1 contradicted · 1 unsupported · researching")
  })
})
