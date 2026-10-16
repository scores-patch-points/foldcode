// The mind map, as data. The work tree answers "what did it touch, in order"; this answers "what concepts are
// relating, and from where". It is the holodeck's map idiom — names folded into holons, ties between them, a ring
// meaning it holds more and opens on click — applied to the turn's own thinking. So a concept is a THING (a file, a
// command, a search, a referent the door kept), never a sentence: the model's running commentary is the `thought`
// under a concept, not its name. Every tie is one of the holodeck's relation words and says how it was established.
//
// The map is RELATIVISTIC: there is no single frame, so `localize()` draws it from one concept's standpoint — click
// a concept and the map recenters on it, its own neighbourhood read against the same vocabulary. Plain TypeScript so
// it is testable alone (see mind-map-model.test.ts).
//
// Standing follows the door's firewall: a concept a passing check closed is WITNESSED (mechanical); anything else is
// ASSERTED (a holder's standpoint). A tie the turn's own trace implies is `computed`; one the door kept is `file`.
//
// A tie whose two ends are the SAME concept is a self-tie: it is how one name holds more than it shows — a referent
// the door re-entered (redefined-by), a pass that carried the previous miss (carried), a name held two ways
// (same-value). A self-tie is never drawn as a line; it is the ring and the mark, and the card reads it out.
//
// The nesting is not re-derived here: concepts fold into holons by the holodeck's own engine (holon-engine.ts,
// vendored verbatim). A closed holon is one circle standing for everything inside it; opening it — or stepping a
// level — sets the members free, and ties between two holons are the sum of the ties between their members. So the
// map is not a flat scatter: it is a forest you can go into, which is what "how do I go inside of anything" needs.

import { buildTree, stageById, type MindStage, type Snapshot, type TreeNode } from "./mind-tree-model"
import { levelsOf, nestByTies, openAtLevel, repOf, rollUp, visibleHolons, type Nest } from "./holon-engine"
import type { RecordView } from "./plans-model"

export { levelsOf, openAtLevel } from "./holon-engine"

/** The holodeck's relation words, restricted to what a turn's own trace can witness. */
export type Relation = "derived-from" | "redefined-by" | "carried" | "same-value"

export const RELATION_WORD: Record<Relation, string> = {
  "derived-from": "grew from",
  "redefined-by": "redefined by a later block",
  carried: "carried the last miss",
  "same-value": "held two ways",
}

export const RELATION_GLYPH: Record<Relation, string> = {
  "derived-from": "⇢",
  "redefined-by": "⊂",
  carried: "↻",
  "same-value": "●─●",
}

/** How a tie was established. Rank orders trust: a kept tie outranks a computed one, which outranks an inferred. */
export type Provenance = "inferred" | "computed" | "file" | "witnessed"

export const PROVENANCE_RANK: Record<Provenance, number> = { inferred: 0, computed: 1, file: 2, witnessed: 3 }

/** The ground a concept stands on: mechanical (a check closed it) or a holder's word (asserted). */
export type Standing = "witnessed" | "asserted"

export type Concept = {
  id: string
  /** The thing, named in words — never a path as identity, never a sentence. */
  label: string
  /** The address, when it has one (openable). Absent for a nameless task or a bare referent. */
  where?: string
  /** A line range or other detail. */
  detail?: string
  state: "running" | "settled" | "failed" | "open" | "redefined"
  /** The one operator it is on now, or ended on. */
  at?: MindStage
  standing: Standing
  /** How many OTHER concepts it ties to (the holodeck's degree: larger means more statements). */
  degree: number
  /** It holds more than it shows (passes, or concepts grown from it): a ring, click to open. */
  holon: boolean
  /** How many passes its walk made (more than one means it was reframed, or a referent re-entered). */
  passes: number
  /** The model's own words for this target — live commentary, shown under a running concept. */
  thought?: string
  /** Held two ways by the record: the anomaly the map reserves. */
  contested?: boolean
}

