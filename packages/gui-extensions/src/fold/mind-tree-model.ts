// The stigmergic work tree, as data. The app publishes a snapshot of the turn's targets (see the app's
// session-mind-stage.ts); this turns it into the tree the panel draws. Plain TypeScript so it is testable alone.
//
//   ask
//   ├─ Session Mind Stage        a file, pattern or command, named in words; its path sits beneath
//   │  ├─ pass 1                 one walk of the nine operators (shown only when a target walked more than once)
//   │  └─ pass 2 ↻ carried: …    the next pass, carrying what the last one hit
//   └─ Test Run                  began after the one above settled, so it hangs under it
//
// A row is a THING, never a sentence: the model's running commentary is the `aim`, shown as a muted line under a
// running row — it is not the row's name. And a row carries ONE operator (where the walk is now, or ended), not all
// nine: a full nine-glyph track on every line says the same thing everywhere, which is nothing.

export type MindStage = "NUL" | "SIG" | "INS" | "SEG" | "CON" | "SYN" | "DEF" | "EVA" | "REC"
export type Triad = "see" | "shape" | "hold"

// The nine operators, in order, with what each is called and the phrase that names what it is doing. Kept here (rather
// than imported from the app's session-mind-stage.ts) because the extension cannot read the app package; the app
// publishes the data, this defines the shared shape and words.
export const STAGES: ReadonlyArray<{ id: MindStage; glyph: string; label: string; doing: string; triad: Triad }> = [
  { id: "NUL", glyph: "∅", label: "Read", doing: "Reading — thinking it through", triad: "see" },
  { id: "SIG", glyph: "○", label: "Notice", doing: "Noticing — looking for what is there", triad: "see" },
  { id: "INS", glyph: "●", label: "Name", doing: "Naming — taking a specific thing in", triad: "see" },
  { id: "SEG", glyph: "｜", label: "Segment", doing: "Segmenting — cutting the work into units", triad: "shape" },
  { id: "CON", glyph: "⋈", label: "Bond", doing: "Bonding — relating things to each other", triad: "shape" },
  { id: "SYN", glyph: "△", label: "Compose", doing: "Composing — making the change", triad: "shape" },
  { id: "DEF", glyph: "⊢", label: "Define", doing: "Defining — stating what must hold", triad: "hold" },
  { id: "EVA", glyph: "⊨", label: "Evaluate", doing: "Evaluating — checking it", triad: "hold" },
  { id: "REC", glyph: "◉", label: "Reframe", doing: "Reframing — changing approach after a miss", triad: "hold" },
]

export const TRIADS: ReadonlyArray<{ id: Triad; label: string; stages: ReadonlyArray<typeof STAGES[number]> }> = [
  { id: "see", label: "see", stages: STAGES.slice(0, 3) },
  { id: "shape", label: "shape", stages: STAGES.slice(3, 6) },
  { id: "hold", label: "hold", stages: STAGES.slice(6, 9) },
]

export const stageById = (id: MindStage) => STAGES.find((stage) => stage.id === id)

export type Snapshot = {
  at: number
  /** The live "what it is doing right now" line, built from the trace (see the app's murmurOf). */
  murmur: string
  targets: ReadonlyArray<{
    where: string
    range: string
    after?: string
    /** What the thing is, in words rather than a path (see the app's prettyNameOf). */
    name: string
    /** The model's own words for this target (see the app's conceptOf); commentary, not the name. */
    aim: string
    lap: number
    reached: number
    settled: boolean
    inFlight: boolean
    laps: ReadonlyArray<{
      lap: number
      reached: number
      carried?: string
      steps: ReadonlyArray<{ name: string; kind: string; stage: MindStage; status: string; reframed: boolean; error?: string }>
    }>
  }>
}

/** One pass of the nine operators over a target. Only shown when a target walked more than one: a single pass has
 *  nothing to compare against, so its "pass 1" header would be a row that says nothing. */
export type Lap = {
  n: number
  reached: number
  failed: boolean
  /** What this pass began from: the miss it reframed, so the next pass is informed by the last. */
  carried?: string
  steps: ReadonlyArray<{ name: string; status: string; stage: MindStage; error?: string }>
}

export type TreeNode = {
  id: string
  /** The row's name in words: the thing itself, never the model's running commentary. */
  label: string
  state: "running" | "settled" | "failed" | "open"
  openable: boolean
  /** The full path, for a target; shown beneath the name and used to open it. */
  where?: string
  /** A line range or other detail, for a target. */
  detail?: string
  /** The model's own words for this target, shown as a muted line under a running row. */
  aim?: string
  /** How far the walk reached: the furthest operator index, -1 before the first step. */
  reached: number
  /** The one operator the row shows: where the walk is now (running), or the last one it reached. */
  at?: MindStage
  laps: ReadonlyArray<Lap>
  children: TreeNode[]
}

const openable = (where: string) => /[\\/.]/.test(where) && !/\s/.test(where) && !/^https?:/.test(where)

export function buildTree(snapshot: Snapshot | undefined): TreeNode[] {
  if (!snapshot) return []
  const nodes = new Map<string, TreeNode>()
  const roots: TreeNode[] = []
  snapshot.targets.forEach((item, index) => {
    const last = item.laps.at(-1)
    const live = last?.steps.findLast((step) => step.status === "running" || step.status === "streaming")
    const node: TreeNode = {
      id: `t${index}`,
      label: item.name || item.where || "the task itself",
      state: item.inFlight ? "running" : item.settled ? "settled" : last?.steps.some((step) => step.status === "error") ? "failed" : "open",
      openable: openable(item.where),
      where: item.where,
      detail: item.range || undefined,
      aim: item.aim || undefined,
      reached: item.reached,
      // The one chip the row shows: the operator running right now, or the last one the walk reached.
      at: (live ?? last?.steps.at(-1))?.stage,
      laps: item.laps.map((lap) => ({
        n: lap.lap,
        reached: lap.reached,
        failed: lap.steps.some((step) => step.status === "error"),
        carried: lap.lap > 0 ? lap.carried : undefined,
        steps: lap.steps.map((step) => ({ name: step.name, status: step.status, stage: step.stage, error: step.error })),
      })),
      children: [],
    }
    nodes.set(item.where, node)
    // A target that began after another settled grows from it, so it hangs under it.
    const parent = item.after ? nodes.get(item.after) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  })
  return roots
}
