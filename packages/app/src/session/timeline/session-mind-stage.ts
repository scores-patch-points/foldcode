// The mapping from what the model does to the nine operators (see session-mind.tsx). Plain TypeScript, no JSX, so it is testable alone.

// The nine operators of the algebra, in order. The mind's stages ARE these: whatever the model does is
// read as one of them, so every turn is the same nine-slot shape and a slot that never fired is visible
// as empty. The mapping from tool actions to operators is the one table below (OPERATOR_OF); change it
// there and the whole panel follows.
export type MindStage = "NUL" | "SIG" | "INS" | "SEG" | "CON" | "SYN" | "DEF" | "EVA" | "REC"

export const STAGES: ReadonlyArray<{ id: MindStage; glyph: string; label: string; doing: string }> = [
  { id: "NUL", glyph: "∅", label: "Hold", doing: "Holding — thinking it through" },
  { id: "SIG", glyph: "○", label: "Notice", doing: "Noticing — looking for what is there" },
  { id: "INS", glyph: "●", label: "Name", doing: "Naming — taking a specific thing in" },
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

/** One step on a target. `stage` is the operator the step itself is. `reframed` is true when it came right after a
 *  failure: the walk looped back (REC) and this step begins a new lap. `lap` counts passes from 0. */
export type Step = { part: Part; stage: MindStage; reframed: boolean; lap: number; because?: Part }
export type Target = { key: string; where: string; range: string; steps: Step[]; after?: string }

/** The turn's parts grouped by what they act on. A part that names nothing (thinking, writing) belongs to
 *  the target before it, so each target carries its own walk through the operators. */
export function targetsOf(parts: ReadonlyArray<Part>): Target[] {
  const out: Target[] = []
  let current: Target | undefined
  parts.forEach((part, i) => {
    const stage = stageOf(part)
    const reframed = stageOf(part, parts[i - 1]) === "REC"
    const where = part.type === "tool" ? whereOf(part) : ""
    if (where && (!current || current.where !== where)) {
      current = out.find((item) => item.where === where) ?? undefined
      if (!current) {
        // A walk that begins once another target has settled starts from that result: remember what it follows.
        const settled = [...out].reverse().find((item) => item !== current && settledBy(item))
        current = { key: where, where, range: "", steps: [], after: settled?.where || undefined }
        out.push(current)
      }
    }
    if (!current) {
      current = { key: "", where: "", range: "", steps: [] }
      out.push(current)
    }
    if (!current.range) current.range = rangeOf(part)
    const lap = (current.steps.at(-1)?.lap ?? 0) + (reframed && current.steps.length > 0 ? 1 : 0)
    current.steps.push({ part, stage, reframed: reframed && current.steps.length > 0, lap, because: reframed ? parts[i - 1] : undefined })
  })
  return out
}

export const indexOf = (id: MindStage) => STAGES.findIndex((item) => item.id === id)

/** The pass the target is on now: 0 until it has been reframed. */
export const lapOf = (target: Target): number => target.steps.at(-1)?.lap ?? 0

/** The check that closed this target, if one did: a passing evaluate in the current lap with nothing failing after it.
 *  A settled target has finished its walk; REC then carries its result forward instead of looping back. */
export function settledBy(target: Target): Part | undefined {
  const lap = lapOf(target)
  const at = target.steps.findLastIndex((step) => step.lap === lap && step.stage === "EVA" && step.part.state?.status === "completed")
  if (at < 0) return undefined
  const failedAfter = target.steps.slice(at + 1).some((step) => step.part.state?.status === "error")
  return failedAfter ? undefined : target.steps[at]!.part
}

/** How far one target has walked in its current lap: the furthest operator any of that lap's steps reached. */
export function reachedOf(target: Target): number {
  const lap = lapOf(target)
  return target.steps.reduce((at, step) => (step.lap === lap ? Math.max(at, indexOf(step.stage)) : at), -1)
}

/** Targets with a step running right now. Two or more means the work is walking in parallel. */
export function inFlightOf(targets: ReadonlyArray<Target>): Target[] {
  return targets.filter((item) =>
    item.steps.some((step) => step.part.state?.status === "running" || step.part.state?.status === "streaming"),
  )
}

/** A plain, serializable picture of the turn's work, published for the work-tree panel (which lives in the fold
 *  extension and cannot read the timeline). Targets in order; each has its laps and the steps in them. */
export type MindSnapshot = {
  at: number
  targets: Array<{
    where: string
    range: string
    after?: string
    lap: number
    reached: number
    settled: boolean
    inFlight: boolean
    laps: Array<{
      lap: number
      reached: number
      steps: Array<{ name: string; kind: string; stage: MindStage; status: string; reframed: boolean; error?: string }>
    }>
  }>
}

export function snapshotOf(targets: ReadonlyArray<Target>, now = Date.now()): MindSnapshot {
  const live = new Set(inFlightOf(targets))
  return {
    at: now,
    targets: targets.map((item) => {
      const lap = lapOf(item)
      const laps: MindSnapshot["targets"][number]["laps"] = []
      for (let n = 0; n <= lap; n++) {
        const steps = item.steps.filter((step) => step.lap === n)
        laps.push({
          lap: n,
          reached: steps.reduce((at, step) => Math.max(at, indexOf(step.stage)), -1),
          steps: steps.map((step) => ({
            name: step.part.name ?? step.part.type ?? "step",
            kind: step.part.type ?? "",
            stage: step.stage,
            status: step.part.state?.status ?? "",
            reframed: step.reframed,
            error: step.part.state?.error ? String(step.part.state.error).slice(0, 200) : undefined,
          })),
        })
      }
      return {
        where: item.where,
        range: item.range,
        after: item.after,
        lap,
        reached: reachedOf(item),
        settled: !!settledBy(item),
        inFlight: live.has(item),
        laps,
      }
    }),
  }
}

export const MIND_EVENT = "fold:mind"

/** Hands the snapshot to whoever is drawing the work tree. Same renderer, so a window event is enough. */
export function publishMind(snapshot: MindSnapshot) {
  if (typeof window === "undefined") return
  ;(window as unknown as { __foldMind?: MindSnapshot }).__foldMind = snapshot
  window.dispatchEvent(new CustomEvent(MIND_EVENT, { detail: snapshot }))
}

const words = (value: string) =>
  value
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_.]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase()