export type Tie = {
  a: string
  b: string
  relation: Relation
  provenance: Provenance
  /** The bond's strength: how many statements the turn made tying these two (default one). A stronger bond sits
   *  nearer the focus — the holodeck's gravity, where distance follows shared-statement counts, not hop count. */
  weight?: number
  /** A tie held two ways (a disagreement): drawn as the anomaly, never as a clean relation. */
  contested?: boolean
}

export type MindMap = {
  concepts: Concept[]
  /** Every tie, self-ties (a === b) included: those are the marks, not the lines. */
  ties: Tie[]
  /** The radiologist's line: computed only from the concepts and ties, never invented. */
  read: string
  /** What has no tie and no check: the places the map cannot place. */
  gaps: string[]
}

const tie = (a: string, b: string, relation: Relation, provenance: Provenance, contested = false): Tie => {
  const bond: Tie = { a, b, relation, provenance }

  if (contested) bond.contested = true

  return bond
}

/** A concept node, before degrees are counted. */
type Seed = Omit<Concept, "degree" | "holon">

const labelOf = (node: TreeNode) => node.label || node.where || "the task itself"

/** The concept a work-tree node is: a THING named in words, with its one operator and its standing. */
function conceptOf(node: TreeNode): Seed {
  return {
    id: node.id,
    label: labelOf(node),
    where: node.where || undefined,
    detail: node.detail || undefined,
    state: node.state,
    at: node.at,
    // A target a passing check closed stands on mechanical ground; anything else is a holder's word.
    standing: node.state === "settled" ? "witnessed" : "asserted",
    passes: node.laps.length,
    thought: node.state === "running" && node.aim ? node.aim : undefined,
  }
}

/** The tree layer: one concept per target, the "grew from" ties, and the carried-miss self-tie on a reframed walk. */
function treeLayer(snapshot: Snapshot | undefined, byId: Map<string, Seed>, ties: Tie[], children: Map<string, number>) {
  const roots = buildTree(snapshot)

  for (const node of roots) {
    const walk = (item: TreeNode, parent?: string) => {
      byId.set(item.id, conceptOf(item))

      if (parent) ties.push(tie(item.id, parent, "derived-from", "computed"))

      if (item.laps.length > 1) ties.push(tie(item.id, item.id, "carried", "computed"))
      children.set(item.id, item.children.length)

      for (const child of item.children) walk(child, item.id)
    }

    walk(node)
  }
}

/** The door's kept record, folded in as the referents it holds: one concept per referent, the redefinitions as
 *  passes and a self-tie, and a name held two ways marked as the anomaly. Nothing here is invented: a re-entry that
 *  names a block the record no longer holds is a typed gap. */
function recordLayer(
  view: RecordView | undefined,
  byId: Map<string, Seed>,
  ties: Tie[],
  contested: Set<string>,
  gaps: string[],
) {
  if (!view) return
  const held = new Map(view.record.map((block) => [block.id, block]))
  const byLabel = new Map([...byId.values()].map((seed) => [seed.label.toLowerCase(), seed]))
  const groups = new Map<string, typeof view.record>()

  for (const block of view.record) groups.set(block.referent, [...(groups.get(block.referent) ?? []), block])

  for (const [referent, blocks] of groups) {
    const key = referent.toLowerCase()
    let seed = byLabel.get(key)

    if (!seed) {
      seed = { id: `ref:${key}`, label: referent, state: "redefined", standing: "asserted", passes: 1 }
      byId.set(seed.id, seed)
      byLabel.set(key, seed)
    }

    const reentries = view.supersedes.filter((edge) => edge.referent === referent).length

    if (reentries > 0) {
      seed.state = "redefined"
      seed.passes = Math.max(seed.passes, 1 + reentries)
      ties.push(tie(seed.id, seed.id, "redefined-by", "file"))
    }

    if (blocks.some((block) => block.check)) seed.standing = "witnessed"

    if (view.disagreements.some((item) => item.referent === referent)) {
      contested.add(seed.id)
      ties.push(tie(seed.id, seed.id, "same-value", "computed", true))
    }
  }

  for (const edge of view.supersedes)
    if (!held.has(edge.superseded) || !held.has(edge.supersededBy))
      gaps.push(`${edge.referent}: a re-entry names a block the record no longer holds`)
}

