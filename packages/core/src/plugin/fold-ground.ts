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
