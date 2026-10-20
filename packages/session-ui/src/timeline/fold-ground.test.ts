import { describe, expect, test } from "bun:test"
import { readGround, rowAt } from "./fold-ground"

const meta = (ground: unknown) => ({ notice: "fold-ground", ground })
const step = {
  superseded: null,
  grounded: [
    {
      text: "Curie discovered radium.",
      standing: "grounded",
      ref: "mat.txt#9",
      sources: [{ passage: "mat.txt", text: "Marie Curie discovered radium in 1898." }, { passage: "bad" }],
    },
    { text: "The element glows.", standing: "self:model", source: "the mouth" },
    { text: "Odd one.", standing: "grounded", beings: ["radium"] },
  ],
}

describe("fold ground view", () => {
  test("other notices carry none", () => {
    expect(readGround(undefined)).toBeUndefined()
    expect(readGround({ notice: "restart" })).toBeUndefined()
  })
  test("words untouched: the door's text, in order", () => {
    expect(readGround(meta({ step }))!.rows.map((row) => row.text)).toEqual(step.grounded.map((row) => row.text))
  })
  test("every sentence is tagged: S <ref>, [M], S·identity <being>", () => {
    expect(readGround(meta({ step }))!.rows.map((row) => row.tag)).toEqual(["S mat.txt#9", "M", "S·identity radium"])
  })
  test("a source is the passage's own sentence; a malformed one is dropped", () => {
    const rows = readGround(meta({ step }))!.rows
    expect(rows[0].sources).toEqual([{ passage: "mat.txt", text: "Marie Curie discovered radium in 1898." }])
    expect(rows[1].sources).toEqual([])
  })
  test("a settled turn keeps the loser", () => {
    expect(readGround(meta({ step: { ...step, superseded: "the draw" } }))!.superseded).toBe("the draw")
  })
  test("no step is a typed gap, never an invented one", () => {
    const view = readGround(meta({ step: null, gap: "no step this turn" }))!
    expect(view.rows).toEqual([])
    expect(view.gap).toBe("no step this turn")
  })
  test("hovering the answer's text finds the sentence under the pointer", () => {
    const rows = readGround(meta({ step }))!.rows
    const text = "Curie discovered radium. The element glows. Odd one."
    expect(rowAt(rows, text, 3)?.tag).toBe("S mat.txt#9")
    expect(rowAt(rows, text, 30)?.tag).toBe("M")
    expect(rowAt(rows, text, 49)?.tag).toBe("S·identity radium")
    expect(rowAt(rows, text, 24)).toBeUndefined()
  })
})

describe("fold ground profile", () => {
  const profile = {
    kind: "essay",
    words: 40,
    counts: { supported: 2, contradicted: 1, unsupported: 1 },
    claims: [
      { text: "She was born in 1869.", standing: "contradicted", why: "date of birth is 1867, not 1869", evidence: { text: "date of birth: 1867-11-07", ref: "Q7186#P569", url: "https://www.wikidata.org/wiki/Q7186" }, searched: ["material", "wikidata: Marie Curie (Q7186)"] },
      { text: "The council approved a compromise.", standing: "supported", derived: true, from: [{ source: "minutes.md", ref: "minutes.md:1:66", text: "The council voted 7 to 4 to approve the compromise." }], evidence: { source: "minutes.md", ref: "minutes.md:1:66", text: "x" } },
      { text: "Marie Curie won two prizes.", standing: "supported", janus: { statement: "2 == 2", finding: "the declared oracle confirms it (mathjs)" }, residue: ["prizes"] },
      { text: "A federal grant paid.", standing: "unsupported", added: true },
      { text: "Argument is not an item.", standing: "argument" },
    ],
    symbols: [{ kind: "key", name: "backoffMs", of: "withRetry", standing: "contradicted", why: "withRetry takes { attempts, delayMs }" }],
    summary: { leftOut: { beings: [{ name: "the mayor", mentions: 2 }], figures: [{ figure: "7 to 4", text: "The council voted 7 to 4.", ref: "minutes.md:1:200" }] } },
  }
  const view = () => readGround(meta({ step: { grounded: [], profile } }))!.profile!

  test("the panel reads the door's profile once, at the boundary", () => {
    expect(view().kind).toBe("essay")
    expect(view().bar.map((part) => part.label)).toEqual(["checks out", "contradicted or not found", "unsupported"])
  })
  test("items that need a look are the contradicted, unsupported and not-found ones, with the door's own reasons", () => {
    expect(view().look.map((item) => [item.label, item.tone])).toEqual([
      ["Contradicted", "danger"],
      ["Added", "warning"],
      ["Contradicted", "danger"],
    ])
    expect(view().look[0].why).toBe("date of birth is 1867, not 1869")
    expect(view().look[0].evidence?.ref).toBe("Q7186#P569")
  })
  test("a derived sentence carries the several source sentences it abstracts; Janus's finding and the residue ride along", () => {
    const fine = view().fine
    expect(fine.map((item) => item.label)).toEqual(["Derived", "Supported"])
    expect(fine[0].from[0].ref).toBe("minutes.md:1:66")
    expect(fine[1].janus).toBe("the declared oracle confirms it (mathjs)")
    expect(fine[1].residue).toEqual(["prizes"])
  })
  test("argument is never an item; a summary's left-out beings and figures are carried as given", () => {
    expect(view().look.concat(view().fine).some((item) => item.title.startsWith("Argument"))).toBe(false)
    expect(view().leftOut?.beings).toEqual([{ name: "the mayor", mentions: 2 }])
    expect(view().leftOut?.figures[0].figure).toBe("7 to 4")
  })
  test("a payload with no profile reads as none", () => {
    expect(readGround(meta({ step }))!.profile).toBeUndefined()
  })
})
