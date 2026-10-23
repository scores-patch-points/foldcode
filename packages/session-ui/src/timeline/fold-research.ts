import { Predicate } from "effect"

// THE RESEARCH, as the door reports it while a gather runs (plugin fold.ts readingWatch → metadata.notice "fold-research").
// Carried as given: the queries the research ran, the page it is reading now, the pages it has read, the stop it reached.
export type ResearchPage = { host: string; title?: string }
export type ResearchView = {
  elapsedMs: number
  searches: Array<{ q: string; n: number }>
  candidates: number
  read: ResearchPage[]
  reading?: ResearchPage
  stop?: string
  done: boolean
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
const str = (value: unknown) => (Predicate.isString(value) && value.length > 0 ? value : undefined)
const num = (value: unknown) => (Predicate.isNumber(value) && Number.isFinite(value) ? value : 0)
const page = (value: unknown): ResearchPage | undefined => {
  const row = record(value)
  const host = str(row?.host) ?? (Predicate.isString(value) ? value : undefined)
  return host ? { host, ...(str(row?.title) ? { title: str(row?.title) } : {}) } : undefined
}

/** The research view from a synthetic message's metadata; undefined when it is not a fold-research notice. */
export const readResearch = (metadata: unknown): ResearchView | undefined => {
  const meta = record(metadata)
  if (meta?.notice !== "fold-research") return undefined
  const r = record(meta.research)
  if (!r) return undefined
  const searches = (Array.isArray(r.searches) ? r.searches : []).flatMap((s) => {
    const row = record(s)
    const q = str(row?.q)
    return q ? [{ q, n: num(row?.n) }] : []
  })
  const read = (Array.isArray(r.read) ? r.read : []).flatMap((p) => page(p) ?? [])
  const reading = page(r.reading)
  return {
    elapsedMs: num(r.elapsedMs),
    searches,
    candidates: num(r.candidates),
    read,
    ...(reading ? { reading } : {}),
    ...(str(r.stop) ? { stop: str(r.stop) } : {}),
    done: r.done === true,
  }
}
