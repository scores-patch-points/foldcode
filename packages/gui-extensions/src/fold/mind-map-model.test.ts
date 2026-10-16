import { describe, expect, test } from "bun:test"
import { buildMindMap, localize, nestOf, openAtLevel, orbitAt, orbitRadius, orbitSpeed, RELATION_WORD, type Concept } from "./mind-map-model"
import type { Snapshot } from "./mind-tree-model"
import type { RecordView } from "./plans-model"

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

describe("buildMindMap", () => {
  test("a concept is the thing, named in words, with the full path kept for the address", () => {
    const map = buildMindMap(snap([target("src/b.ts", { name: "Session Mind Stage" })]))
    expect(map.concepts[0]!.label).toBe("Session Mind Stage")
    expect(map.concepts[0]!.where).toBe("src/b.ts")
  })

  test("standing follows the firewall: a passing check is witnessed, anything else is asserted", () => {
    const settled = buildMindMap(snap([target("src/a.ts", { settled: true })]))
    const asserted = buildMindMap(snap([target("src/a.ts")]))
    expect(settled.concepts[0]!.standing).toBe("witnessed")
    expect(asserted.concepts[0]!.standing).toBe("asserted")
  })

  test("a target that began after another settled is tied to it: it grew from it", () => {
    const map = buildMindMap(snap([target("bun test a", { name: "Test Run", settled: true }), target("src/b.ts", { name: "Reader", after: "bun test a" })]))
    const tie = map.ties.find((edge) => edge.relation === "derived-from")
    expect(tie).toBeDefined()
    const labels = map.concepts.map((concept) => concept.label)
    expect(labels[tie!.a === map.concepts[0]!.id ? 0 : 1]).toBe("Reader")
  })

  test("a walk with more than one pass, or with concepts grown from it, holds more: a holon", () => {
    const passes = buildMindMap(
      snap([
        target("src/a.ts", {
          lap: 1,
          laps: [
            { lap: 0, reached: 5, steps: [{ name: "edit", kind: "tool", stage: "SYN", status: "error", reframed: false }] },
            { lap: 1, reached: 2, steps: [{ name: "read", kind: "tool", stage: "INS", status: "completed", reframed: true }] },
          ],
        }),
      ]),
    )
    expect(passes.concepts[0]!.passes).toBe(2)
    expect(passes.concepts[0]!.holon).toBe(true)

    const grown = buildMindMap(snap([target("bun test a", { name: "Test Run", settled: true }), target("src/b.ts", { name: "Reader", after: "bun test a" })]))
    expect(grown.concepts.find((concept) => concept.label === "Test Run")!.holon).toBe(true)
  })

  test("the door's kept record becomes concepts and redefinition ties, drawn only where both ends are held", () => {
    const record: RecordView = {
      record: [
        { id: "b1", referent: "the invoice total", delta: ["a"] },
        { id: "b2", referent: "the invoice total", delta: ["b"], check: "sum matches" },
      ],
      supersedes: [{ referent: "the invoice total", superseded: "b1", supersededBy: "b2" }],
      disagreements: [{ referent: "the invoice total", answers: ["two", "three"] }],
    }
    const map = buildMindMap(snap([]), record)
    const referent = map.concepts.find((concept) => concept.label === "the invoice total")
    expect(referent).toBeDefined()
    // A re-entry is the spiral turning: a pass and a self-tie the door kept, never a line between two concepts.
    expect(referent!.passes).toBe(2)
    expect(map.ties.some((edge) => edge.relation === "redefined-by" && edge.provenance === "file" && edge.a === edge.b)).toBe(true)
    // Held two ways is the anomaly: marked contested, never a clean relation.
    expect(map.ties.some((edge) => edge.relation === "same-value" && edge.contested)).toBe(true)
    expect(referent!.contested).toBe(true)
    // A block with a check closes the referent on mechanical ground.
    expect(referent!.standing).toBe("witnessed")
  })

  test("a re-entry that names a block the record no longer holds is a typed gap", () => {
    const record: RecordView = {
      record: [{ id: "b1", referent: "the invoice total", delta: ["a"] }],
      supersedes: [{ referent: "the invoice total", superseded: "gone", supersededBy: "b1" }],
      disagreements: [],
    }
    const map = buildMindMap(snap([]), record)
    expect(map.gaps.some((gap) => gap.startsWith("the invoice total: a re-entry"))).toBe(true)
  })

  test("the read counts only what the map holds", () => {
    const map = buildMindMap(snap([target("bun test a", { name: "Test Run", settled: true }), target("src/b.ts", { name: "Reader", after: "bun test a" })]))
    expect(map.read).toContain("2 concepts")
    expect(map.read).toContain("1 grew from another")
    expect(map.read).toContain("1 closed by a check")
  })

  test("a concept with no tie and no check is a typed gap, never placed", () => {
    const map = buildMindMap(snap([target("src/a.ts", { name: "Reader" })]))
    expect(map.gaps).toEqual(["Reader: no tie and no check yet"])
  })
})

