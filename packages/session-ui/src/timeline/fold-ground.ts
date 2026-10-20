// The ground on the answer, as the window reads it: the door's payload on the notice's metadata
// (`notice: "fold-ground"`) read into rows. No word list, no grounding computed here: a sentence's tag comes from
// the door's own `standing`, and its text is shown exactly as given.
import { Predicate } from "effect"

/** The passage sentence a grounded sentence rests on, as the door located it (verbatim). */
export type GroundSource = { passage: string; text: string }

export type GroundRow = {
  text: string
  standing: string
  tag: string
  sources: GroundSource[]
}

export type GroundView = {
  rows: GroundRow[]
  superseded?: string
  gap?: string
}

const str = (value: unknown) => (Predicate.isString(value) && value.length > 0 ? value : undefined)
const record = (value: unknown): Record<string, unknown> | undefined =>
  Predicate.isObject(value) && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

/** `[S <ref>]` rests on a fact's address, `[S·identity <being>]` only names a being the material individuates,
 *  `[M]` the mouth's own; any other standing shows as the door wrote it. */
export const tagOf = (standing: string, ref?: string, beings: string[] = [], fact?: string) =>
  standing === "grounded"
    ? !ref && !fact
      ? `S·identity ${beings[0] ?? "?"}`
      : `S ${ref ?? "?"}`
    : standing === "self:model"
      ? "M"
      : standing

/** The ground view of a notice's metadata, or undefined when this notice carries none. */
export function readGround(metadata: Record<string, unknown> | undefined): GroundView | undefined {
  if (metadata?.notice !== "fold-ground") return undefined
  const ground = record(metadata.ground)
  if (!ground) return undefined
  const step = record(ground.step)
  const rows = (Array.isArray(step?.grounded) ? step.grounded : []).flatMap<GroundRow>((item) => {
    const row = record(item)
    if (!row || !Predicate.isString(row.text)) return []
    const standing = str(row.standing) ?? "?"
    const beings = (Array.isArray(row.beings) ? row.beings : []).filter(Predicate.isString)
    const sources = (Array.isArray(row.sources) ? row.sources : []).flatMap<GroundSource>((found) => {
      const source = record(found)
      return source && Predicate.isString(source.text)
        ? [{ passage: str(source.passage) ?? "material", text: source.text }]
        : []
    })
    return [{ text: row.text, standing, tag: tagOf(standing, str(row.ref), beings, str(row.fact)), sources }]
  })
  return {
    rows,
    superseded: str(step?.superseded),
    gap: step ? undefined : (str(ground.gap) ?? "no step this turn"),
  }
}

/** The ground row whose sentence covers `offset` in the answer's rendered text, found by walking the sentences in order. */
export function rowAt(rows: GroundRow[], text: string, offset: number): GroundRow | undefined {
  let from = 0
  for (const row of rows) {
    const start = text.indexOf(row.text, from)
    if (start < 0) continue
    from = start + row.text.length
    if (offset >= start && offset < from) return row
  }
}
