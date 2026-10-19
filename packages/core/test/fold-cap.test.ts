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

test("the cap counts event.system injections too, not only messages", () => {
  withCap("1200", () => {
    const messages = [
      msg("user", "[fold: 3 earlier asks folded]"),
      ...Array.from({ length: 8 }, (_, i) => [
        msg("user", `q${i} ${"z".repeat(400)}`),
        msg("assistant", `a${i} ${"z".repeat(400)}`),
      ]).flat(),
      msg("user", "what is the deployment window?"),
    ]
    // a large injected block rides in event.system, not in messages
    const system = [{ text: "y".repeat(900) }]
    capContext(messages, system)
    const injected = system.reduce((n, p) => n + (p.text?.length ?? 0), 0)
    expect(contextChars(messages) + injected).toBeLessThanOrEqual(1200)
    // the injections themselves are never dropped
    expect(system[0].text.length).toBe(900)
  })
})

// SAFETY: a call and its result, the pairing capContext must keep — `id` links them, `input` is what is clipped.
const call = (id: string, path: string) =>
  ({ role: "assistant", content: [{ type: "tool-call", id, name: "read", input: { path } }] }) as unknown as Parameters<typeof capContext>[0][number]
const result = (id: string, value: string) =>
  ({ role: "tool", content: [{ type: "tool-result", id, name: "read", result: { type: "text", value } }] }) as unknown as Parameters<typeof capContext>[0][number]

test("one large read cannot evict the steps around it, and no result is orphaned from its call", () => {
  // The dolphin session: a 24k file read in a 32k cap dropped every step but the ask, the note and one
  // orphaned result, and the agent re-read the same file for 70 steps.
  withCap("32000", () => {
    const messages = [
      msg("user", "build me a website [fold: steps 1-2 stored]"),
      call("a", "README.md"),
      result("a", "r".repeat(3000)),
      call("b", "dolphinit.html"),
      result("b", "d".repeat(24_000)),
      call("c", "README.md"),
      result("c", "r".repeat(3000)),
      call("d", "dolphinit.html"),
      result("d", "d".repeat(24_000)),
    ]
    capContext(messages)
    expect(contextChars(messages)).toBeLessThanOrEqual(32_000)
    const calls = new Set(messages.flatMap((m) => m.content.flatMap((p) => (p.type === "tool-call" ? [p.id] : []))))
    const results = messages.flatMap((m) => m.content.flatMap((p) => (p.type === "tool-result" ? [p.id] : [])))
    expect(results.every((id) => calls.has(id))).toBe(true) // no orphan
    expect([...calls]).toEqual(["a", "b", "c", "d"]) // every step keeps its shape
    const value = (id: string) =>
      messages.flatMap((m) => m.content.flatMap((p) => (p.type === "tool-result" && p.id === id ? [(p.result as { value: string }).value] : [])))[0]
    expect(value("b")).toContain("[fold:") // the older read is cut, and the cut is stated, never silent
    expect(value("d")).toBe("d".repeat(24_000)) // the newest read stays whole
  })
})
