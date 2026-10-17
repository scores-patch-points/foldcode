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

  test("nothing yet is read", () => {
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

describe("REC closes a settled target", () => {
  const run = (name: string, status: string, input: object) => ({ type: "tool", name, state: { status, input } })

  test("a passing check settles the target; a failure after it unsettles", async () => {
    const { targetsOf, settledBy } = await import("./session-mind-stage")
    const ok = targetsOf([run("bash", "completed", { command: "bun test a" })] as any)[0]!
    expect(settledBy(ok)).toBeDefined()
    const broken = targetsOf([run("bash", "completed", { command: "bun test a" }), run("bash", "error", { command: "bun test a" })] as any)[0]!
    expect(settledBy(broken)).toBeUndefined()
  })

  test("the next target remembers the one that settled before it", async () => {
    const { targetsOf } = await import("./session-mind-stage")
    const targets = targetsOf([
      run("edit", "completed", { filePath: "a.ts" }),
      run("bash", "completed", { command: "bun test a" }),
      run("edit", "completed", { filePath: "b.ts" }),
    ] as any)
    expect(targets.at(-1)!.where).toBe("b.ts")
    expect(targets.at(-1)!.after).toBe("bun test a")
  })
})

describe("conceptOf", () => {
  const tool = (name: string, input: object, status = "completed") => ({ type: "tool", name, state: { status, input } })

  test("the todo in progress wins", async () => {
    const { targetsOf, conceptOf } = await import("./session-mind-stage")
    const parts = [
      tool("todowrite", { todos: [{ content: "Wire the work tree panel", status: "in_progress" }, { content: "Docs", status: "pending" }] }),
      tool("read", { filePath: "src/a.ts" }),
    ] as any
    expect(conceptOf(targetsOf(parts).at(-1), parts)).toBe("Wire the work tree panel")
  })

  test("falls back to the step's description, then to the target read plainly", async () => {
    const { targetsOf, conceptOf } = await import("./session-mind-stage")
    const withDesc = [tool("bash", { command: "bun test", description: "Run the mind tests" })] as any
    expect(conceptOf(targetsOf(withDesc)[0], withDesc)).toBe("Run the mind tests")
    const plain = [tool("read", { filePath: "packages/app/src/session/timeline/session-mind-stage.ts" })] as any
    expect(conceptOf(targetsOf(plain)[0], plain)).toBe("session mind stage (timeline)")
    const grep = [tool("grep", { pattern: "useExtensionHost" })] as any
    expect(conceptOf(targetsOf(grep)[0], grep)).toBe("searching for useExtensionHost")
  })
})

describe("murmurOf", () => {
  const T = 100_000
  test("is built from the trace, never invented", async () => {
    const { murmurOf } = await import("./session-mind-stage")
    expect(murmurOf([], T)).toBe("waiting for the first move")
    expect(murmurOf([{ type: "reasoning", text: "check the tests first" }] as any, T)).toBe("check the tests first · 4 words so far")
    expect(
      murmurOf([{ type: "tool", name: "bash", time: { created: T - 7000 }, state: { status: "running", input: { command: "bun test" } } }] as any, T),
    ).toBe("bash running on bun test · 7s")
    expect(
      murmurOf([{ type: "tool", name: "read", time: { created: T - 9000, completed: T - 3000 }, state: { status: "completed", input: {} } }] as any, T),
    ).toBe("deciding what is next · 3s since read finished")
  })
})

describe("snapshotOf", () => {
  test("names each target as a thing and keeps the model's commentary as the aim", async () => {
    const { targetsOf, snapshotOf } = await import("./session-mind-stage")
    const parts = [
      { type: "tool", name: "read", state: { status: "completed", input: { filePath: "src/a.ts" } } },
      { type: "reasoning", text: "the amount must match the invoice" },
    ] as any
    const snapshot = snapshotOf(targetsOf(parts), parts, 100_000)
    expect(snapshot.murmur).toBe("the amount must match the invoice · 6 words so far")
    expect(snapshot.targets[0]!.name).toBe("A")
    expect(snapshot.targets[0]!.aim).toBe("the amount must match the invoice")
  })
})

describe("prettyNameOf", () => {
  const name = async (where: string, tool = "read") => {
    const { prettyNameOf } = await import("./session-mind-stage")
    return prettyNameOf({ where, steps: [{ part: { type: "tool", name: tool } }] })
  }
  test("names what a thing is, not where it lives", async () => {
    expect(await name("packages/app/src/session/timeline/session-mind-stage.ts")).toBe("Session Mind Stage")
    expect(await name("src/session/timeline/session-mind.test.ts")).toBe("Session Mind Tests")
    expect(await name("src/runtime/index.ts")).toBe("Runtime Index")
    expect(await name("cd /tmp/x && bun test src", "bash")).toBe("Test Run")
    expect(await name("bunx tsc --noEmit -p .", "bash")).toBe("Type Check")
    expect(await name("git push origin fold", "bash")).toBe("Git Push")
    expect(await name("useExtensionHost", "grep")).toBe("Search: useExtensionHost")
  })
})

describe("frameChange", () => {
  const tool = (name: string, where: string) => ({ type: "tool", name, state: { status: "error", input: { filePath: where } } })
  test("the same tool on the same target is a re-draw; anything else changed the frame", async () => {
    const { frameChange } = await import("./session-mind-stage")
    expect(frameChange(tool("edit", "a.ts") as any, tool("edit", "a.ts") as any).changed).toBe(false)
    expect(frameChange(tool("edit", "a.ts") as any, tool("read", "a.ts") as any).changed).toBe(true)
    expect(frameChange(tool("edit", "a.ts") as any, tool("edit", "b.ts") as any).changed).toBe(true)
  })
})
