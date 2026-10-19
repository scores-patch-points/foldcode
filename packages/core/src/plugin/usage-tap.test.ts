// Recorded provider responses (fixtures/, copied from foldcode/packages/ai/test/fixtures/recordings) run
// through the tap. The expected numbers are read by hand off each recording's usage block.
import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { verify } from "./fold-tokens"
import { parse, tap } from "./usage-tap"

type Fixture = { responses: Array<{ url: string; status: number; headers: Record<string, string>; body: string }> }
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(import.meta.dir, "usage-fixtures", `${name}.json`), "utf8")) as Fixture

test("anthropic: cache write, then cache read on the identical call", () => {
  const [first, second] = fixture("anthropic-cache").responses.map((r) => parse(r.body))
  expect(first).toMatchObject({ protocol: "anthropic-messages", complete: true, usage: { prompt: 5761, cacheRead: 0, cacheWrite: 5752, output: 5 } })
  expect(second).toMatchObject({ protocol: "anthropic-messages", complete: true, usage: { prompt: 5761, cacheRead: 5752, cacheWrite: 0, output: 5 } })
})

test("openai responses: usage from response.completed, total checks", () => {
  const [first, second] = fixture("openai-responses").responses.map((r) => parse(r.body))
  expect(first).toMatchObject({ protocol: "openai-responses", complete: true, usage: { prompt: 74, output: 18, total: 92 } })
  expect(second.complete).toBe(true)
  expect(second.usage!.prompt + second.usage!.output).toBe(second.usage!.total!)
})

test("gemini: output counts thoughts, total checks", () => {
  const [r] = fixture("gemini").responses.map((r) => parse(r.body))
  expect(r).toMatchObject({ protocol: "gemini", complete: true, usage: { prompt: 291, output: 111, reasoning: 106, total: 402 } })
})

test("openai chat (openrouter): final usage chunk before [DONE]", () => {
  const [r] = fixture("openrouter-chat").responses.map((r) => parse(r.body))
  expect(r).toMatchObject({ protocol: "openai-chat", complete: true, usage: { prompt: 61, output: 80, reasoning: 73, total: 141 } })
})

test("a stream cut before its terminal event is incomplete, never silently zero", () => {
  const body = fixture("anthropic-cache").responses[0].body
  const cut = parse(body.slice(0, body.indexOf("message_delta")))
  expect(cut.complete).toBe(false)
  expect(cut.usage).toMatchObject({ prompt: 5761, output: 2 }) // message_start carries a provisional output count
})

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usage-tap-")), "usage.jsonl")
const replay = async (file: string, sid: string, r: Fixture["responses"][number]) =>
  tap(file, {
    sessionID: sid,
    kind: "primary",
    request: new Request(r.url, { method: "POST", body: "{}" }),
    response: new Response(r.body, { status: r.status, headers: r.headers }),
  })

test("tap → log → verify: every recording, chain intact, sums per session", async () => {
  const file = tmp()
  for (const name of ["anthropic-cache", "openai-responses", "gemini", "openrouter-chat"])
    for (const r of fixture(name).responses) await replay(file, name, r)
  const { problems, lines, sessions } = verify(fs.readFileSync(file, "utf8"))
  expect(problems).toEqual([])
  expect(lines.length).toBe(6)
  expect(sessions.get("anthropic-cache")).toMatchObject({ requests: 2, prompt: 11522, cacheRead: 5752, cacheWrite: 5752, output: 10 })
})

test("verify catches an edited line and a deleted line", async () => {
  const file = tmp()
  for (const r of fixture("anthropic-cache").responses) await replay(file, "s", r)
  const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n")
  expect(verify(lines[0].replace('"output":5', '"output":1') + "\n" + lines[1]).problems.some((p) => p.includes("edited"))).toBe(true)
  expect(verify(lines[1]).problems.some((p) => p.includes("chain broken"))).toBe(true)
})

test("two writers sharing one log keep one chain (a plugin instance per workspace, no shared state)", async () => {
  const file = tmp()
  const [a, b] = fixture("anthropic-cache").responses
  // the other instance appends between this instance's writes, straight to the file, as a second module would
  await replay(file, "one", a)
  const { append } = await import("./usage-tap")
  append(file, { sid: "two", seq: 1, kind: "primary", status: 200, complete: true, usage: null })
  await replay(file, "one", b)
  append(file, { sid: "two", seq: 2, kind: "primary", status: 200, complete: true, usage: null })
  expect(verify(fs.readFileSync(file, "utf8")).problems).toEqual([])
  expect(fs.readFileSync(file, "utf8").trim().split("\n").length).toBe(4)
})
