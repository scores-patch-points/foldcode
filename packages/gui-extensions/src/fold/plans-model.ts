// The stigmergic work plans, as data. The door reads ~/.fold/worknotes and serves it at
// GET /v1/hooks/opencode/plans; each task is one plan: the marks its agents left, what is claimed and what is
// finished, and each agent's settled turns exactly as kept (reasoning included, never erased).

export type Mark = { t: number; agent: string; kind: "fact" | "claim" | "done" | "block"; text: string }
export type PlanTurn = { agent: string; n: number; ask: string; tools: ReadonlyArray<string>; text: string }
export type Plan = {
  task: string
  updated: number
  marks: ReadonlyArray<Mark>
  open: ReadonlyArray<{ item: string; agent: string; since: number }>
  finished: ReadonlyArray<{ item: string; agent: string }>
  turns: ReadonlyArray<PlanTurn>
}

export const KIND_GLYPH: Record<Mark["kind"], string> = { fact: "●", claim: "○", done: "✓", block: "✗" }
export const KIND_WORD: Record<Mark["kind"], string> = { fact: "fact", claim: "claimed", done: "done", block: "blocked" }

/** A plan's short name: its first ask, else its id. */
export function titleOf(plan: Plan): string {
  const ask = plan.turns.find((turn) => turn.ask.trim())?.ask.trim().replace(/\s+/g, " ")
  if (!ask) return plan.task
  return ask.length > 64 ? `${ask.slice(0, 63)}…` : ask
}

/** Plans in the order to show: the session's own first, then the rest by recency. */
export function order(plans: ReadonlyArray<Plan>, current?: string): Plan[] {
  return [...plans].sort((a, b) => Number(b.task === current) - Number(a.task === current) || b.updated - a.updated)
}

export function counts(plan: Plan): { fact: number; claim: number; done: number; block: number } {
  const out = { fact: 0, claim: 0, done: 0, block: 0 }
  for (const mark of plan.marks) out[mark.kind]++
  return out
}

export function ago(from: number, now: number): string {
  const secs = Math.max(0, Math.round((now - from) / 1000))
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}
