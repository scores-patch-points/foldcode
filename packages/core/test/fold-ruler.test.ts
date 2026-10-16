import { describe, expect, test } from "bun:test"
import { measure } from "../src/plugin/fold-ruler"

const anthropic = (stale: string) =>
  JSON.stringify({
    model: "m",
    max_tokens: 100,
    system: [{ type: "text", text: "you are an agent" }],
    tools: [{ name: "read", description: "read a file", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "first ask" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: { filePath: "a.js" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: stale }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "second ask" }] },
    ],
  })

describe("fold-ruler", () => {
  test("anthropic: segments are named, results billed to their tool, overhead small", () => {
    const body = anthropic("x".repeat(5000))
    const r = measure(body)
    expect(r.total).toBe(body.length)
    expect(r.segments["result.read"].chars).toBeGreaterThan(5000)
    expect(r.segments["tools"].n).toBe(1)
    expect(r.segments["system"].n).toBe(1)
    expect(r.segments["user.text"].n).toBe(2)
    expect(r.segments["assistant.tool_call"].n).toBe(1)
    expect(r.overhead / r.total).toBeLessThan(0.05)
    // the read result sits before the last user text, so all of it is stale
    expect(r.staleResult).toBe(r.segments["result.read"].chars)
  })

  test("a result after the last ask is fresh, not stale", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: [{ type: "text", text: "ask" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "grep", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "y".repeat(100) }] },
      ],
    })
    const r = measure(body)
    expect(r.segments["result.grep"].chars).toBeGreaterThan(100)
    expect(r.staleResult).toBe(0)
  })

  test("openai chat and responses shapes", () => {
    const chat = measure(
      JSON.stringify({
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "ask" },
          { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "c1", content: "out".repeat(100) },
          { role: "user", content: "again" },
        ],
      }),
    )
    expect(chat.segments["result.bash"].chars).toBeGreaterThan(300)
    expect(chat.staleResult).toBe(chat.segments["result.bash"].chars)
    const resp = measure(
      JSON.stringify({
        instructions: "i",
        input: [
          { role: "user", content: [{ type: "input_text", text: "ask" }] },
          { type: "function_call", call_id: "c1", name: "read", arguments: "{}" },
          { type: "function_call_output", call_id: "c1", output: "z".repeat(50) },
        ],
      }),
    )
    expect(resp.segments["result.read"].n).toBe(1)
    expect(resp.segments["system"].n).toBe(1)
  })

  test("chat reasoning_content is thinking, a system-role message is system", () => {
    const r = measure(
      JSON.stringify({
        messages: [
          { role: "system", content: "s".repeat(2000) },
          { role: "user", content: "ask" },
          { role: "assistant", content: "ok", reasoning_content: "r".repeat(4000) },
        ],
      }),
    )
    expect(r.segments["assistant.thinking"].chars).toBeGreaterThan(4000)
    expect(r.segments["system"].chars).toBeGreaterThan(2000)
    expect(r.segments["user.text"].n).toBe(1)
    expect(r.overhead / r.total).toBeLessThan(0.15)
  })

  test("unparseable body is one honest segment, never a throw", () => {
    const r = measure("not json")
    expect(r.segments.unparsed.chars).toBe(8)
  })
})
