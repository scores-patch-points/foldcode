import { expect, test } from "bun:test"
import { trailGist } from "../src/plugin/fold"

test("gist names headings, counts lines, and is deterministic", () => {
  const text = "1: # The plan\n2: \n3: ## 0. Goal\n4: body\n5: ## 1. Method\n"
  const gist = trailGist(text, "read:/x/PLAN.md")
  expect(gist).toContain("of read:/x/PLAN.md")
  expect(gist).toContain("headings: # The plan | ## 0. Goal | ## 1. Method")
  expect(gist).toBe(trailGist(text, "read:/x/PLAN.md"))
})

test("gist falls back to symbols for code", () => {
  const gist = trailGist("export const a = 1\nfunction b() {}\nclass C {}\n")
  expect(gist).toContain("symbols: a | b | C")
})

import { trailApply } from "../src/plugin/fold"

// SAFETY: trailApply reads only role, content[].type/id/name/result — the same minimal shape the other fold tests use.
const call = (id: string, name: string) => ({ role: "assistant", content: [{ type: "tool-call", id, name, input: {} }] }) as never
const result = (id: string, name: string, value: string) =>
  ({ role: "tool", content: [{ type: "tool-result", id, name, result: { type: "text", value } }] }) as never
const textOf = (m: any) => m.content[0].result.value as string
const big = (n: number) => `# Title\n## Sec A\n${"x".repeat(n)}\n`
const held = (newestId: string) => (t: { id: string; name?: string }) => t.name === "snip" || t.id === newestId

test("FALSIFIER: the loop shape — read, stub, snip, snip — the model always gets the bytes on the newest result", () => {
  const body = big(2000)
  const store = new Map<string, string>()
  const done = new Map<string, string>()
  const keyOf = new Map([["r1", "read:/x/PLAN.md"]])
  // request 2: old read is stale, door points at it; the newest result is the snip answer
  const msgs = [call("r1", "read"), result("r1", "read", body), call("s1", "snip"), result("s1", "snip", `[snip rcA · from: tool result · standing: mechanical]\n${body}`)]
  trailApply(msgs, new Map([["r1", "rcA"], ["s1", "rcB"]]), done, store, keyOf, held("s1"))
  expect(textOf(msgs[1])).toContain("kept out; SNIP rcA")
  expect(textOf(msgs[1])).toContain("headings: # Title | ## Sec A") // the stale read left a gist, not a bare stub
  expect(textOf(msgs[3])).toContain(body) // the snip answer is NOT stubbed: bytes reach the model
  expect(done.has("s1")).toBe(false) // and no handle-for-a-handle was minted
  expect(store.get("rcA")).toBe(body)
})

test("FALSIFIER: the newest non-snip result is never stubbed on first sight, and a stub is never stubbed twice", () => {
  const store = new Map<string, string>()
  const done = new Map<string, string>()
  const msgs = [call("r1", "read"), result("r1", "read", big(3000))]
  trailApply(msgs, new Map([["r1", "rcA"]]), done, store, new Map(), held("r1"))
  expect(textOf(msgs[1])).toContain("xxxx") // newest: untouched
  // next request: it is no longer newest; door points; it stubs once
  trailApply(msgs, new Map([["r1", "rcA"]]), done, store, new Map(), held("zz"))
  const once = textOf(msgs[1])
  expect(once).toContain("kept out; SNIP rcA")
  trailApply(msgs, new Map([["r1", "rcZ"]]), done, store, new Map(), held("zz"))
  expect(textOf(msgs[1])).toBe(once) // idempotent: no nested stub
  expect(store.size).toBe(1)
})

test("FALSIFIER: the gist never leaks more than a bounded, mechanical summary", () => {
  const huge = Array.from({ length: 5000 }, (_, i) => `## Heading ${i} ${"y".repeat(200)}`).join("\n")
  expect(trailGist(huge, "k").length).toBeLessThan(900)
  expect(trailGist("", "k")).toContain("1 lines")
})

import { localSpan } from "../src/plugin/fold"
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

test("localSpan resolves a file span without the door, and refuses what is not a span", () => {
  const dir = mkdtempSync(join(tmpdir(), "span-"))
  writeFileSync(join(dir, "a.md"), "one\ntwo\nthree\nfour\n")
  expect(localSpan("a.md#L2-L3", dir)?.bytes).toBe("2: two\n3: three")
  expect(localSpan("a.md#L1-4", dir)?.bytes).toBe("1: one\n2: two\n3: three\n4: four")
  expect(localSpan("a.md#4-7", dir)?.bytes).toBe("two") // byte span
  expect(localSpan("a.md#L3", dir)?.bytes).toBe("3: three")
  expect(localSpan("missing.md#L1-2", dir)).toBeUndefined()
  expect(localSpan("turn 7", dir)).toBeUndefined()
  expect(localSpan("rs21xfd3a", dir)).toBeUndefined()
})
