import { describe, expect, test } from "bun:test"
import { repeatedStep } from "@opencode/core/session/runner/repeated-step"

const shell = (command: string) => ({
  type: "assistant",
  content: [{ type: "tool", name: "shell", state: { status: "completed", input: { command } } }],
})
const read = (filePath: string) => ({
  type: "assistant",
  content: [{ type: "tool", name: "read", state: { status: "completed", input: { filePath } } }],
})
const said = (text: string) => ({ type: "assistant", content: [{ type: "text", text }] })
const input = (type: string) => ({ type })

describe("repeatedStep", () => {
  test("detects the same shell command re-run with different output plumbing", () => {
    expect(
      repeatedStep([
        shell("cd openfold && node openfold.test.js 2>&1 | grep -E '^#'"),
        shell("cd openfold && node openfold.test.js > /tmp/of.txt 2>&1; echo EXIT; grep -c 'not ok' /tmp/of.txt"),
        shell("cd openfold && node openfold.test.js | tail -70"),
      ]),
    ).toBe(true)
  })

  test("does not trip below the limit", () => {
    expect(repeatedStep([shell("ls"), shell("ls")])).toBe(false)
  })

  test("an intervening different tool breaks the run", () => {
    expect(repeatedStep([shell("node t.js"), read("a.js"), shell("node t.js"), shell("node t.js")])).toBe(false)
  })

  test("genuinely different commands are not a loop", () => {
    expect(repeatedStep([shell("ls a"), shell("ls b"), shell("ls c")])).toBe(false)
    expect(repeatedStep([shell("cd x && node a.js"), shell("cd x && node b.js"), shell("cd x && node c.js")])).toBe(
      false,
    )
  })

  test("the same file read over and over is a loop", () => {
    expect(repeatedStep([read("a.js"), read("a.js"), read("a.js")])).toBe(true)
  })

  test("a fresh user or synthetic input clears the count", () => {
    expect(repeatedStep([shell("ls"), input("user"), shell("ls"), shell("ls")])).toBe(false)
    expect(repeatedStep([shell("ls"), input("synthetic"), shell("ls"), shell("ls")])).toBe(false)
  })

  test("a text-only step does not count as a tool step", () => {
    expect(repeatedStep([shell("ls"), said("thinking"), shell("ls"), shell("ls"), shell("ls")])).toBe(true)
  })
})