const firstSentence = (value: string | undefined, max = 90) => {
  const one = (value ?? "").trim().replace(/\s+/g, " ")
  if (!one) return ""
  const cut = one.split(/(?<=[.!?])\s/)[0] ?? one
  return cut.length > max ? `${cut.slice(0, max - 1)}…` : cut
}

/** What the work is about, in words rather than paths. In order of trust: the todo in progress (the model said so),
 *  the description the model gave the step, its own reasoning, and last a plain reading of the target itself. */
export function conceptOf(target: Target | undefined, all: ReadonlyArray<Part> = []): string {
  if (!target) return ""
  for (let i = all.length - 1; i >= 0; i--) {
    const part = all[i]!
    if (part.type !== "tool" || (part.name ?? "").toLowerCase() !== "todowrite") continue
    const todos = inputOf(part).todos
    if (Array.isArray(todos)) {
      const active = todos.find((item) => item && typeof item === "object" && (item as { status?: unknown }).status === "in_progress") as
        | { content?: unknown }
        | undefined
      if (typeof active?.content === "string" && active.content.trim()) return active.content.trim()
    }
    break
  }
  for (let i = target.steps.length - 1; i >= 0; i--) {
    const input = inputOf(target.steps[i]!.part)
    if (typeof input.description === "string" && input.description.trim()) return input.description.trim()
  }
  for (let i = target.steps.length - 1; i >= 0; i--) {
    const part = target.steps[i]!.part
    if (part.type === "reasoning") {
      const line = firstSentence(part.text)
      if (line) return line
    }
  }
  const where = target.where
  if (!where) return "the task itself"
  if (/^https?:/.test(where)) return `reading ${where.replace(/^https?:\/\//, "").split("/")[0]}`
  if (VERIFY.test(where)) return "checking that it holds"
  if (/[\\/]/.test(where) && !/\s/.test(where)) {
    const parts = where.split(/[\\/]/).filter(Boolean)
    const file = words(parts.at(-1) ?? where)
    const dir = parts.length > 1 ? words(parts.at(-2) ?? "") : ""
    return dir && dir !== file ? `${file} (${dir})` : file
  }
  return `searching for ${where.length > 40 ? `${where.slice(0, 39)}…` : where}`
}

/** Real feedback for the moments with nothing else to show: built only from what is actually on the trace (how much
 *  has been reasoned, how long a tool has run, how long since the last result), never invented progress. */
export function murmurOf(parts: ReadonlyArray<Part>, now: number): string {
  const last = parts.at(-1)
  const since = (from?: number) => (from ? Math.max(0, Math.round((now - from) / 1000)) : 0)
  if (!last) return "waiting for the first move"
  if (last.type === "reasoning") {
    const text = (last.text ?? "").replace(/\s+/g, " ").trim()
    const count = text ? text.split(" ").length : 0
    const tail = text.length > 110 ? `…${text.slice(-110)}` : text
    return tail ? `${tail} · ${count} words so far` : `reasoning · ${since(last.time?.created)}s`
  }
  if (last.type === "text") {
    const count = (last.text ?? "").trim().split(/\s+/).filter(Boolean).length
    return `writing the reply · ${count} words so far`
  }
  const name = last.name ?? "step"
  const status = last.state?.status
  if (status === "running" || status === "streaming") {
    const target = targetOf(last)
    return `${name} running${target ? ` on ${target}` : ""} · ${since(last.time?.created)}s`
  }
  return `deciding what is next · ${since(last.time?.completed ?? last.time?.created)}s since ${name} ${status === "error" ? "failed" : "finished"}`
}
