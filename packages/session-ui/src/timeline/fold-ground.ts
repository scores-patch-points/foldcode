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
  profile?: ProfileView
}

/** What an item in the profile rests on: the evidence's own bytes and its address, as the door located them. */
export type ProfileEvidence = { text: string; ref?: string; url?: string; source?: string }

export type ProfileTone = "danger" | "warning" | "success" | "muted"

/** One checkable unit of the answer (a claim or a symbol), as the door judged it. `find` is the text to point at. */
export type ProfileItem = {
  key: string
  tone: ProfileTone
  label: string
  title: string
  find: string
  why?: string
  evidence?: ProfileEvidence
  /** the several source sentences a summary sentence abstracts (many-to-one), as the door located them */
  from: ProfileEvidence[]
  /** the claim's own words the support does not carry */
  residue: string[]
  /** Janus's own finding when arithmetic decided it */
  janus?: string
  searched: string[]
  who?: string
}

export type ProfileView = {
  kind: string
  size: string
  bar: Array<{ n: number; tone: ProfileTone; label: string }>
  rests: Array<{ source: string; n: number }>
  look: ProfileItem[]
  fine: ProfileItem[]
  beings: Array<{ name: string; verdict: string; label?: string; qid?: string; url?: string; basis?: string }>
  researching: boolean
  researchMs?: number
  /** a summary's second reading: what it left out (beings the material speaks of, figures it states, never carried) */
  leftOut?: { beings: Array<{ name: string; mentions: number }>; figures: Array<{ figure: string; text: string; ref?: string }> }
}

// The door's standings, as the panel shows them. A display mapping only: the standing itself is the door's.
const CLAIM = {
  contradicted: { tone: "danger", label: "Contradicted" },
  unsupported: { tone: "warning", label: "Unsupported" },
  supported: { tone: "success", label: "Supported" },
} as const
const SYMBOL = {
  contradicted: { tone: "danger", label: "Contradicted" },
  not_found: { tone: "danger", label: "Not found" },
  unchecked: { tone: "warning", label: "Unchecked" },
  found: { tone: "success", label: "Found" },
} as const

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
  const profile = readProfile(record(step?.profile))
  return {
    rows,
    superseded: str(step?.superseded),
    gap: step ? undefined : (str(ground.gap) ?? "no step this turn"),
    ...(profile ? { profile } : {}),
  }
}

const num = (value: unknown) => (Predicate.isNumber(value) && Number.isFinite(value) ? value : 0)
const list = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.flatMap<Record<string, unknown>>((item: unknown) => record(item) ?? []) : []
const strings = (value: unknown) => (Array.isArray(value) ? value.filter(Predicate.isString) : [])

/** The door's profile (khora opencode-profile.mjs), read once at the boundary into what the panel draws. */
export function readProfile(profile: Record<string, unknown> | undefined): ProfileView | undefined {
  if (!profile || !Array.isArray(profile.claims)) return undefined
  const counts = record(profile.counts) ?? {}
  const claims = list(profile.claims).flatMap<ProfileItem>((claim, i) => {
    const standing = str(claim.standing) ?? ""
    const shown = standing in CLAIM ? CLAIM[standing as keyof typeof CLAIM] : undefined
    const text = str(claim.text)
    if (!shown || !text) return []
    const identity = record(claim.identity)
    return [
      {
        key: `c${i}`,
        tone: shown.tone,
        label: claim.derived === true ? "Derived" : claim.added === true ? "Added" : shown.label,
        title: text,
        find: text,
        why: str(claim.why),
        evidence: evidenceOf(claim.evidence),
        from: list(claim.from).flatMap((item) => evidenceOf(item) ?? []),
        residue: strings(claim.residue),
        janus: str(record(claim.janus)?.finding),
        searched: strings(claim.searched),
        who: identity ? `${str(identity.label) ?? ""} (${str(identity.qid) ?? ""})` : undefined,
      },
    ]
  })
  const symbols = list(profile.symbols).flatMap<ProfileItem>((symbol, i) => {
    const standing = str(symbol.standing) ?? ""
    const shown = standing in SYMBOL ? SYMBOL[standing as keyof typeof SYMBOL] : undefined
    const name = str(symbol.name)
    if (!shown || !name) return []
    const of = str(symbol.of)
    return [
      {
        key: `s${i}`,
        tone: shown.tone,
        label: shown.label,
        title: of ? `${name} (option of ${of})` : `${name}${str(symbol.kind) === "path" ? "" : ` · ${str(symbol.kind) ?? "symbol"}`}`,
        find: name,
        why: str(symbol.why),
        evidence: evidenceOf(symbol.evidence),
        from: [],
        residue: [],
        searched: strings(symbol.searched),
      },
    ]
  })
  const items = [...claims, ...symbols]
  const research = record(profile.research)
  const code = num(profile.codeLines)
  return {
    kind: str(profile.kind) ?? "answer",
    size: [
      num(profile.words) ? `${num(profile.words)} words` : "",
      code ? `${code} code line${code === 1 ? "" : "s"}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    bar: [
      { n: num(counts.supported) + num(counts.found), tone: "success" as const, label: "checks out" },
      { n: num(counts.contradicted) + num(counts.symbol_contradicted) + num(counts.not_found), tone: "danger" as const, label: "contradicted or not found" },
      { n: num(counts.unsupported) + num(counts.unchecked), tone: "warning" as const, label: "unsupported" },
      { n: num(counts.argument), tone: "muted" as const, label: "argument (not checked)" },
    ].filter((part) => part.n > 0),
    rests: list(profile.rests).flatMap((row) => (str(row.source) ? [{ source: str(row.source)!, n: num(row.n) }] : [])),
    look: items.filter((item) => item.tone === "danger" || item.tone === "warning"),
    fine: items.filter((item) => item.tone === "success"),
    beings: list(profile.beings).flatMap((being) =>
      str(being.name)
        ? [
            {
              name: str(being.name)!,
              verdict: str(being.verdict) ?? "?",
              label: str(being.label),
              qid: str(being.qid),
              url: str(being.url),
              basis: str(being.basis),
            },
          ]
        : [],
    ),
    researching: research?.on === false && num(research.pending) > 0,
    researchMs: research?.on === true ? num(research.ms) : undefined,
    leftOut: readLeftOut(record(record(profile.summary)?.leftOut)),
  }
}

function readLeftOut(value: Record<string, unknown> | undefined): ProfileView["leftOut"] {
  if (!value) return undefined
  const beings = list(value.beings).flatMap((being) => (str(being.name) ? [{ name: str(being.name)!, mentions: num(being.mentions) }] : []))
  const figures = list(value.figures).flatMap((figure) =>
    str(figure.figure) ? [{ figure: str(figure.figure)!, text: str(figure.text) ?? "", ref: str(figure.ref) }] : [],
  )
  return beings.length || figures.length ? { beings, figures } : undefined
}

function evidenceOf(value: unknown): ProfileEvidence | undefined {
  const evidence = record(value)
  const text = str(evidence?.text)
  if (!evidence || !text) return undefined
  return { text, ref: str(evidence.ref), url: str(evidence.url), source: str(evidence.source) }
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
