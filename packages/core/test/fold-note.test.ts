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
    turn(1, "Define the base B.", "B = 7."),
    turn(2, "Define the shard count S.", "S = B * 3."),
    turn(3, "Define the fanout F.", "F = S - 5."),
    turn(4, "Define the quota Q.", "Q = F - 6."),
  ]
  const note = surfLocal(turns, "what is the quota Q?")
  expect(note).toContain("derived") // the machine composed the chain
  expect(note).toContain("Q=10") // 7*3=21, 21-5=16, 16-6=10 — the RESULT, not the links
})

test("the mechanical fold compresses many DISTINCT asks into their threads (paraphrases), not a list", () => {
  const topics = ["parser", "deploy", "billing", "search"]
  const turns = Array.from({ length: 40 }, (_, i) =>
    turn(i + 1, `work on the ${topics[i % 4]} item ${i}`, `settled the ${topics[i % 4]} work for item ${i}`),
  )
  const note = surfLocal(turns, "what did we settle about the parser?")
  const threadLines = note.split("\n").filter((l) => l.startsWith("- ["))
  expect(threadLines.length).toBeLessThanOrEqual(6) // threads, not 40 asks
  expect(note.length).toBeLessThanOrEqual(2000) // the char budget holds
  expect(note).toContain("thread(s)") // the note names its threads
})

test("the fold's note is deterministic (pure — no model, no clock)", () => {
  const turns = [turn(1, "a question about the parser", "the parser lives in lib/p.js")]
  expect(surfLocal(turns, "where is the parser?")).toBe(surfLocal(turns, "where is the parser?"))
})
