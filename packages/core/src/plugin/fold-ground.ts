// THE GROUND, as data for the window. The door computes it (finish: each sentence typed against the material,
// the draw a mechanism outweighed kept as `superseded`); this only carries it, unchanged, onto the notice's
// metadata so the timeline can render it on the answer. Nothing here grounds, scores or rewrites a sentence.
export type GroundSentence = {
  text: string
  standing: string
  ref?: string
  fact?: string
  beings?: string[]
  source?: string
  // the passage sentences it rests on, located by the door (verbatim)
  sources?: Array<{ passage: string; text: string }>
}

export type GroundPayload = {
  v: 1
  // the door's `step`; null with `gap` when the door produced none this turn (budget, first load, door down)
  step: { output?: string; superseded?: string | null; grounded: GroundSentence[]; profile?: Profile } | null
  gap?: string
}

/** The door's profile of the answer (khora opencode-profile.mjs): carried as given, never computed here. */
export type Profile = {
  v: 2
  kind: string
  words?: number
  sentences?: number
  codeLines?: number
  counts: Record<string, number>
  claims: Array<Record<string, unknown>>
  symbols: Array<Record<string, unknown>>
  rests?: Array<{ source: string; n: number }>
  beings?: Array<Record<string, unknown>>
  research?: { on: boolean; pending?: number; ms?: number; log?: Array<Record<string, unknown>> }
  // the door's REC pairs: each revised sentence and the sentence of this answer that now stands for it (null when none does)
  revises?: Array<{ was: string; now: string | null; standing?: string | null }>
}

type Answer = {
  sentences?: Array<unknown>
  step?: { output?: string; superseded?: string | null; grounded?: GroundSentence[]; profile?: Profile }
}

/** The facing's person-notice text for a native render. It leads with a notice prefix so it never reaches the model. */
export const groundHead = (payload: GroundPayload) => {
  const profile = payload.step?.profile
  if (profile) {
    const parts = [
      [profile.counts.supported, "supported"],
      [profile.counts.contradicted, "contradicted"],
      [profile.counts.unsupported, "unsupported"],
      [profile.counts.not_found, "symbol(s) not found"],
      [profile.counts.symbol_contradicted, "symbol(s) contradicted"],
    ].flatMap(([n, label]) => (n ? [`${n} ${label}`] : []))
    const researching = profile.research?.on === false && (profile.research.pending ?? 0) > 0 ? " · researching" : ""
    return `fold facing · the profile · ${profile.kind} · ${parts.join(" · ") || "nothing checkable"}${researching}`
  }
  const rows = payload.step?.grounded ?? []
  const identity = rows.filter((s) => s.standing === "grounded" && !s.ref && !s.fact).length
  const grounded = rows.filter((s) => s.standing === "grounded").length - identity
  return payload.step
    ? `fold facing · the ground · ${grounded} grounded · ${identity} identity-only · ${rows.length - grounded - identity} self:model`
    : `fold facing · the ground · no step this turn`
}

/** The payload for a door `ground` answer; undefined when there is nothing to show or the facing is off. */
export const groundPayload = (
  answer: Record<string, unknown> | undefined,
  level: string,
): GroundPayload | undefined => {
  if (level === "off") return undefined
  // The door gave no answer (budget, first load, down): a typed gap on the answer, never an invented ground.
  if (!answer) return { v: 1, step: null, gap: "no step this turn" }
  const a = answer as Answer
  if (!a.step && !(Array.isArray(a.sentences) && a.sentences.length > 0)) return undefined
  return a.step
    ? {
        v: 1,
        step: {
          output: a.step.output,
          superseded: a.step.superseded ?? null,
          grounded: a.step.grounded ?? [],
          ...(a.step.profile ? { profile: a.step.profile } : {}),
        },
      }
    : { v: 1, step: null, gap: "no step this turn" }
}