export function buildMindMap(snapshot: Snapshot | undefined, record?: RecordView): MindMap {
  const ties: Tie[] = []
  const children = new Map<string, number>()
  const contested = new Set<string>()
  const gaps: string[] = []
  const byId = new Map<string, Seed>()
  treeLayer(snapshot, byId, ties, children)
  recordLayer(record, byId, ties, contested, gaps)

  // Degree: how many OTHER concepts each one ties to (a self-tie is a mark, not a connection).
  const degree = new Map<string, number>()

  for (const edge of ties) {
    if (edge.a === edge.b) continue
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1)
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1)
  }

  const concepts: Concept[] = [...byId.values()].map((seed) => ({
    ...seed,
    degree: degree.get(seed.id) ?? 0,
    // It holds more than it shows: more than one pass, concepts grown from it, or held two ways.
    holon: seed.passes > 1 || (children.get(seed.id) ?? 0) > 0 || contested.has(seed.id),
    contested: contested.has(seed.id) || undefined,
  }))

  // What the map cannot place: a concept with no tie and no check. A typed gap, never a guess.
  for (const concept of concepts)
    if (concept.degree === 0 && !concept.holon && concept.standing === "asserted")
      gaps.push(`${concept.label}: no tie and no check yet`)

  return { concepts, ties, read: readOf(concepts, ties), gaps }
}

/** The read: one sentence, computed only from the concepts and ties. Nothing appears that the map does not hold. */
export function readOf(concepts: ReadonlyArray<Concept>, ties: ReadonlyArray<Tie>): string {
  if (concepts.length === 0) return "nothing yet — the map grows as the turn works"
  const lines = ties.filter((edge) => edge.a !== edge.b)

  const parts = [
    `${concepts.length} concept${concepts.length === 1 ? "" : "s"}`,
    `${lines.length} tie${lines.length === 1 ? "" : "s"}`,
  ]

  const grew = lines.filter((edge) => edge.relation === "derived-from").length
  const reentered = concepts.filter((concept) => concept.state === "redefined").length
  const held = concepts.filter((concept) => concept.contested).length
  const witnessed = concepts.filter((concept) => concept.standing === "witnessed").length

  if (grew) parts.push(`${grew} grew from another`)

  if (reentered) parts.push(`${reentered} re-entered`)

  if (held) parts.push(`${held} held two ways`)
  parts.push(`${witnessed} closed by a check`)

  return parts.join(" · ")
}

/** The nesting the map folds into: names and their ties in, a forest out — the holodeck's own engine (holon-engine).
 *  A concept's rank is its degree, so the most-tied concept is a root and every lighter one nests under what it is
 *  most tied to; that forest is what makes "go inside" real, because a holon is a group you open, not a dot. */
export function nestOf(map: MindMap): Nest {
  return nestByTies(
    map.concepts.map((concept) => ({ n: concept.id, c: Math.max(1, concept.degree) })),
    map.ties.filter((tie) => tie.a !== tie.b).map((tie) => ({ a: tie.a, b: tie.b, c: tie.weight ?? 1 })),
  )
}

export type Placement = Concept & {
  x: number
  y: number
  /** The mark's radius in the same 0–100 space: larger means more ties, rolled up through the holon. */
  r: number
  /** The concept the map is drawn from. */
  focus: boolean
  /** The orbit, counted as relational distance from the focus: 0 is the focus itself. */
  ring: number
  /** The orbit's radius in the 0–100 space (0 at the focus). */
  orbit: number
  /** The body's resting angle, before the spin. */
  angle: number
  /** Radians per tick: inner orbits turn faster, the holodeck's own law. */
  speed: number
  /** How many concepts this mark stands for; more than one means it is a holon drawn closed. */
  members: number
  /** It holds more than it shows — a ring you can open. */
  holds: boolean
  /** Whether its members are drawn (open) or folded into this one circle (closed). */
  open: boolean
}

export type LocalEdge = Tie & { ax: number; ay: number; bx: number; by: number }

