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

describe("per-target walk", () => {
  const read = (path: string, extra: object = {}) => ({
    type: "tool",
    name: "read",
    state: { status: "completed", input: { filePath: path, ...extra } },
  })
  const edit = (path: string) => ({ type: "tool", name: "edit", state: { status: "completed", input: { filePath: path } } })

  test("steps group by what they act on; unnamed parts join the target before them", async () => {
    const { targetsOf, reachedOf, rangeOf } = await import("./session-mind-stage")
    const targets = targetsOf([read("a.ts", { offset: 10, limit: 5 }), { type: "reasoning" }, edit("a.ts"), read("b.ts")] as any)
    expect(targets.map((item) => item.where)).toEqual(["a.ts", "b.ts"])
    expect(targets[0]!.steps.length).toBe(3)
    expect(reachedOf(targets[0]!)).toBe(5) // composed: NUL SIG INS SEG CON SYN
    expect(reachedOf(targets[1]!)).toBe(2) // only named
    expect(rangeOf(read("a.ts", { offset: 10, limit: 5 }) as any)).toBe("lines 10–14")
  })
})

describe("parallel lanes", () => {
  test("a target is in flight while any of its steps is running", async () => {
    const { inFlightOf, targetsOf } = await import("./session-mind-stage")
    const run = (path: string, status: string) => ({ type: "tool", name: "read", state: { status, input: { filePath: path } } })
    const targets = targetsOf([run("a.ts", "running"), run("b.ts", "streaming"), run("c.ts", "completed")] as any)
    expect(inFlightOf(targets).map((item) => item.where)).toEqual(["a.ts", "b.ts"])
  })
})

describe("REC is the loop", () => {
  test("a step after a failure begins a new lap and the walk restarts", async () => {
    const { targetsOf, lapOf, reachedOf } = await import("./session-mind-stage")
    const step = (name: string, status: string, path = "a.ts") => ({ type: "tool", name, state: { status, input: { filePath: path } } })
    const target = targetsOf([step("read", "completed"), step("edit", "completed"), step("edit", "error"), step("read", "completed")] as any)[0]!
    expect(lapOf(target)).toBe(1)
    expect(target.steps.filter((item) => item.reframed).length).toBe(1)
    expect(reachedOf(target)).toBe(2) // lap 2 has only walked as far as Name
  })
})