// The app's fold note asks for a sentence to be revised; the composer formats every note as "The user made the following comment
// regarding <subject>: <comment>", and the fold's subject is the sentence in curly quotes.
const REVISE_NOTE = /regarding \u201C([^\u201D]+)\u201D: ([^\n]*?)Revise this sentence so it is correct/g
const NOTE_SOURCE = /says: \u201C([^\u201D]+)\u201D/

/** A sentence to revise, and the source sentence it was found against (the correction is expected to rest on it). */
export type Revise = { was: string; against?: string }

/** The sentences a prompt asks the fold to revise, in order, each with the source sentence the note quotes. */
export const revisedIn = (ask: string): Revise[] =>
  [...ask.matchAll(REVISE_NOTE)].map((match) => {
    const against = NOTE_SOURCE.exec(match[2])?.[1]
    return against ? { was: match[1], against } : { was: match[1] }
  })

/** A read tool's result opens with a header line naming the file; the file is the passage, the header is its name. */
const readHeader = /^Read file (.+?), lines (\d+)-\d+\n/

/** The turn's material as labelled passages (tool name, or the file a read named, + its result text), newest kept,
 *  within a byte budget, so the door can ground against them and a source proposition can say where it was found. */
export const gatherPassages = (chunks: Array<{ name: string; text: string }>, budget = 64_000) => {
  const out: Array<{ name: string; text: string }> = []
  let used = 0
  for (let i = chunks.length - 1; i >= 0 && used < budget; i--) {
    const header = readHeader.exec(chunks[i].text)
    const name = header ? header[1] : chunks[i].name
    // A read's lines carry their numbers ("12: text"): the number is the address, not the content. Stripped one line for
    // one line, and a page that starts past line 1 is padded to its first line, so a falsifier never reads a line number
    // as a count and the door's file:line refs are the file's own.
    const text = (
      header
        ? "\n".repeat(Number(header[2]) - 1) + chunks[i].text.slice(header[0].length).replace(/^ *\d+[:|] ?/gm, "")
        : chunks[i].text
    ).slice(0, budget - used)
    out.unshift({ name, text })
    used += text.length
  }
  return out
}

/** What the model is told BEFORE it answers, in facts: how its sentences are checked and what makes one supported. Positive
 *  statements only (a prohibition in text handed to a small model trips its safety gate). */
export const GROUND_LEGEND = [
  "# How your sentences are checked",
  "After you answer, each sentence of your answer is typed against what can be read: this turn's tool results (read, grep, fetch),",
  "the workspace, Wikipedia and Wikidata. The person sees every sentence marked supported (with the source's own sentence and its",
  "address), contradicted (with what the source says instead), or unsupported (nothing read states it). Dates, counts, names and",
  "figures are checked hardest.",
  "A sentence is supported when a source read this turn states it. A sentence from memory is shown as unsupported until a source",
  "states it. When a question has a checkable answer, reading or looking it up first and then writing what the source says gives the",
  "person sentences marked supported, each with its source. A sentence that comes from memory can say so.",
].join("\n")

/** The head of the grounding note, so the plugin can tell an answer to a steer from an answer to the person. */
export const GROUND_STEER_HEAD = "Grounding check of your last answer"

const clip = (value: unknown, max = 200) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "")
const field = (row: Record<string, unknown>, key: string) => {
  const value = row[key]
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** The door's finding, handed back to the model as facts: what a source contradicts (with the source's own text), the symbols that do
 *  not match what was read, and the figures that rest on nothing read. undefined when the check found nothing worth a second look.
 *  Mechanical: every line is the door's payload; the model is told, never graded by itself. */