export type Local = {
  /** The bodies, placed at rest (spin 0). Use `orbitAt` to place them at a tick. */
  nodes: Placement[]
  /** Only the ties whose two ends are both placed, rolled up between their holons. */
  ties: Tie[]
  /** The concept the map is drawn from, when the map is not empty. */
  focus?: Concept
  /** The orbit radii, ascending — drawn as the faint concentric circles. */
  rings: number[]
  /** Concepts beyond the drawn orbits, counted but not placed. */
  beyond: number
  /** The holons currently open (their members drawn). */
  open: ReadonlySet<string>
  /** The level the map is opened to, and the deepest level there is. */
  level: number
  maxLevel: number
  /** Why the map is drawn from that concept — the holodeck's own reason, said plainly, never invented. */
  focusWhy: string
  /** The holon each concept is drawn as (the visible holon it folds into) — so a page can say where it is on the map. */
  rep: ReadonlyMap<string, string>
}

// The holodeck's own arithmetic (holodeck-map.js: the solar-system layout), in this map's 0–100 space: step is
// min(W,H)*0.12 of a 100-unit frame, the outermost orbit is min(W,H)*0.46, and an inner orbit turns faster.
const ORBIT_STEP = 12

const ORBIT_MAX = 46

const ORBITS = 3

export const orbitRadius = (ring: number) => (ring <= 0 ? 0 : Math.min(ORBIT_MAX, ORBIT_STEP * ring + ORBIT_STEP * 0.5))

export const orbitSpeed = (ring: number) => (ring <= 0 ? 0 : 0.22 / (1 + ring * 0.45))

const atOrbit = (orbit: number, angle: number) => ({ x: 50 + Math.cos(angle) * orbit, y: 50 + Math.sin(angle) * orbit })

/** Larger means more ties, rolled up through the holon; a holon that holds more is drawn a touch wider. */
const radiusOf = (degree: number, holds: boolean) => 3.4 + Math.min(6, degree) * 0.55 + (holds ? 1.4 : 0)

/** The map from one concept's standpoint — the relativistic draw. There is no single frame, so the focus is the body
 *  in the middle and every other body sits on its orbit by relational distance: a strong tie close, a weak one out
 *  (Dijkstra over 1/bond, the holodeck's gravity). Concepts first fold into holons (holon-engine): a closed holon is
 *  one circle standing for everything inside it, and opening it sets the members free — so `open` (and the level it
 *  comes from) is the only thing that decides what is drawn. Pure, and at rest; `orbitAt` turns it. */
