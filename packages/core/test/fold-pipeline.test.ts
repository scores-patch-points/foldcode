import { expect, test } from "bun:test"
import { capContext, contextChars, surfApply, surfLocal, surfPlan } from "../src/plugin/fold.js"

// SAFETY: the fold reads only each message's `role` and each text part's `text`; this minimal shape exercises
// plan/apply/cap exactly, and no field the functions do not read is fabricated.
const msg = (role: "user" | "assistant", text: string) =>
  ({ role, content: [{ type: "text", text }] }) as unknown as Parameters<typeof surfPlan>[0][number]

test("the fold pipeline works end to end: plan → cut → note → cap, and the last ask always survives", () => {
  const prev = process.env.FOLD_MAX_CHARS
  process.env.FOLD_MAX_CHARS = "4000"
  try {
    const ask = "what did we settle about the parser?"
    const turns = Array.from({ length: 30 }, (_, i) => [
      msg("user", `work on the ${["parser", "deploy", "billing"][i % 3]} item ${i} — ${"detail ".repeat(40)}`),
      msg("assistant", `Done with item ${i}; tests pass. ${"more ".repeat(40)}`),
    ])
    const messages = [...turns.flat(), msg("user", ask)]
    const before = contextChars(messages)

    const plan = surfPlan(messages)
    expect(plan).toBeTruthy() // 30 turns > keepTurns, so the window is cuttable
    if (!plan) return
    surfApply(messages, plan.cut, surfLocal(plan.turns, ask))
    capContext(messages)

    expect(contextChars(messages)).toBeLessThan(before) // the fold actually reduced the window
    expect(contextChars(messages)).toBeLessThanOrEqual(4000) // and the cap holds
    expect(messages[0].content.some((p) => p.type === "text" && p.text.includes("[fold:"))).toBe(true) // the note rides
    expect(messages.at(-1)?.content.some((p) => p.type === "text" && p.text.includes("settle"))).toBe(true) // ask survives
  } finally {
    if (prev === undefined) delete process.env.FOLD_MAX_CHARS
    else process.env.FOLD_MAX_CHARS = prev
  }
})