export const groundSteer = (profile: Profile | undefined): string | undefined => {
  if (!profile) return undefined
  const contradicted = profile.claims.filter((c) => c.standing === "contradicted" && clip(c.text))
  const symbols = profile.symbols.filter((c) => (c.standing === "contradicted" || c.standing === "not_found") && clip(c.name))
  const bare = profile.claims.filter((c) => (c.standing === "unsupported" || c.added === true) && /\d/.test(clip(c.text)) && clip(c.text))
  if (contradicted.length + symbols.length === 0 && bare.length < 2) return undefined
  const lines: string[] = [
    `${GROUND_STEER_HEAD} (mechanical: this turn's reads, the workspace, Wikipedia and Wikidata). The person sees these marks on it.`,
  ]
  if (contradicted.length) {
    lines.push("Contradicted by a source:")
    for (const c of contradicted.slice(0, 4)) {
      const evidence = field(c, "evidence")
      lines.push(
        `- "${clip(c.text)}" — ${clip(c.why) || "a source states otherwise"}${evidence ? `; ${clip(evidence.source, 80)} says: "${clip(evidence.text, 220)}"${clip(evidence.ref, 60) ? ` (${clip(evidence.ref, 60)})` : ""}` : ""}`,
      )
    }
  }
  if (symbols.length) {
    lines.push("Names that differ from what was read:")
    for (const c of symbols.slice(0, 3)) lines.push(`- \`${clip(c.name, 80)}\` — ${clip(c.why) || "no definition in what was read"}`)
  }
  if (bare.length) {
    lines.push("Resting on nothing read this turn:")
    for (const c of bare.slice(0, 4)) lines.push(`- "${clip(c.text)}"`)
  }
  lines.push(
    "A sentence becomes supported when a source you have read states it. Reading the source for the sentences above and restating them in what it says gives the person a corrected answer with its sources; a sentence that stays from memory can say so.",
  )
  return lines.join("\n")
}

/** The answer as it is graded: citation markup is provenance, not a claim. Footnote markers ([^1^], [1]) and the footnote lines they
 *  point to, and file:line tags ([curie.md:7], [src/a.ts:12-14]), would otherwise be graded as sentences — and a tag after a full stop
 *  glues the next sentence onto the one before it. A markdown link ([text](url)) is left alone. */
export const withoutCitations = (text: string) =>
  text
    .replace(/^[ \t]*\[\^[^\]\s]{1,12}\]:.*$/gm, "")
    .replace(/\s?\[\^[^\]\s]{1,12}\](?!:)/g, "")
    .replace(/\s?\[\d{1,2}\](?!\()/g, "")
    .replace(/\s?\[[\w./@-]+\.\w{1,8}(?::\d+(?:[-–]\d+)?)?\](?![(:])/g, "")

/** The revised sentences the door paired with a sentence of this answer (its REC pairs that found a successor). */
export const pairedIn = (profile: Profile | undefined) =>
  (profile?.revises ?? []).flatMap((pair) => (pair.now ? [pair.was] : []))

/** The answer's sentences a source contradicted: the ones its hand-back asks the model to restate, recorded as revisions. */
export const contradictedIn = (profile: Profile | undefined): Revise[] =>
  (profile?.claims ?? []).flatMap((c) => {
    if (c.standing !== "contradicted" || typeof c.text !== "string" || !c.text) return []
    const against = field(c, "evidence")?.text
    return [typeof against === "string" && against ? { was: c.text, against } : { was: c.text }]
  })

/** Is the check's finding handed back to the model? Not when there is nothing to say, a note is already outstanding, a gather answered the ask,
 *  the turn already used tools (a hand-back restores them: measured 86 more requests, 832k tokens, on a 2.9k-token answer), or this ask was already steered once.
 *  Never for the reply to a hand-back. A contradicted sentence is the exception to the tools rule: the source's words ride the note, so the model can restate it without reading again. */
export const shouldHandBack = (s: {
  note: string | undefined
  outstanding: boolean
  gathered: boolean
  toolResults: number
  steeredAsk: string | undefined
  ask: string
  contradicted?: number
}): boolean =>
  Boolean(s.note) &&
  !s.outstanding &&
  !s.gathered &&
  (s.toolResults === 0 || (s.contradicted ?? 0) > 0) &&
  s.steeredAsk !== s.ask &&
  // a hand-back's own reply is never handed back: one round per ask, however many texts the reply comes in
  !s.ask.startsWith(GROUND_STEER_HEAD)
