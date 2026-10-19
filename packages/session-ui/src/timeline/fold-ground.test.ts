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