describe("localize", () => {
  const concepts: Concept[] = [
    { id: "a", label: "A", state: "open", standing: "asserted", degree: 2, holon: false, passes: 1 },
    { id: "b", label: "B", state: "open", standing: "asserted", degree: 1, holon: false, passes: 1 },
    { id: "c", label: "C", state: "open", standing: "asserted", degree: 1, holon: false, passes: 1 },
  ]
  const map = { concepts, ties: [
    { a: "a", b: "b", relation: "derived-from" as const, provenance: "computed" as const },
    { a: "a", b: "c", relation: "derived-from" as const, provenance: "computed" as const },
  ], read: "", gaps: [] }

  test("the map is drawn from one standpoint: the focus sits at the centre", () => {
    const local = localize(map, "b")
    const focus = local.nodes.find((node) => node.focus)
    expect(focus!.id).toBe("b")
    expect([focus!.x, focus!.y]).toEqual([50, 50])
    expect([focus!.ring]).toEqual([0])
  })

  test("everything within a hop is placed on a ring, and the ring is ordered by tie", () => {
    const local = localize(map, "a")
    expect(local.nodes.find((node) => node.id === "a")!.focus).toBe(true)
    const ring1 = local.nodes.filter((node) => node.ring === 1).map((node) => node.id).sort()
    expect(ring1).toEqual(["b", "c"])
  })

  test("with no standpoint named, the concept with the most ties is the focus", () => {
    expect(localize(map).focus!.id).toBe("a")
  })

  test("an empty map localizes to nothing, never throws", () => {
    const empty = localize({ concepts: [], ties: [], read: "", gaps: [] })
    expect(empty.nodes).toEqual([])
    expect(empty.focus).toBeUndefined()
  })

  test("the orbit rings are drawn: a hop out is a wider shell", () => {
    const local = localize(map, "a")
    expect(local.rings).toEqual([orbitRadius(1)])
    expect(local.nodes.find((node) => node.id === "b")!.orbit).toBe(orbitRadius(1))
  })

  test("gravity: at the same hop, a stronger bond sits nearer the focus", () => {
    const weighted = {
      concepts,
      ties: [
        { a: "a", b: "b", relation: "derived-from" as const, provenance: "computed" as const, weight: 4 },
        { a: "a", b: "c", relation: "derived-from" as const, provenance: "computed" as const, weight: 2 },
      ],
      read: "",
      gaps: [],
    }
    const local = localize(weighted, "a")
    const near = local.nodes.find((node) => node.id === "b")!
    const far = local.nodes.find((node) => node.id === "c")!
    expect(near.ring).toBe(1)
    expect(far.ring).toBe(2)
    expect(near.orbit).toBeLessThan(far.orbit)
  })
})

