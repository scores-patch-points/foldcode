// Vendored from the holodeck: `holodeck/holodeck-holons.js` @ a403fd5 (scores-patch-points/holodeck). Pure and
// model-free — plain data in, plain data out. Semantics are unchanged; only types were added for this package.
//
// This is the nesting behind the surface's map: a name's parent is the strongest-tied neighbour that outranks it, so
// the weightiest names are roots and every lighter name nests under what it is most tied to. Rank is a strict total
// order (count, then name), so the result is always an acyclic forest. A holon is "open" when its members are drawn
// instead of a single circle. The mind map reuses this verbatim rather than re-deriving the shape: the Fold supplies
// the concepts and their ties, this supplies the nesting, the roll-up and the levels.

export type HolonNode = { n: string; c: number }
export type HolonEdge = { a: string; b: string; c: number }

/** The forest a set of names and their ties folds into. */
export type Nest = {
  parent: Map<string, string | null>
  kids: Map<string, string[]>
  roots: string[]
  /** A holon's own weight plus everything nested under it. */
  weight: Map<string, number>
  /** How many names the holon stands for, itself included. */
  size: Map<string, number>
  has: (n: string) => boolean
}

export const outranks = (a: HolonNode, b: HolonNode) => a.c > b.c || (a.c === b.c && a.n < b.n)

export function nestByTies(nodes: ReadonlyArray<HolonNode>, edges: ReadonlyArray<HolonEdge>): Nest {
  const byN = new Map(nodes.map((x) => [x.n, { n: x.n, c: x.c || 1 }]))
  const best = new Map<string, { u: string; w: number }>()
  const bump = (v: string, u: string, w: number) => {
    const V = byN.get(v)
    const U = byN.get(u)
    if (!V || !U || !outranks(U, V)) return
    const b = best.get(v)
    if (!b || w > b.w || (w === b.w && outranks(U, byN.get(b.u)!))) best.set(v, { u, w })
  }
  edges.forEach((E) => {
    const w = E.c || 1
    bump(E.a, E.b, w)
    bump(E.b, E.a, w)
  })
  const parent = new Map<string, string | null>()
  const kids = new Map([...byN.keys()].map((n) => [n, [] as string[]]))
  byN.forEach((_x, n) => {
    const b = best.get(n)
    parent.set(n, b ? b.u : null)
    if (b) kids.get(b.u)!.push(n)
  })
  const weight = new Map([...byN].map(([n, x]) => [n, x.c]))
  const size = new Map([...byN.keys()].map((n) => [n, 1]))
  ;[...byN.values()]
    .sort((a, b) => (outranks(a, b) ? 1 : -1))
    .forEach((x) => {
      const p = parent.get(x.n)
      if (p != null) {
        weight.set(p, weight.get(p)! + weight.get(x.n)!)
        size.set(p, size.get(p)! + size.get(x.n)!)
      }
    })
  kids.forEach((list) => list.sort((a, b) => weight.get(b)! - weight.get(a)! || (a < b ? -1 : 1)))
  const roots = [...byN.values()]
    .filter((x) => parent.get(x.n) === null)
    .sort((a, b) => (outranks(a, b) ? -1 : 1))
    .map((x) => x.n)
  return { parent, kids, roots, weight, size, has: (n) => byN.has(n) }
}

/** The visible holon that stands for `v`: walk down from the root while the holon is open. */
export function repOf(nest: Nest, v: string, open: ReadonlySet<string>): string {
  const chain: string[] = []
  for (let x: string | null | undefined = v; x != null; x = nest.parent.get(x)) chain.push(x)
  let i = chain.length - 1
  while (i > 0 && open.has(chain[i]!)) i--
  return chain[i]!
}

export function visibleHolons(nest: Nest, open: ReadonlySet<string>): string[] {
  const out: string[] = []
  const walk = (n: string) => {
    out.push(n)
    if (open.has(n)) nest.kids.get(n)!.forEach(walk)
  }
  nest.roots.forEach(walk)
  return out
}

/** Ties between two holons are the sum of the ties between their members; ties inside one holon vanish. */
export function rollUp(edges: ReadonlyArray<HolonEdge>, rep: ReadonlyMap<string, string>): Map<string, HolonEdge & { n: number }> {
  const m = new Map<string, HolonEdge & { n: number }>()
  edges.forEach((E) => {
    const a = rep.get(E.a)
    const b = rep.get(E.b)
    if (a == null || b == null || a === b) return
    const key = a < b ? a + "\u0001" + b : b + "\u0001" + a
    const x = m.get(key) ?? { a, b, c: 0, n: 0 }
    x.c += E.c || 1
    x.n++
    m.set(key, x)
  })
  return m
}

/** A holon's depth is how many parents sit above it. */
export function depthsOf(nest: Nest): Map<string, number> {
  const d = new Map<string, number>()
  nest.parent.forEach((_p, n) => {
    if (d.has(n)) return
    const chain: string[] = []
    let x: string | null | undefined = n
    while (x != null && !d.has(x)) {
      chain.push(x)
      x = nest.parent.get(x)
    }
    let base = x == null ? -1 : d.get(x)!
    for (let i = chain.length - 1; i >= 0; i--) d.set(chain[i]!, ++base)
  })
  return d
}

/** Opening "to level L" opens every holon shallower than L, so level 0 shows the roots and the deepest level shows
 *  every name; each step is one more layer of groups. */
export function levelsOf(nest: Nest): { depth: Map<string, number>; max: number } {
  const depth = depthsOf(nest)
  let max = 0
  nest.kids.forEach((ks, n) => {
    if (ks.length) max = Math.max(max, depth.get(n)! + 1)
  })
  return { depth, max }
}

export function openAtLevel(nest: Nest, L: number): Set<string> {
  const d = depthsOf(nest)
  const s = new Set<string>()
  nest.kids.forEach((ks, n) => {
    if (ks.length && d.get(n)! < L) s.add(n)
  })
  return s
}
