// The stigmergic work tree, as data. The app publishes a snapshot of the turn's targets (see the app's
// session-mind-stage.ts); this turns it into the tree the panel draws. Plain TypeScript so it is testable alone.
//
//   ask
//   ├─ target            a file, pattern or command; its track is how far its current lap has walked
//   │  ├─ lap 1          one pass of the nine operators; a failure starts the next lap (REC)
//   │  └─ lap 2
//   └─ target            began after the one above settled, so it hangs under it
//
// A target that begins once another has settled is that one's child: the settled result is what it grew from.

export const GLYPHS = ["∅", "○", "●", "｜", "⋈", "△", "⊢", "⊨", "◉"] as const

export type Snapshot = {
  at: number
  targets: ReadonlyArray<{
    where: string
    range: string
    after?: string
    lap: number
    reached: number
    settled: boolean
    inFlight: boolean
    laps: ReadonlyArray<{
      lap: number
      reached: number
      carried?: string
      steps: ReadonlyArray<{ name: string; kind: string; stage: string; status: string; reframed: boolean; error?: string }>
    }>
  }>
}

export type TreeNode = {
  id: string
  kind: "target" | "lap"
  label: string
  /** The nine glyphs, lit up to how far this node walked. */
  track: string
  state: "running" | "settled" | "failed" | "open"
  openable: boolean
  where?: string
  detail?: string
  steps?: ReadonlyArray<{ name: string; status: string; stage: string; error?: string }>
  children: TreeNode[]
}

export const trackOf = (reached: number) => GLYPHS.map((glyph, i) => (i <= reached ? glyph : "·")).join("")

const openable = (where: string) => /[\\/.]/.test(where) && !/\s/.test(where) && !/^https?:/.test(where)

export function buildTree(snapshot: Snapshot | undefined): TreeNode[] {
  if (!snapshot) return []
  const nodes = new Map<string, TreeNode>()
  const roots: TreeNode[] = []
  snapshot.targets.forEach((item, index) => {
    const failed = item.laps.at(-1)?.steps.some((step) => step.status === "error") ?? false
    const node: TreeNode = {
      id: `t${index}`,
      kind: "target",
      label: item.where || "the task itself",
      track: trackOf(item.reached),
      state: item.inFlight ? "running" : item.settled ? "settled" : failed ? "failed" : "open",
      openable: openable(item.where),
      where: item.where,
      detail: item.range || undefined,
      children: [],
    }
    // A spiral, not a list: each lap sits inside the one before it, and carries what the last one learned.
    let inner: TreeNode[] = node.children
    for (const lap of item.laps) {
      const lapNode: TreeNode = {
        id: `t${index}-l${lap.lap}`,
        kind: "lap",
        label: `lap ${lap.lap + 1}`,
        track: trackOf(lap.reached),
        state: lap.steps.some((step) => step.status === "error") ? "failed" : "open",
        openable: false,
        detail: lap.carried ? `carried: ${lap.carried}` : undefined,
        steps: lap.steps.map((step) => ({ name: step.name, status: step.status, stage: step.stage, error: step.error })),
        children: [],
      }
      inner.push(lapNode)
      inner = lapNode.children
    }
    // The most recent target with this `where` wins when a name repeats.
    nodes.set(item.where, node)
    const parent = item.after ? nodes.get(item.after) : undefined
    if (parent && parent !== node) parent.children.push(node)
    else roots.push(node)
  })
  return roots
}
