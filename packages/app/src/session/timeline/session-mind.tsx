import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { STAGES, stageOf, type MindStage } from "./session-mind-stage"

// The mind: what the model is doing right now, in words, while a turn runs.
// The shimmering "Working" label says only that something is happening; this says
// what, keeps the earlier stages visible, announces each change once, and does
// not rely on motion or colour (the current stage is marked by text and
// aria-current, the pulse is dropped under prefers-reduced-motion).

type Part = {
  type?: string
  name?: string
  text?: string
  state?: { status?: string; input?: unknown; error?: unknown }
  time?: { created?: number; completed?: number }
}

const TARGET_KEYS = ["filePath", "path", "pattern", "command", "url", "query", "description", "prompt"]

/** The thing a tool is acting on, in a few words: a file, a pattern, a command. */
export function targetOf(part: Part | undefined): string {
  const input = part?.state?.input
  if (!input || typeof input !== "object") return ""
  for (const key of TARGET_KEYS) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === "string" && value.trim()) {
      const one = value.trim().replace(/\s+/g, " ")
      return one.length > 70 ? `${one.slice(0, 69)}…` : one
    }
  }
  return ""
}

const mark = (part: Part) => (part.state?.status === "error" ? "✗" : part.state?.status === "completed" ? "✓" : "…")
const markWord = (part: Part) =>
  part.state?.status === "error" ? "failed" : part.state?.status === "completed" ? "done" : "in progress"

