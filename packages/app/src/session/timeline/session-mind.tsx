import { createMemo, For } from "solid-js"

// The mind: what the model is doing right now, in words, while a turn runs.
// The shimmering "Working" label says only that something is happening; this says
// what, keeps the earlier stages visible, announces each change once, and does
// not rely on motion or colour (the current stage is marked by text and
// aria-current, the pulse is dropped under prefers-reduced-motion).

export type MindStage = "thinking" | "reading" | "acting" | "running" | "looking" | "writing"

const STAGES: ReadonlyArray<{ id: MindStage; label: string; doing: string }> = [
  { id: "thinking", label: "Thinking", doing: "Thinking it through" },
  { id: "reading", label: "Reading", doing: "Reading the code" },
  { id: "looking", label: "Looking up", doing: "Looking something up" },
  { id: "acting", label: "Editing", doing: "Making changes" },
  { id: "running", label: "Running", doing: "Running a command" },
  { id: "writing", label: "Writing", doing: "Writing the reply" },
]

const READING = new Set(["read", "grep", "glob", "list", "ls", "search", "codesearch"])
const ACTING = new Set(["edit", "write", "patch", "apply_patch", "multiedit"])
const RUNNING = new Set(["bash", "shell", "task_shell"])
const LOOKING = new Set(["webfetch", "websearch", "fetch"])

export function stageOf(content: { type?: string; name?: string } | undefined): MindStage {
  if (!content) return "thinking"
  if (content.type === "text") return "writing"
  if (content.type === "reasoning") return "thinking"
  if (content.type !== "tool") return "thinking"
  const name = (content.name ?? "").toLowerCase()
  if (READING.has(name)) return "reading"
  if (ACTING.has(name)) return "acting"
  if (RUNNING.has(name)) return "running"
  if (LOOKING.has(name)) return "looking"
  return "thinking"
}

export function SessionMind(props: { content: { type?: string; name?: string } | undefined; steps: number }) {
  const stage = createMemo(() => stageOf(props.content))
  const doing = createMemo(() => STAGES.find((item) => item.id === stage())?.doing ?? "Working")
  const detail = createMemo(() => {
    const name = props.content?.type === "tool" ? props.content.name : undefined
    const unknown = stage() === "thinking" && name
    return unknown ? ` (${name})` : ""
  })
  return (
    <div data-component="session-mind" class="flex min-w-0 flex-col gap-1 text-text-base">
      <div role="status" aria-live="polite" aria-atomic="true" class="text-[13px] font-[530]">
        {doing()}
        {detail()}
        {props.steps > 0 ? ` · step ${props.steps}` : ""}
      </div>
      <ol class="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-[12px]" aria-label="Stages of the work">
        <For each={STAGES}>
          {(item) => (
            <li
              aria-current={item.id === stage() ? "step" : undefined}
              class="rounded-sm px-1"
              classList={{
                "font-semibold underline underline-offset-4 decoration-2": item.id === stage(),
                "opacity-60": item.id !== stage(),
              }}
            >
              <span aria-hidden="true">{item.id === stage() ? "▸ " : ""}</span>
              {item.label}
              <span class="sr-only">{item.id === stage() ? " (current)" : ""}</span>
            </li>
          )}
        </For>
      </ol>
    </div>
  )
}
