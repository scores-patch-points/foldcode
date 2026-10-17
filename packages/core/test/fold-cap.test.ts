import { expect, test } from "bun:test"
import { capContext, contextChars } from "../src/plugin/fold.js"

// SAFETY: capContext reads only each message's `role` and each part's `type`/`text`; this minimal shape
// exercises the ceiling exactly, and no field the function does not read is fabricated.
const msg = (role: "user" | "assistant", text: string) =>
  ({ role, content: [{ type: "text", text }] }) as unknown as Parameters<typeof capContext>[0][number]

test("the hard cap holds: the assembly never exceeds FOLD_MAX_CHARS", () => {
  const prev = process.env.FOLD_MAX_CHARS
  process.env.FOLD_MAX_CHARS = "1200"
  try {
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
    expect(before).toBeGreaterThan(1200) // premise: it started over the ceiling
    expect(contextChars(messages)).toBeLessThanOrEqual(1200) // the cap holds
    expect(messages[0].content.some((p) => p.type === "text" && p.text.includes("[fold:"))).toBe(true) // head kept
    expect(
      messages.at(-1)?.content.some((p) => p.type === "text" && p.text.includes("deployment window")),
    ).toBe(true) // the current ask is kept
  } finally {
    if (prev === undefined) delete process.env.FOLD_MAX_CHARS
    else process.env.FOLD_MAX_CHARS = prev
  }
})