export function SessionMind(props: { parts?: ReadonlyArray<Part | undefined>; startedAt?: number }) {
  const [now, setNow] = createSignal(Date.now())
  const [open, setOpen] = createSignal<MindStage | undefined>()
  const tick = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(tick))

  const parts = createMemo((): ReadonlyArray<Part> => (props.parts ?? []).filter((part): part is Part => !!part))
  const stageAt = (i: number) => stageOf(parts()[i], parts()[i - 1])
  const last = createMemo(() => parts().at(-1))
  const stage = createMemo(() => (parts().length ? stageAt(parts().length - 1) : "NUL"))
  const tools = createMemo(() => parts().filter((part) => part.type === "tool"))
  const visits = createMemo(() => {
    const counts = new Map<MindStage, number>()
    parts().forEach((_, i) => counts.set(stageAt(i), (counts.get(stageAt(i)) ?? 0) + 1))
    return counts
  })
  // Everything walks the operators in order. The furthest one reached is where the work is on the path; any
  // earlier one never visited was stepped over. REC is the loop back, so it never counts as a skip.
  const furthest = createMemo(() => {
    let at = -1
    STAGES.forEach((item, i) => {
      if (item.id !== "REC" && (visits().get(item.id) ?? 0) > 0) at = i
    })
    return at
  })
  const skipped = createMemo(() => STAGES.filter((item, i) => i < furthest() && item.id !== "REC" && !(visits().get(item.id) ?? 0)))
  const doing = createMemo(() => STAGES.find((item) => item.id === stage())?.doing ?? "Working")
  const target = createMemo(() => targetOf(last()))
  const seconds = (from?: number) => (from ? Math.max(0, Math.round((now() - from) / 1000)) : 0)
  const total = createMemo(() => seconds(props.startedAt ?? parts()[0]?.time?.created))
  const recent = createMemo(() => tools().slice(-4).reverse())
  const inStage = (id: MindStage) => parts().filter((_, i) => stageAt(i) === id)
  const clip = (value: string | undefined, max = 240) => {
    const one = (value ?? "").trim().replace(/\s+/g, " ")
    return one.length > max ? `${one.slice(0, max - 1)}…` : one
  }
  const took = (part: Part) => {
    const from = part.time?.created
    if (!from) return ""
    const end = part.time?.completed ?? (part.state?.status === "running" || part.state?.status === "streaming" ? now() : undefined)
    return end ? `${Math.max(0, Math.round((end - from) / 1000))}s` : ""
  }
  const unnamed = createMemo(() => (last()?.type === "tool" && last()?.name ? ` (${last()?.name})` : ""))

  return (
    <div data-component="session-mind" class="flex min-w-0 flex-col gap-1.5">
      <div role="status" aria-live="polite" aria-atomic="true" class="text-[13px] font-[530]">
        {doing()}
        {unnamed()}
        {target() ? `: ${target()}` : ""}
      </div>
      <div class="text-[12px] opacity-70" aria-hidden="true">
        {(tools()?.length ?? 0) > 0 ? `step ${tools().length}` : "starting"} · {total()}s elapsed
        {last()?.type === "tool" && last()?.time?.created ? ` · this step ${seconds(last()?.time?.created)}s` : ""}
      </div>
      <ol class="m-0 grid max-w-md list-none grid-cols-3 gap-1 p-0 text-[12px]" aria-label="The nine operators">
        <For each={STAGES}>
          {(item) => {
            const n = () => visits().get(item.id) ?? 0
            const skip = () => skipped().some((x) => x.id === item.id)
            return (
              <li
                aria-current={item.id === stage() ? "step" : undefined}
                class="rounded-sm"
                classList={{
                  "font-semibold": item.id === stage(),
                  "opacity-60": item.id !== stage() && n() === 0,
                }}
              >
                <button
                  type="button"
                  disabled={n() === 0}
                  aria-expanded={open() === item.id}
                  aria-controls={`mind-${item.id}`}
                  class="w-full cursor-pointer rounded-md border border-black/10 px-2 py-1.5 text-start hover:bg-black/5 disabled:cursor-default disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2"
                  classList={{
                    "underline underline-offset-4 decoration-2": item.id === stage() || open() === item.id,
                  }}
                  onClick={() => setOpen(open() === item.id ? undefined : item.id)}
                >
                  <span aria-hidden="true">{item.id === stage() ? "▸ " : n() > 0 ? "✓ " : ""}{item.glyph} </span>
                  {item.label}
                  {n() > 1 ? <span class="opacity-70"> ×{n()}</span> : null}
                  {skip() ? <span class="block text-[11px] opacity-70">skipped</span> : null}
                  <span class="sr-only">
                    {skip() ? " (skipped — a later step was reached without it)" : ""}
                    {item.id === stage() ? " (current)" : n() > 0 ? ` (done${n() > 1 ? `, ${n()} times` : ""})` : ""}
                    {n() > 0 ? ", press to show what happened" : ""}
                  </span>
                </button>
              </li>
            )
          }}
        </For>
      </ol>
      <Show when={skipped().length > 0}>
        <div class="text-[12px] opacity-80">
          Stepped over so far: {skipped().map((item) => item.label).join(", ")}. The path runs in order, so these are gaps.
        </div>
      </Show>
      <Show when={open()}>
        {(id) => (
          <div
            id={`mind-${id()}`}
            class="max-h-60 overflow-auto rounded-md border border-black/10 p-2 text-[12px]"
            role="region"
            aria-label={`${STAGES.find((item) => item.id === id())?.label} steps`}
          >
            <For each={inStage(id())} fallback={<div class="opacity-70">Nothing here yet.</div>}>
              {(part, index) => (
                <div class="flex min-w-0 flex-col gap-0.5 py-1" classList={{ "border-t border-black/10": index() > 0 }}>
                  <div class="flex min-w-0 gap-2">
                    <span aria-hidden="true">{part.type === "tool" ? mark(part) : "•"}</span>
                    <span class="font-[530]">
                      {part.type === "tool" ? part.name : part.type === "text" ? "wrote" : "thought"}
                    </span>
                    <span class="min-w-0 truncate opacity-70">{targetOf(part)}</span>
                    <span class="ms-auto shrink-0 opacity-70">
                      {part.type === "tool" ? `${markWord(part)} ${took(part)}`.trim() : ""}
                    </span>
                  </div>
                  <Show when={part.type !== "tool" && clip(part.text)}>
                    <div class="whitespace-pre-wrap opacity-80">{clip(part.text)}</div>
                  </Show>
                  <Show when={part.state?.status === "error" && part.state?.error}>
                    <div class="whitespace-pre-wrap">{clip(String(part.state?.error))}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
      <Show when={(recent()?.length ?? 0) > 0}>
        <ul class="m-0 flex list-none flex-col gap-0.5 p-0 text-[12px]" aria-label="Recent steps">
          <For each={recent()}>
            {(part) => (
              <li class="min-w-0 truncate">
                <span aria-hidden="true">{mark(part)} </span>
                <span class="sr-only">{markWord(part)}: </span>
                <span class="font-[530]">{part.name}</span>
                {targetOf(part) ? <span class="opacity-70"> {targetOf(part)}</span> : null}
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
