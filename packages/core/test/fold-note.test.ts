import { expect, test } from "bun:test"
import { surfLocal } from "../src/plugin/fold.js"

const turn = (n: number, ask: string, answer: string) => ({ n, ask, answer, grounds: ["edit"] })

test("the fold's note carries the thread (clippy's present): about + settled, last-wins per ask", () => {
  const turns = [
    turn(1, "set the deployment window", "we will deploy at 03:00 UTC"),
    turn(2, "do an unrelated chore", "did the chore"),
    turn(3, "set the deployment window", "changed it to 04:00 UTC"),
  ]
  const note = surfLocal(turns, "what is the deployment window now?")

  // The fold is the THREAD, not a transcript tail.
  expect(note).toContain("the thread")
  // DISCOURSE (clippy): the beings the current ask SHARES with the folded turns — computed, never drawn.
  expect(note).toContain("about:")
  expect(note).toContain("deployment")
  // DMD: what is done, marked.
  expect(note).toContain("settled:")
  // last-wins: the repeated ask folds to one line, and carries the LATEST outcome, never the stale one.
  expect((note.match(/set the deployment window/g) ?? []).length).toBe(1)
  expect(note).toContain("04:00")
  expect(note).not.toContain("03:00")
})

test("the fold composes a chain (BOX computes): the derivation survives a minimal window", () => {
  const turns = [
    { n: 1, ask: "Define the base B.", answer: "B = 7." },
    { n: 2, ask: "Define the shard count S.", answer: "S = B * 3." },
    { n: 3, ask: "Define the fanout F.", answer: "F = S - 5." },
    { n: 4, ask: "Define the quota Q.", answer: "Q = F - 6." },
  ]
  const note = surfLocal(turns, "what is the quota Q?")
  expect(note).toContain("derived") // the machine composed the chain
  expect(note).toContain("Q=10") // 7*3=21, 21-5=16, 16-6=10 — the RESULT, not the links
})

test("the fold's note is deterministic (pure — no model, no clock)", () => {
  const turns = [turn(1, "a question about the parser", "the parser lives in lib/p.js")]
  expect(surfLocal(turns, "where is the parser?")).toBe(surfLocal(turns, "where is the parser?"))
})
