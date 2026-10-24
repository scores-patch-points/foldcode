import { Predicate } from "effect"

// THE PIECE, as the plugin reports it while a generation runs (plugin fold.ts → metadata.notice "fold-longform").
// Carried as given: the kind and topic, the layer at work (stitched: content alone; drawn: the model into the gaps), the outline
// with each slot's state and — once judged — its verdict (sentences, how many face their material, how many were cut, rounds) and
// a preview of what was kept, the slot being written or judged now, what the last step graded and cut, the marked share so far,
// how many sources were read, when it started and how many model calls it has made. Sections whose id or title are missing are
// dropped; an unknown state reads as planned. Nothing here decides anything: it is the record, drawn.
export type SectionState = "planned" | "writing" | "judging" | "written" | "cut" | "filled" | "gap" | "drawing" | "admitted"
export type LongformSection = {
  id: string
  title: string
  state: SectionState
  facts: number
  sentences?: number
  supported?: number
  cut?: number
  rounds?: number
  freeform?: boolean
  preview?: string
  round?: number
  marked?: number
  layer?: "stitched" | "drawn"
}
export type LongformGraded = { section: string; title?: string; round: number; sentences: number; supported: number; accepted: boolean; failed: string[]; freeform?: boolean }
export type LongformView = {
  topic: string
  kind: string
  outline: LongformSection[]
  current?: string
  round: number
  done: boolean
  sources: number
  startedAt?: number
  calls?: number
  layer?: "stitched" | "drawn"
  judging?: { section: string; facts: number }
  graded?: LongformGraded
  marked?: { marked: number; placed: number }
  stitched?: { filled: number; gaps: number; text?: string }
}

const STATES: ReadonlySet<string> = new Set<SectionState>(["planned", "writing", "judging", "written", "cut", "filled", "gap", "drawing", "admitted"])

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const str = (value: unknown) => (Predicate.isString(value) && value.length > 0 ? value : undefined)
const num = (value: unknown) => (Predicate.isNumber(value) && Number.isFinite(value) ? value : 0)
const opt = (value: unknown) => (Predicate.isNumber(value) && Number.isFinite(value) ? value : undefined)
const layerOf = (value: unknown): "stitched" | "drawn" | undefined => (value === "stitched" || value === "drawn" ? value : undefined)

const section = (value: unknown): LongformSection | undefined => {
  const row = record(value)
  const id = str(row?.id)
  const title = str(row?.title)
  if (!id || !title) return undefined
  const state = Predicate.isString(row?.state) && STATES.has(row.state) ? (row.state as SectionState) : "planned"
  const out: LongformSection = { id, title, state, facts: num(row?.facts) }
  const sentences = opt(row?.sentences)
  if (sentences !== undefined) out.sentences = sentences
  const supported = opt(row?.supported)
  if (supported !== undefined) out.supported = supported
  const cut = opt(row?.cut)
  if (cut !== undefined) out.cut = cut
  const rounds = opt(row?.rounds)
  if (rounds !== undefined) out.rounds = rounds
  if (row?.freeform === true) out.freeform = true
  const preview = str(row?.preview)
  if (preview) out.preview = preview
  const round = opt(row?.round)
  if (round !== undefined) out.round = round
  const marked = opt(row?.marked)
  if (marked !== undefined) out.marked = marked
  const layer = layerOf(row?.layer)
  if (layer) out.layer = layer
  return out
}

const graded = (value: unknown): LongformGraded | undefined => {
  const g = record(value)
  const section = str(g?.section)
  if (!section) return undefined
  const title = str(g?.title)
  return {
    section,
    ...(title ? { title } : {}),
    round: num(g?.round),
    sentences: num(g?.sentences),
    supported: num(g?.supported),
    accepted: g?.accepted === true,
    failed: (Array.isArray(g?.failed) ? g.failed : []).flatMap((f) => (Predicate.isString(f) ? [f] : [])),
    ...(g?.freeform === true ? { freeform: true } : {}),
  }
}

/** The longform view from a synthetic message's metadata; undefined when it is not a fold-longform notice. */
export const readLongform = (metadata: unknown): LongformView | undefined => {
  const meta = record(metadata)
  if (meta?.notice !== "fold-longform") return undefined
  const l = record(meta.longform)
  if (!l) return undefined
  const outline = (Array.isArray(l.outline) ? l.outline : []).flatMap((s) => section(s) ?? [])
  const current = str(l.current)
  const judging = record(l.judging)
  const judgingSection = str(judging?.section)
  const marked = record(l.marked)
  const stitched = record(l.stitched)
  const stitchedText = str(stitched?.text)
  const layer = layerOf(l.layer)
  const g = graded(l.graded)
  const startedAt = opt(l.startedAt)
  const calls = opt(l.calls)
  return {
    topic: str(l.topic) ?? "",
    kind: str(l.kind) ?? "prose",
    outline,
    ...(current ? { current } : {}),
    round: num(l.round),
    done: l.done === true,
    sources: num(l.sources),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(calls !== undefined ? { calls } : {}),
    ...(layer ? { layer } : {}),
    ...(judgingSection ? { judging: { section: judgingSection, facts: num(judging?.facts) } } : {}),
    ...(g ? { graded: g } : {}),
    ...(marked ? { marked: { marked: num(marked.marked), placed: num(marked.placed) } } : {}),
    ...(stitched ? { stitched: { filled: num(stitched.filled), gaps: num(stitched.gaps), ...(stitchedText ? { text: stitchedText } : {}) } } : {}),
  }
}
