// The mapping from what the model does to the nine operators (see session-mind.tsx). Plain TypeScript, no JSX, so it is testable alone.

// The nine operators of the algebra, in order. The mind's stages ARE these: whatever the model does is
// read as one of them, so every turn is the same nine-slot shape and a slot that never fired is visible
// as empty. The mapping from tool actions to operators is the one table below (OPERATOR_OF); change it
// there and the whole panel follows.
export type MindStage = "NUL" | "SIG" | "INS" | "SEG" | "CON" | "SYN" | "DEF" | "EVA" | "REC"

export const STAGES: ReadonlyArray<{ id: MindStage; glyph: string; label: string; doing: string }> = [
  { id: "NUL", glyph: "∅", label: "Hold", doing: "Holding — thinking it through" },
  { id: "SIG", glyph: "○", label: "Notice", doing: "Noticing — looking for what is there" },
  { id: "INS", glyph: "●", label: "Mint", doing: "Minting — taking a specific thing in" },
  { id: "SEG", glyph: "｜", label: "Segment", doing: "Segmenting — cutting the work into units" },
  { id: "CON", glyph: "⋈", label: "Bond", doing: "Bonding — relating things to each other" },
  { id: "SYN", glyph: "△", label: "Compose", doing: "Composing — making the change" },
  { id: "DEF", glyph: "⊢", label: "Define", doing: "Defining — stating what must hold" },
  { id: "EVA", glyph: "⊨", label: "Evaluate", doing: "Evaluating — checking it" },
  { id: "REC", glyph: "◉", label: "Reframe", doing: "Reframing — changing approach after a miss" },
]

/** Tool name -> operator. Anything not listed is held (NUL). */
const OPERATOR_OF: Record<string, MindStage> = {
  glob: "SIG", list: "SIG", ls: "SIG", grep: "SIG", search: "SIG", websearch: "SIG",
  read: "INS", webfetch: "INS", fetch: "INS",
  task: "SEG", subagent: "SEG", batch: "SEG",
  lsp: "CON", codesearch: "CON",
  edit: "SYN", write: "SYN", patch: "SYN", apply_patch: "SYN", multiedit: "SYN",
  todowrite: "DEF", todoread: "DEF", question: "DEF", plan: "DEF",
}
const VERIFY = /\b(test|tests|vitest|jest|pytest|tsc|typecheck|lint|oxlint|eslint|build|check|cargo (test|check|build)|go (test|vet|build))\b/
const LOOKS = /^\s*(ls|cat|head|tail|pwd|find|rg|grep|git (status|log|diff|show|branch)|which|echo|wc|stat)\b/
const SHELL = new Set(["bash", "shell", "task_shell"])

export type Kind = { type?: string; name?: string; state?: { status?: string; input?: unknown } }

/** Which operator one part of the turn is. `previous` lets a step that follows a failure read as a reframe. */
export function stageOf(content: Kind | undefined, previous?: Kind): MindStage {
  if (!content) return "NUL"
  if (previous?.type === "tool" && previous.state?.status === "error") return "REC"
  if (content.type === "text") return "SYN"
  if (content.type === "reasoning") return "NUL"
  if (content.type !== "tool") return "NUL"
  const name = (content.name ?? "").toLowerCase()
  if (SHELL.has(name)) {
    const input = content.state?.input as { command?: unknown } | undefined
    const command = typeof input?.command === "string" ? input.command : ""
    if (VERIFY.test(command)) return "EVA"
    if (LOOKS.test(command)) return "SIG"
    return "SYN"
  }
  return OPERATOR_OF[name] ?? "NUL"
}

export type Part = {
  type?: string
  name?: string
  text?: string
  state?: { status?: string; input?: unknown; error?: unknown }
  time?: { created?: number; completed?: number }
}

const TARGET_KEYS = ["filePath", "path", "pattern", "command", "url", "query", "description", "prompt"]

const inputOf = (part: Part | undefined): Record<string, unknown> => {
  const input = part?.state?.input
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {}
}

/** What a tool is acting on, in full: a file, a pattern, a command. Empty when the part names nothing. */
export function whereOf(part: Part | undefined): string {
  const input = inputOf(part)
  for (const key of TARGET_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ")
  }
  return ""
}

/** Which part of the target: a line range when the tool was given one. */
export function rangeOf(part: Part | undefined): string {
  const input = inputOf(part)
  const offset = typeof input.offset === "number" ? input.offset : typeof input.line === "number" ? input.line : undefined
  const limit = typeof input.limit === "number" ? input.limit : undefined
  if (offset !== undefined && limit !== undefined) return `lines ${offset}–${offset + limit - 1}`
  if (offset !== undefined) return `from line ${offset}`
  if (limit !== undefined) return `first ${limit} lines`
  return ""
}

/** Back-compat short form used by the trail: the target, clipped. */
export function targetOf(part: Part | undefined): string {
  const one = whereOf(part)
  return one.length > 70 ? `${one.slice(0, 69)}…` : one
}

export const mark = (part: Part) => (part.state?.status === "error" ? "✗" : part.state?.status === "completed" ? "✓" : "…")
export const markWord = (part: Part) =>
  part.state?.status === "error" ? "failed" : part.state?.status === "completed" ? "done" : "in progress"

export type Target = { key: string; where: string; range: string; steps: Array<{ part: Part; stage: MindStage }> }

/** The turn's parts grouped by what they act on. A part that names nothing (thinking, writing) belongs to
 *  the target before it, so each target carries its own walk through the operators. */
export function targetsOf(parts: ReadonlyArray<Part>): Target[] {
  const out: Target[] = []
  let current: Target | undefined
  parts.forEach((part, i) => {
    const stage = stageOf(part, parts[i - 1])
    const where = part.type === "tool" ? whereOf(part) : ""
    if (where && (!current || current.where !== where)) {
      current = out.find((item) => item.where === where) ?? undefined
      if (!current) {
        current = { key: where, where, range: "", steps: [] }
        out.push(current)
      }
    }
    if (!current) {
      current = { key: "", where: "", range: "", steps: [] }
      out.push(current)
    }
    if (!current.range) current.range = rangeOf(part)
    current.steps.push({ part, stage })
  })
  return out
}

export const indexOf = (id: MindStage) => STAGES.findIndex((item) => item.id === id)

/** How far one target has walked: the furthest operator any of its steps reached. */
export function reachedOf(target: Target): number {
  return target.steps.reduce((at, step) => Math.max(at, step.stage === "REC" ? at : indexOf(step.stage)), -1)
}

/** Targets with a step running right now. Two or more means the work is walking in parallel. */
export function inFlightOf(targets: ReadonlyArray<Target>): Target[] {
  return targets.filter((item) =>
    item.steps.some((step) => step.part.state?.status === "running" || step.part.state?.status === "streaming"),
  )
}
