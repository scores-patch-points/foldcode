import { Predicate } from "effect"

// THE PIECE, as the plugin reports it while the model writes a longform (plugin fold.ts → metadata.notice "fold-longform").
// Carried as given: the topic, the outline with each section's state, the section being written now, the round, how many
// sources the research read. Sections whose id or title are missing are dropped; an unknown state reads as planned.
export type SectionState = "planned" | "writing" | "written" | "cut"
export type LongformSection = { id: string; title: string; state: SectionState; facts: number }
export type LongformView = {
  topic: string
  outline: LongformSection[]
  current?: string
  round: number
  done: boolean
  sources: number
}

const STATES: ReadonlySet<string> = new Set<SectionState>(["planned", "writing", "written", "cut"])

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const str = (value: unknown) => (Predicate.isString(value) && value.length > 0 ? value : undefined)
const num = (value: unknown) => (Predicate.isNumber(value) && Number.isFinite(value) ? value : 0)
const section = (value: unknown): LongformSection | undefined => {
  const row = record(value)
  const id = str(row?.id)
  const title = str(row?.title)
  if (!id || !title) return undefined
  const state = Predicate.isString(row?.state) && STATES.has(row.state) ? (row.state as SectionState) : "planned"
  return { id, title, state, facts: num(row?.facts) }
}

/** The longform view from a synthetic message's metadata; undefined when it is not a fold-longform notice. */
export const readLongform = (metadata: unknown): LongformView | undefined => {
  const meta = record(metadata)
  if (meta?.notice !== "fold-longform") return undefined
  const l = record(meta.longform)
  if (!l) return undefined
  const outline = (Array.isArray(l.outline) ? l.outline : []).flatMap((s) => section(s) ?? [])
  const current = str(l.current)
  return {
    topic: str(l.topic) ?? "",
    outline,
    ...(current ? { current } : {}),
    round: num(l.round),
    done: l.done === true,
    sources: num(l.sources),
  }
}
