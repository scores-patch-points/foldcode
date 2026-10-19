// layers-model.test.ts — the model the Layers panel renders from. Run: bun test layers-model.test.ts
import { test, expect } from "bun:test"
import { GRAINS, tagOf } from "./layers-model"

test("a sentence's tag names its standing — never silently grounded", () => {
  expect(tagOf({ text: "x", type: "grounded", ref: "evt_abc" })).toEqual({ label: "S evt_abc", kind: "grounded", ref: "evt_abc" })
  expect(tagOf({ text: "x", type: "asserted", ref: "evt_9" }).label).toBe("S evt_9·asserted")
  expect(tagOf({ text: "x", type: "self:model" })).toEqual({ label: "M", kind: "own", ref: undefined })
})

test("the grain switch offers the four lenses over one record", () => {
  expect([...GRAINS]).toEqual(["said", "sourced", "prompt", "record"])
})
