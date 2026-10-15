import { describe, expect, test } from "bun:test"
import { stageOf } from "./session-mind-stage"

const tool = (name: string, command?: string, status = "completed") => ({
  type: "tool",
  name,
  state: { status, input: command ? { command } : {} },
})

describe("stageOf", () => {
  test("reads each part as one of the nine operators", () => {
    expect(stageOf({ type: "reasoning" })).toBe("NUL")
    expect(stageOf(tool("grep"))).toBe("SIG")
    expect(stageOf(tool("read"))).toBe("INS")
    expect(stageOf(tool("task"))).toBe("SEG")
    expect(stageOf(tool("lsp"))).toBe("CON")
    expect(stageOf(tool("edit"))).toBe("SYN")
    expect(stageOf({ type: "text" })).toBe("SYN")
    expect(stageOf(tool("todowrite"))).toBe("DEF")
  })

  test("a shell command is read by what it does", () => {
    expect(stageOf(tool("bash", "bun test src"))).toBe("EVA")
    expect(stageOf(tool("bash", "tsc --noEmit"))).toBe("EVA")
    expect(stageOf(tool("bash", "ls -la"))).toBe("SIG")
    expect(stageOf(tool("bash", "bun install"))).toBe("SYN")
  })

  test("the step after a failure is a reframe", () => {
    expect(stageOf(tool("read"), tool("bash", "x", "error"))).toBe("REC")
    expect(stageOf(tool("read"), tool("bash", "x", "completed"))).toBe("INS")
  })

  test("nothing yet is held", () => {
    expect(stageOf(undefined)).toBe("NUL")
  })
})