export function localize(map: MindMap, focusId?: string, opts: { open?: ReadonlySet<string>; level?: number } = {}): Local {
  const nest = nestOf(map)
  const maxLevel = levelsOf(nest).max
  const open = opts.open ?? openAtLevel(nest, maxLevel)
  const level = opts.level ?? maxLevel
  const byId = new Map(map.concepts.map((concept) => [concept.id, concept]))
  // Every concept is represented by the visible holon it folds into.
  const reps = new Map<string, string>()

  for (const concept of map.concepts) reps.set(concept.id, repOf(nest, concept.id, open))
  const members = new Map<string, Concept[]>()

  for (const concept of map.concepts) {
    const h = reps.get(concept.id)!
    members.set(h, [...(members.get(h) ?? []), concept])
  }

  // The focus: the concept you named, else the one with the most ties (the holodeck's own rule), else the first. It is
  // named as such, because a draw that does not say where it is read from is a claim pretending to be the whole.
  const named = focusId ? byId.get(focusId) : undefined

  const focusConcept =
    named ?? [...map.concepts].sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label))[0]

  const focusWhy = named ? "you entered it" : map.concepts.length === 1 ? "it is the only concept" : "it has the most ties"

  if (!focusConcept) return { nodes: [], ties: [], rings: [], beyond: 0, open, level, maxLevel, focusWhy: "", rep: reps }
  const focusHolon = reps.get(focusConcept.id)!

  // The rolled-up ties: a tie between two holons is every tie between their members; a tie inside one holon vanishes.
  const rolled = rollUp(
    map.ties.filter((tie) => tie.a !== tie.b).map((tie) => ({ a: tie.a, b: tie.b, c: tie.weight ?? 1 })),
    reps,
  )

  const pairKey = (a: string, b: string) => (a < b ? a + "\u0001" + b : b + "\u0001" + a)
  const ties: Tie[] = []

  for (const [key, edge] of rolled) {
    const group = map.ties.filter((tie) => tie.a !== tie.b && pairKey(reps.get(tie.a)!, reps.get(tie.b)!) === key)
    const model = group.find((tie) => tie.provenance === "file") ?? group[0]

    const bond: Tie = {
      a: edge.a,
      b: edge.b,
      relation: model?.relation ?? "derived-from",
      provenance: model?.provenance ?? "computed",
      weight: edge.c,
    }

    if (group.some((tie) => tie.contested)) bond.contested = true

    ties.push(bond)
  }

  // Degree from the rolled-up ties, so a holon's mark grows with everything it stands for.
  const degree = new Map<string, number>()

  for (const edge of ties) {
    const w = edge.weight ?? 1
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + w)
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + w)
  }

  const nodeOf = (id: string): Placement => {
    const rep = byId.get(id)!
    const list = members.get(id) ?? [rep]
    const contested = list.some((concept) => concept.contested)
    const witnessed = list.some((concept) => concept.standing === "witnessed")
    const passes = list.reduce((most, concept) => Math.max(most, concept.passes), 1)
    const running = list.some((concept) => concept.state === "running")
    const holds = (nest.kids.get(id) ?? []).length > 0

    return {
      ...rep,
      state: running ? "running" : rep.state,
      standing: witnessed ? "witnessed" : rep.standing,
      degree: degree.get(id) ?? 0,
      passes,
      holon: holds || passes > 1 || contested,
      contested: contested || undefined,
      members: list.length,
      holds,
      open: open.has(id),
      x: 0,
      y: 0,
      r: 0,
      focus: false,
      ring: 0,
      orbit: 0,
      angle: 0,
      speed: 0,
    }
  }

  // GRAVITY: a strong tie sits near and a weak one drifts out. Edge length is the bond's inverse, so Dijkstra's
  // cumulative distance is the orbit ring — exactly the holodeck's layout.
  let WMAX = 1
  rolled.forEach((edge) => { if (edge.c > WMAX) WMAX = edge.c })
  const dist = new Map<string, number>([[focusHolon, 0]])
  const done = new Set<string>()

  while (true) {
    let u: string | undefined
    let best = Infinity

    for (const [id, d] of dist) if (!done.has(id) && d < best) { best = d; u = id }

    if (u === undefined) break
    done.add(u)

    for (const edge of rolled.values()) {
      const other = edge.a === u ? edge.b : edge.b === u ? edge.a : undefined

      if (other === undefined || done.has(other)) continue
      const next = best + WMAX / edge.c

      if (next < (dist.get(other) ?? Infinity)) dist.set(other, next)
    }
  }

  const orbitOf = new Map<number, Placement[]>()

  for (const id of visibleHolons(nest, open)) {
    const placement = nodeOf(id)
    const d = dist.get(id)
    placement.ring = d === undefined ? ORBITS + 1 : Math.min(ORBITS + 1, Math.round(d))
    orbitOf.set(placement.ring, [...(orbitOf.get(placement.ring) ?? []), placement])
  }

  const nodes: Placement[] = []
  const radii = new Set<number>()

  for (const [ring, list] of [...orbitOf.entries()].sort((a, b) => a[0] - b[0])) {
    if (ring > ORBITS) continue
    const orbit = orbitRadius(ring)
    const speed = orbitSpeed(ring)

    if (orbit > 0) radii.add(orbit)
    // Spread the orbit by tie order, starting at the top so the draw is stable between updates.
    list
      .sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label))
      .forEach((placement, index) => {
        const angle = ring === 0 ? 0 : -Math.PI / 2 + (index / list.length) * Math.PI * 2 + (ring % 2 ? 0.35 : 0)
        nodes.push({
          ...placement,
          ...atOrbit(orbit, angle),
          r: radiusOf(placement.degree, placement.holds),
          focus: ring === 0,
          orbit,
          angle,
          speed,
        })
      })
  }

  const placed = nodes.reduce((sum, node) => sum + node.members, 0)

  return {
    nodes,
    ties,
    focus: nodes.find((node) => node.focus) ?? focusConcept,
    rings: [...radii].sort((a, b) => a - b),
    beyond: map.concepts.length - placed,
    open,
    level,
    maxLevel,
    focusWhy,
    rep: reps,
  }
}

