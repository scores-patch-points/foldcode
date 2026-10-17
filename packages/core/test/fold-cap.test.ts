import { expect, test } from "bun:test"
import { capContext, contextChars } from "../src/plugin/fold.js"

// SAFETY: capContext reads only each message's `role` and each part's `type`/`text`/`result`; this minimal shape
// exercises the ceiling exactly, and no field the function does not read is fabricated.
const msg = (role: "user" | "assistant", text: string) =>
  ({ role, content: [{ type: "text", text }] }) as unknown as Parameters<typeof capContext>[0][number]
// SAFETY: same — a tool-result part is exactly what messageChars measures (JSON of `result`).
const toolResult = (value: string) =>
  ({ role: "user", content: [{ type: "tool-result", result: { type: "text", value } }] }) as unknown as Parameters<
    typeof capContext
  >[0][number]

const withCap = <T>(cap: string, fn: () => T): T => {
  const prev = process.env.FOLD_MAX_CHARS
  process.env.FOLD_MAX_CHARS = cap
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.FOLD_MAX_CHARS
    else process.env.FOLD_MAX_CHARS = prev
  }
}

test("the hard cap holds: the assembly never exceeds FOLD_MAX_CHARS", () => {
  withCap("1200", () => {
    const messages = [
      msg("user", "[fold: 3 earlier asks folded]\n- ask: deploy\n  outcome: 03:00 UTC"),
      ...Array.from({ length: 8 }, (_, i) => [
        msg("user", `q${i} ${"z".repeat(400)}`),
        msg("assistant", `a${i} ${"z".repeat(400)}`),
      ]).flat(),
      msg("user", "what is the deployment window?"),
    ]
    const before = contextChars(messages)
    capContext(messages)
    expect(before).toBeGreaterThan(1200)
    expect(contextChars(messages)).toBeLessThanOrEqual(1200)
    expect(messages[0].content.some((p) => p.type === "text" && p.text.includes("[fold:"))).toBe(true)
    expect(
      messages.at(-1)?.content.some((p) => p.type === "text" && p.text.includes("deployment window")),
    ).toBe(true)
  })
})

test("the cap bounds TOOL OUTPUT too, not only the old-turn note", () => {
  withCap("1200", () => {
    const messages = [
      msg("user", "[fold: the thread]"),
      ...Array.from({ length: 6 }, (_, i) => [
        msg("assistant", `read file ${i}`),
        toolResult("x".repeat(5000)), // a large tool result — the vector the note did not cover
      ]).flat(),
      msg("user", "what did the last read say?"),
    ]
    expect(contextChars(messages)).toBeGreaterThan(1200)
    capContext(messages)
    expect(contextChars(messages)).toBeLessThanOrEqual(1200) // tool output cannot grow the window past the cap
  })
})
