import { describe, expect, test } from "bun:test"
import { buildTree, STAGES, TRIADS, type Snapshot } from "./mind-tree-model"

const target = (where: string, extra: Partial<Snapshot["targets"][number]> = {}): Snapshot["targets"][number] => ({
  where,
  range: "",
  name: "",
  aim: "",
  lap: 0,
  reached: 2,
  settled: false,
  inFlight: false,
  laps: [{ lap: 0, reached: 2, steps: [{ name: "read", kind: "tool", stage: "INS", status: "completed", reframed: false }] }],
  ...extra,
})

const snap = (targets: Snapshot["targets"]): Snapshot => ({ at: 0, murmur: "thinking now", targets })

describe("buildTree", () => {
  test("the nine operators split into three triads: see, shape, hold", () => {
    expect(TRIADS.map((triad) => triad.label)).toEqual(["see", "shape", "hold"])
    expect(TRIADS.flatMap((triad) => triad.stages).map((stage) => stage.id)).toEqual(STAGES.map((stage) => stage.id))
  })

  test("a target's label is the thing, named in words, with the full path kept for hover", () => {
    const tree = buildTree(snap([target("src/b.ts", { name: "Session Mind Stage" })]))
    expect(tree[0]!.label).toBe("Session Mind Stage")
    expect(tree[0]!.where).toBe("src/b.ts")
  })

  test("the model's running commentary is the aim, never the row's name", () => {
    const tree = buildTree(snap([target("bun test src", { name: "Test Run", aim: "the amount must match the invoice" })]))
    expect(tree[0]!.label).toBe("Test Run")
    expect(tree[0]!.aim).toBe("the amount must match the invoice")
  })

  test("a row carries one operator: where the walk is now, or where it ended", () => {
    const tree = buildTree(
      snap([
        target("src/a.ts", {
          inFlight: true,
          laps: [
            {
              lap: 0,
              reached: 2,
              steps: [
                { name: "grep", kind: "tool", stage: "SIG", status: "completed", reframed: false },
                { name: "read", kind: "tool", stage: "INS", status: "running", reframed: false },
              ],
            },
          ],
        }),
      ]),
    )
    expect(tree[0]!.at).toBe("INS")
  })

  test("a target that began after another settled hangs under it", () => {
    const tree = buildTree(snap([target("bun test a", { settled: true }), target("src/b.ts", { after: "bun test a" })]))
    expect(tree.length).toBe(1)
    expect(tree[0]!.state).toBe("settled")
    expect(tree[0]!.children.map((child) => child.where)).toEqual(["src/b.ts"])
  })

  test("a single pass is one lap and carries nothing; a reframe adds a pass that carries the miss", () => {
    const single = buildTree(snap([target("src/a.ts")]))
    expect(single[0]!.laps.length).toBe(1)
    expect(single[0]!.laps[0]!.carried).toBeUndefined()

    const spiral = buildTree(
      snap([
        target("src/a.ts", {
          lap: 1,
          laps: [
            { lap: 0, reached: 5, steps: [{ name: "edit", kind: "tool", stage: "SYN", status: "error", reframed: false, error: "boom" }] },
            { lap: 1, reached: 2, carried: "boom", steps: [{ name: "read", kind: "tool", stage: "INS", status: "completed", reframed: true }] },
          ],
        }),
      ]),
    )
    const laps = spiral[0]!.laps
    expect(laps.length).toBe(2)
    expect(laps[0]!.failed).toBe(true)
    expect(laps[1]!.n).toBe(1)
    expect(laps[1]!.carried).toBe("boom")
  })

  test("only paths are openable", () => {
    const tree = buildTree(snap([target("src/a.ts"), target("bun test src")]))
    expect(tree.map((node) => node.openable)).toEqual([true, false])
  })
})