/** Place every body at a moment: the orbits turn, an inner one faster, and the ties follow the bodies. */
export function orbitAt(local: Local, ticks = 0) {
  const nodes = local.nodes.map((node) => ({ ...node, ...atOrbit(node.orbit, node.angle + ticks * node.speed) }))
  const at = new Map(nodes.map((node) => [node.id, node]))

  const edges: LocalEdge[] = local.ties.flatMap((edge) => {
    const a = at.get(edge.a)
    const b = at.get(edge.b)

    if (!a || !b) return []

    return [{ ...edge, ax: a.x, ay: a.y, bx: b.x, by: b.y }]
  })

  return { nodes, edges }
}

export type { Concept as MindConcept }

// ---------------------------------------------------------------------------------------------------------------------
// The two cursors. The map has a POSITION (where it is drawn from — `focus`, turned only by an explicit `center`) and a
// CURSOR (where you are on it — stepped by ← →, opening nothing by itself). They are deliberately separate: a cursor
// that recentered the map would re-lay the whole draw under the pointer, which is exactly what makes clicking feel
// wrong. So the cursor moves and the map stays; a click on a concept opens its profile instead.

/** Every concept the map draws, in draw order (outer ring by ring, weightiest first): the cursor's walk. */
export const cursorOrder = (local: Local) => local.nodes.map((node) => node.id)

/** Where the cursor is: the 0-based place in the draw order, and how many there are (`-1` when it points at nothing). */
export function cursorPos(local: Local, id: string | undefined) {
  const at = id === undefined ? -1 : cursorOrder(local).indexOf(id)

  return { at, of: local.nodes.length }
}

/** Step the cursor: one concept at a time, wrapping at the ends, starting at the near end when there is no cursor yet. */
export function stepCursor(local: Local, id: string | undefined, dir: 1 | -1): string | undefined {
  const order = cursorOrder(local)

  if (order.length === 0) return undefined
  const at = id === undefined ? -1 : order.indexOf(id)

  if (at < 0) return dir > 0 ? order[0] : order[order.length - 1]

  return order[(at + dir + order.length) % order.length]
}

// ---------------------------------------------------------------------------------------------------------------------
// The profile. A click on the map does not move the map; it opens this page for the concept you clicked — the drill-in
// page, drawn from the same map and the same snapshot, so it can never be a mock-up of what the map is showing. The
// profile has its own cursor: prev/next steps its LINES, one at a time, and the line you are on is the one you follow.

/** One line of a profile: a thing the cursor steps. A tie leads to its peer; a step is the walk's own record; a pass is
 *  the header of one walk; a note leads nowhere, because it is the same concept holding more than it shows. */
export type ProfileRow = {
  id: string
  kind: "tie" | "pass" | "step" | "note"
  /** What the line says, in the map's own words. */
  text: string
  /** The line's mark: a relation glyph, a step's operator, a pass's fate. */
  mark?: string
  /** The fine print: how a tie was established, what a step missed. */
  detail?: string
  /** The concept this line leads to, when it leads to one. */
  to?: string
  /** Held two ways: the anomaly the map reserves, never a clean relation. */
  contested?: boolean
  /** What the line's own walk did. */
  state?: Concept["state"]
}

/** A concept's profile: the concept, every line its cursor steps, and the one-line read. */
export type Profile = {
  concept: Concept
  rows: ProfileRow[]
  /** One sentence, computed only from the concept and its lines. Nothing appears that the profile does not hold. */
  read: string
}

