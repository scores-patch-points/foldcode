// The pure layers model — one model, one meaning. The foldcode app's Layers panel renders from THIS; the same
// shape is what the door's `GET /v1/hooks/opencode/layers` returns. Browser-safe: types, a tag mapping, and two
// fetches. Everything is a projection of the one store, so the grains are views of one record, never rewrites:
//
//   prompt · projection · answer · sources · record
//
// [S# ref] = grounded to a real address; [S# ref·asserted] = a source that is not a witness; [M] = the mouth's
// own prose (no source shares it). The two never mix — that firebreak is the point of the view.

export type Sentence = { text: string; type: string; ref?: string }

export type Layers = {
  task: string
  agent?: string | null
  turn: number | null
  ask: string | null
  prompt: { ref?: string; sha?: string; bytes?: number; model?: string | null; when?: string; body?: string | null; note?: string; gap?: string }
  projection: { note?: string; gap?: string }
  answer: { text: string | null; tools: string[]; sentences: Sentence[]; summary: Record<string, number> | null }
  record: ReadonlyArray<{ stage: string; standing: string; agent: string; unit: string | null; when: number }>
  scents: ReadonlyArray<{ q: string; at: string; passes: number }>
}

/** A sentence's standing, named: it is grounded to an address, asserted, or the mouth's own. */
export type Tag = { label: string; kind: "grounded" | "asserted" | "own"; ref?: string }

export const GRAINS = ["said", "sourced", "prompt", "record"] as const

export type Grain = (typeof GRAINS)[number]

/** The tag a sentence carries: grounded to an address, asserted, or the mouth's own. Never silently grounded. */
export function tagOf(sentence: Sentence): Tag {
  if (sentence.type === "grounded") return { label: `S ${sentence.ref ?? "?"}`, kind: "grounded", ref: sentence.ref }

  if (sentence.type === "asserted") return { label: `S ${sentence.ref ?? "?"}·asserted`, kind: "asserted", ref: sentence.ref }

  return { label: "M", kind: "own" }
}

/** A snip answer from the door: the verbatim bytes and their standing, or a typed gap. */
export type Snipped = { ok: boolean; bytes?: string; gap?: string; standing?: string }

/** Read the five grains for a session's turn from the door. */
export async function readLayers(
  base: string,
  target: { agent: string; workspace?: string },
  signal?: AbortSignal,
): Promise<Layers> {
  const query = new URLSearchParams({ agent: target.agent })

  if (target.workspace) query.set("workspace", target.workspace)

  const response = await fetch(`${base}/v1/hooks/opencode/layers?${query.toString()}`, { signal })

  if (!response.ok) throw new Error(`layers ${response.status}`)

  // SAFETY: the door's /layers route answers exactly Layers; readLayers is the one boundary that calls it.
  return (await response.json()) as Layers
}

/** Resolve one address to its verbatim bytes, at a stated standing. A gap is returned as-is, never guessed. */
export async function resolveSource(base: string, body: { task: string; agent: string; ref: string }): Promise<Snipped> {
  const response = await fetch(`${base}/v1/hooks/opencode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event: "snip", ...body }),
  })

  if (!response.ok) return { ok: false, gap: `snip ${response.status}` }

  // SAFETY: the door's snip route answers Snipped ({ ok, bytes?, gap?, standing? }); a wrong shape is a failed read.
  return (await response.json()) as Snipped
}