describe("the orbits turn", () => {
  const concepts: Concept[] = [
    { id: "a", label: "A", state: "open", standing: "asserted", degree: 1, holon: false, passes: 1 },
    { id: "b", label: "B", state: "open", standing: "asserted", degree: 1, holon: false, passes: 1 },
  ]
  const map = { concepts, ties: [{ a: "a", b: "b", relation: "derived-from" as const, provenance: "computed" as const }], read: "", gaps: [] }

  test("an inner orbit turns faster, so the bodies desynchronise", () => {
    expect(orbitSpeed(1)).toBeGreaterThan(orbitSpeed(2))
    expect(orbitSpeed(1)).toBeGreaterThan(orbitSpeed(3))
    expect(orbitRadius(1)).toBeLessThan(orbitRadius(2))
  })

  test("a body stays on its orbit while it turns", () => {
    const local = localize(map, "a")
    const b = local.nodes.find((node) => node.id === "b")!
    const turned = orbitAt(local, 12).nodes.find((node) => node.id === "b")!
    expect(Math.hypot(turned.x - 50, turned.y - 50)).toBeCloseTo(b.orbit, 5)
    expect(turned.y).not.toBeCloseTo(b.y, 3)
  })

  test("the ties follow the bodies, so an edge never floats free", () => {
    const local = localize(map, "a")
    const frame = orbitAt(local, 7)
    const at = new Map(frame.nodes.map((node) => [node.id, node]))
    for (const edge of frame.edges) {
      expect([edge.ax, edge.ay]).toEqual([at.get(edge.a)!.x, at.get(edge.a)!.y])
      expect([edge.bx, edge.by]).toEqual([at.get(edge.b)!.x, at.get(edge.b)!.y])
    }
  })
})

describe("holons", () => {
  const concepts: Concept[] = [
    { id: "a", label: "A", state: "open", standing: "asserted", degree: 2, holon: false, passes: 1 },
    { id: "b", label: "B", state: "open", standing: "asserted", degree: 1, holon: false, passes: 1 },
    { id: "c", label: "C", state: "open", standing: "asserted", degree: 1, holon: false, passes: 1 },
  ]
  const map = {
    concepts,
    ties: [
      { a: "a", b: "b", relation: "derived-from" as const, provenance: "computed" as const },
      { a: "a", b: "c", relation: "derived-from" as const, provenance: "computed" as const },
    ],
    read: "",
    gaps: [],
  }

  test("a lighter name nests under the strongest-tied name that outranks it", () => {
    const nest = nestOf(map)
    expect(nest.parent.get("b")).toBe("a")
    expect(nest.parent.get("c")).toBe("a")
    expect(nest.roots).toEqual(["a"])
    expect(nest.size.get("a")).toBe(3)
  })

  test("closed at level 0: one circle stands for everything inside it, and its inner ties vanish", () => {
    const local = localize(map, "a", { open: new Set(), level: 0 })
    expect(local.nodes).toHaveLength(1)
    expect(local.nodes[0]!.id).toBe("a")
    expect(local.nodes[0]!.members).toBe(3)
    expect(local.nodes[0]!.holds).toBe(true)
    expect(local.nodes[0]!.open).toBe(false)
    expect(local.ties).toEqual([])
    expect(local.beyond).toBe(0)
    expect(local.maxLevel).toBe(1)
  })

  test("opened one level: the members fold out and their ties reappear", () => {
    const local = localize(map, "a", { open: openAtLevel(nestOf(map), 1), level: 1 })
    expect(local.nodes.map((node) => node.id).sort()).toEqual(["a", "b", "c"])
    expect(local.nodes.find((node) => node.id === "a")!.open).toBe(true)
    expect(local.nodes.find((node) => node.id === "a")!.members).toBe(1)
    expect(local.ties).toHaveLength(2)
  })

  test("the default draw is fully open, so nothing is hidden that cannot be gone into", () => {
    const local = localize(map, "a")
    expect(local.level).toBe(local.maxLevel)
    expect(local.nodes.map((node) => node.id).sort()).toEqual(["a", "b", "c"])
  })

  test("you can enter a concept hidden inside a closed holon: it lands on the holon that holds it", () => {
    const local = localize(map, "b", { open: new Set() })
    expect(local.focus!.id).toBe("a")
    expect(local.nodes[0]!.members).toBe(3)
  })

  test("a closed holon still turns on its orbit", () => {
    const local = localize(map, "a", { open: new Set() })
    const spun = orbitAt(local, 9)
    expect(spun.nodes).toHaveLength(1)
    expect(spun.edges).toEqual([])
  })
})

describe("vocabulary", () => {
  test("every relation has a word from the holodeck's map", () => {
    expect(Object.values(RELATION_WORD)).toEqual(["grew from", "redefined by a later block", "carried the last miss", "held two ways"])
  })
})