/** The read: what this concept is, how it stands, and what it holds — computed, never invented. */
export function profileRead(concept: Concept, rows: ReadonlyArray<ProfileRow>): string {
  const kind = concept.state === "redefined" ? "a referent the record holds" : concept.where ? "a file" : "the task itself"
  const parts = [kind, concept.standing === "witnessed" ? "closed by a check" : "asserted"]
  const ties = rows.filter((row) => row.kind === "tie").length
  const steps = rows.filter((row) => row.kind === "step").length

  if (ties) parts.push(`${ties} tie${ties === 1 ? "" : "s"}`)

  if (concept.passes > 1) parts.push(`${concept.passes} passes — the walk was reframed`)

  if (concept.contested) parts.push("held two ways")

  if (steps) parts.push(`${steps} step${steps === 1 ? "" : "s"} on this target`)

  return parts.join(" · ")
}

const findNode = (nodes: ReadonlyArray<TreeNode>, id: string): TreeNode | undefined => {
  for (const node of nodes) {
    if (node.id === id) return node
    const found = findNode(node.children, id)

    if (found) return found
  }

  return undefined
}

/** The profile of one concept: what it ties to (the drill targets, in the map's own relation words), then how its walk
 *  went (the turn's own record, pass by pass), and a note for each self-tie — and the typed gap when there is neither,
 *  which is a result, not an empty page. */
export function profileOf(map: MindMap, id: string, snapshot?: Snapshot): Profile | undefined {
  const concept = map.concepts.find((item) => item.id === id)

  if (!concept) return undefined
  const rows: ProfileRow[] = []

  // The ties it stands in: each leads to its peer, so the cursor can walk from concept to concept.
  for (const tie of map.ties.filter((edge) => edge.a === id || edge.b === id)) {
    const peerId = tie.a === id ? tie.b : tie.a

    if (peerId === id) {
      const row: ProfileRow = {
        id: `${id}:self:${tie.relation}`,
        kind: "note",
        mark: RELATION_GLYPH[tie.relation],
        text: RELATION_WORD[tie.relation],
        detail: tie.contested ? "held two ways — the anomaly the map reserves" : tie.provenance === "file" ? "the door kept it" : "the turn's own trace",
      }

      if (tie.contested) row.contested = true

      rows.push(row)
      continue
    }

    const peer = map.concepts.find((item) => item.id === peerId)

    if (!peer) continue

    const row: ProfileRow = {
      id: `${id}:tie:${peerId}:${tie.relation}`,
      kind: "tie",
      mark: RELATION_GLYPH[tie.relation],
      text: peer.label,
      detail: `${RELATION_WORD[tie.relation]} · ${tie.provenance}`,
      to: peerId,
    }

    if (tie.contested) row.contested = true

    rows.push(row)
  }

  // How it walked: the turn's own record of this target, pass by pass, in order.
  const node = snapshot ? findNode(buildTree(snapshot), id) : undefined

  if (node)
    node.laps.forEach((lap) => {
      if (node.laps.length > 1) {
        const pass: ProfileRow = {
          id: `${id}:pass:${lap.n}`,
          kind: "pass",
          mark: lap.failed ? "✗" : "↻",
          text: `pass ${lap.n + 1}`,
          state: lap.failed ? "failed" : "settled",
        }

        if (lap.carried) pass.detail = `carried: ${lap.carried}`

        rows.push(pass)
      }

      lap.steps.forEach((step, index) =>
        rows.push({
          id: `${id}:step:${lap.n}:${index}`,
          kind: "step",
          mark: stageById(step.stage)?.glyph ?? "·",
          text: step.name,
          detail: step.error ? `missed: ${step.error}` : stageById(step.stage)?.label,
          state: stepState(step.status),
        }),
      )
    })

  if (rows.length === 0) rows.push({ id: `${id}:gap`, kind: "note", text: "no tie and no check yet — a typed gap" })

  return { concept, rows, read: profileRead(concept, rows) }
}

/** A step's status in the map's own state words: a miss failed, a step in flight is running, anything else settled. */
function stepState(status: string): Concept["state"] {
  if (status === "error") return "failed"

  if (status === "running") return "running"

  return "settled"
}

export { stageById }
