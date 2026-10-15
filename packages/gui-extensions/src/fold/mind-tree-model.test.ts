import { describe, expect, test } from "bun:test"
import { buildTree, trackOf, type Snapshot } from "./mind-tree-model"

const target = (where: string, extra: Partial<Snapshot["targets"][number]> = {}): Snapshot["targets"][number] => ({
  where,
  range: "",
  lap: 0,
  reached: 2,
  settled: false,
  inFlight: false,
  laps: [{ lap: 0, reached: 2, steps: [{ name: "read", kind: "tool", stage: "INS", status: "completed", reframed: false }] }],
  ...extra,
})

describe("buildTree", () => {
  test("lights the track up to how far a target walked", () => {
    expect(trackOf(2)).toBe("∅○●······")
    expect(trackOf(-1)).toBe("·········")
  })

  test("a target that began after another settled hangs under it", () => {
    const tree = buildTree({ at: 0, targets: [target("bun test a", { settled: true }), target("src/b.ts", { after: "bun test a" })] })
    expect(tree.length).toBe(1)
    expect(tree[0]!.state).toBe("settled")
    expect(tree[0]!.children.filter((child) => child.kind === "target").map((child) => child.label)).toEqual(["src/b.ts"])
  })

  test("laps nest as a spiral and each carries what the last one hit", () => {
    const tree = buildTree({
      at: 0,
      targets: [
        target("src/a.ts", {
          lap: 1,
          laps: [
            { lap: 0, reached: 5, steps: [{ name: "edit", kind: "tool", stage: "SYN", status: "error", reframed: false, error: "boom" }] },
            { lap: 1, reached: 2, carried: "boom", steps: [{ name: "read", kind: "tool", stage: "INS", status: "completed", reframed: true }] },
          ],
        }),
      ],
    })
    const first = tree[0]!.children[0]!
    expect(first.kind).toBe("lap")
    expect(first.state).toBe("failed")
    const second = first.children[0]!
    expect(second.label).toBe("lap 2")
    expect(second.detail).toBe("carried: boom")
  })

  test("only paths are openable", () => {
    const tree = buildTree({ at: 0, targets: [target("src/a.ts"), target("bun test src")] })
    expect(tree.map((node) => node.openable)).toEqual([true, false])
  })
})
