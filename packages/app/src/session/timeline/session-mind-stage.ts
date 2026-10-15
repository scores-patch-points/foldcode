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
