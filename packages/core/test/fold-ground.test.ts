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

describe("fold ground notice", () => {
  test("the ground and profile notices never read as a wake (they are committed on the bus, not admitted)", async () => {
    const { isGroundNotice, isPersonNotice } = await import("../src/plugin/fold")
    expect(isGroundNotice("fold facing · the profile · essay · 2 supported")).toBe(true)
    expect(isGroundNotice("fold facing · the ground · no step this turn")).toBe(true)
    expect(isGroundNotice("fold facing · 3 grounded · 1 self")).toBe(false)
    expect(isPersonNotice("fold facing · the profile · essay")).toBe(true)
  })
})

describe("fold grounding hand-back", () => {
  const profile = {
    v: 2 as const,
    kind: "essay",
    counts: {},
    claims: [
      {
        text: "Marie Curie was born in 1869.",
        standing: "contradicted",
        why: "date of birth is 1867, not 1869",
        evidence: { source: "wikidata: Marie Curie (Q7186)", ref: "Q7186#P569", text: "date of birth: 1867-11-07" },
      },
      { text: "She won two Nobel Prizes.", standing: "supported" },
      { text: "Sponge-tool use was first documented in 1984.", standing: "unsupported" },
      { text: "The Marine Mammal Protection Act passed in 1972.", standing: "unsupported" },
      { text: "Dolphins are graceful.", standing: "argument" },
    ],
    symbols: [{ kind: "key", name: "backoffMs", standing: "contradicted", why: "withRetry takes { attempts, delayMs }" }],
  }

  test("the note carries the door's own findings: what a source says, the name that differs, the figures resting on nothing", async () => {
    const { groundSteer, GROUND_STEER_HEAD } = await import("../src/plugin/fold-ground")
    const note = groundSteer(profile)!
    expect(note.startsWith(GROUND_STEER_HEAD)).toBe(true)
    expect(note).toContain('"Marie Curie was born in 1869." — date of birth is 1867, not 1869; wikidata: Marie Curie (Q7186) says: "date of birth: 1867-11-07" (Q7186#P569)')
    expect(note).toContain("`backoffMs` — withRetry takes { attempts, delayMs }")
    expect(note).toContain('"Sponge-tool use was first documented in 1984."')
    expect(note).not.toContain("Dolphins are graceful")
    expect(note).not.toContain("She won two Nobel Prizes")
  })
  test("nothing worth a second look is not handed back: supported claims, argument, a single bare figure", async () => {
    const { groundSteer } = await import("../src/plugin/fold-ground")
    expect(groundSteer({ ...profile, claims: profile.claims.filter((c) => c.standing === "supported" || c.standing === "argument"), symbols: [] })).toBeUndefined()
    expect(groundSteer({ ...profile, claims: [profile.claims[2]], symbols: [] })).toBeUndefined()
    expect(groundSteer(undefined)).toBeUndefined()
  })
  test("a contradiction alone is enough, and two bare figures are enough", async () => {
    const { groundSteer } = await import("../src/plugin/fold-ground")
    expect(groundSteer({ ...profile, claims: [profile.claims[0]], symbols: [] })).toContain("Contradicted by a source:")
    expect(groundSteer({ ...profile, claims: [profile.claims[2], profile.claims[3]], symbols: [] })).toContain("Resting on nothing read this turn:")
  })
  test("what the model is told is facts and instructions to read, never a prohibition (a small mouth's safety gate trips on those)", async () => {
    const { GROUND_LEGEND, groundSteer } = await import("../src/plugin/fold-ground")
    for (const text of [GROUND_LEGEND, groundSteer(profile)!]) expect(text).not.toMatch(/\b(do not|don't|never|must not|cannot|forbidden)\b/i)
  })
})
