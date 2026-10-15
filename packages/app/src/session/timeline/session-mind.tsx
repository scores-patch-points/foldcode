import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import {
  indexOf,
  mark,
  markWord,
  rangeOf,
  reachedOf,
  STAGES,
  targetsOf,
  type MindStage,
  type Part,
  type Target,
} from "./session-mind-stage"

// The mind: what the model is doing right now, in words, while a turn runs.
// The shimmering "Working" label says only that something is happening; this says
// what, keeps the earlier stages visible, announces each change once, and does
// not rely on motion or colour (the current stage is marked by text and
// aria-current, the pulse is dropped under prefers-reduced-motion).

export function SessionMind(props: { parts?: ReadonlyArray<Part | undefined>; startedAt?: number }) {
  const [now, setNow] = createSignal(Date.now())
  const [pickedKey, setPickedKey] = createSignal<string | undefined>()
  const [open, setOpen] = createSignal<MindStage | undefined>()
  const tick = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(tick))

  const parts = createMemo((): ReadonlyArray<Part> => (props.parts ?? []).filter((part): part is Part => !!part))
  const targets = createMemo(() => targetsOf(parts()))
  // Follow the target the work is on now, unless one was picked from the list.
  const shown = createMemo(() => targets().find((item) => item.key === pickedKey()) ?? targets().at(-1))
  const steps = createMemo(() => shown()?.steps ?? [])
  const isLive = createMemo(() => shown() === targets().at(-1))
  const here = createMemo(() => steps().at(-1)?.stage ?? "NUL")
  const reached = createMemo(() => (shown() ? Math.max(reachedOf(shown()!), indexOf(here())) : -1))
  const count = (id: MindStage) => steps().filter((step) => step.stage === id).length
  const lit = (id: MindStage) => (id === "REC" ? count("REC") > 0 : indexOf(id) <= reached())

  const seconds = (from?: number) => (from ? Math.max(0, Math.round((now() - from) / 1000)) : 0)
  const total = createMemo(() => seconds(props.startedAt ?? parts()[0]?.time?.created))
  const toolCount = createMemo(() => parts().filter((part) => part.type === "tool").length)
  const lastPart = createMemo(() => parts().at(-1))
  const doing = createMemo(() => STAGES.find((item) => item.id === here())?.doing ?? "Working")
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
  const placeLabel = (item: Target) => item.where || "the task itself"

  return (
    <div data-component="session-mind" class="flex min-w-0 flex-col gap-1.5">
      <div role="status" aria-live="polite" aria-atomic="true" class="flex min-w-0 flex-col text-[13px]">
        <span class="font-[530]">{doing()}</span>
        <span class="min-w-0 truncate" title={shown()?.where}>
          <span class="opacity-70">Where: </span>
          {placeLabel(shown() ?? { key: "", where: "", range: "", steps: [] })}
          {shown()?.range ? <span class="opacity-70"> · {shown()?.range}</span> : null}
        </span>
      </div>
      <div class="text-[12px] opacity-70" aria-hidden="true">
        {toolCount() > 0 ? `step ${toolCount()}` : "starting"} · {total()}s elapsed
        {lastPart()?.type === "tool" && lastPart()?.time?.created ? ` · this step ${seconds(lastPart()?.time?.created)}s` : ""}
      </div>
      <ol class="m-0 grid max-w-md list-none grid-cols-3 gap-1 p-0 text-[12px]" aria-label="The nine operators, for this target">
        <For each={STAGES}>
          {(item) => (
            <li
              aria-current={isLive() && item.id === here() ? "step" : undefined}
              classList={{ "font-semibold": item.id === here(), "opacity-60": !lit(item.id) && item.id !== here() }}
            >
              <button
                type="button"
                disabled={count(item.id) === 0}
                aria-expanded={open() === item.id}
                aria-controls={`mind-${item.id}`}
                class="w-full cursor-pointer rounded-md border border-black/10 px-2 py-1.5 text-start hover:bg-black/5 disabled:cursor-default disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2"
                classList={{ "underline underline-offset-4 decoration-2": item.id === here() || open() === item.id }}
                onClick={() => setOpen(open() === item.id ? undefined : item.id)}
              >
                <span aria-hidden="true">
                  {item.id === here() ? "▸ " : lit(item.id) ? "✓ " : ""}
                  {item.glyph}{" "}
                </span>
                {item.label}
                {count(item.id) > 1 ? <span class="opacity-70"> ×{count(item.id)}</span> : null}
                <span class="sr-only">
                  {item.id === here() ? " (current)" : lit(item.id) ? " (passed)" : ""}
                  {count(item.id) > 0 ? ", press to show what happened" : ""}
                </span>
              </button>
            </li>
          )}
        </For>
      </ol>
      <Show when={open()}>
        {(id) => (
          <div
            id={`mind-${id()}`}
            class="max-h-60 overflow-auto rounded-md border border-black/10 p-2 text-[12px]"
            role="region"
            aria-label={`${STAGES.find((item) => item.id === id())?.label} steps on ${placeLabel(shown() ?? { key: "", where: "", range: "", steps: [] })}`}
          >
            <For each={steps().filter((step) => step.stage === id())} fallback={<div class="opacity-70">Nothing here yet.</div>}>
              {(step, index) => (
                <div class="flex min-w-0 flex-col gap-0.5 py-1" classList={{ "border-t border-black/10": index() > 0 }}>
                  <div class="flex min-w-0 gap-2">
                    <span aria-hidden="true">{step.part.type === "tool" ? mark(step.part) : "•"}</span>
                    <span class="font-[530]">
                      {step.part.type === "tool" ? step.part.name : step.part.type === "text" ? "wrote" : "thought"}
                    </span>
                    <span class="min-w-0 truncate opacity-70">{rangeOf(step.part)}</span>
                    <span class="ms-auto shrink-0 opacity-70">
                      {step.part.type === "tool" ? `${markWord(step.part)} ${took(step.part)}`.trim() : ""}
                    </span>
                  </div>
                  <Show when={step.part.type !== "tool" && clip(step.part.text)}>
                    <div class="whitespace-pre-wrap opacity-80">{clip(step.part.text)}</div>
                  </Show>
                  <Show when={step.part.state?.status === "error" && step.part.state?.error}>
                    <div class="whitespace-pre-wrap">{clip(String(step.part.state?.error))}</div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
      <Show when={targets().length > 1}>
        <ul class="m-0 flex list-none flex-col gap-0.5 p-0 text-[12px]" aria-label="Targets this turn">
          <For each={[...targets()].reverse().slice(0, 6)}>
            {(item) => (
              <li>
                <button
                  type="button"
                  aria-pressed={shown() === item}
                  class="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 text-start hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2"
                  classList={{ "font-semibold": shown() === item }}
                  onClick={() => {
                    setPickedKey(item === targets().at(-1) ? undefined : item.key)
                    setOpen(undefined)
                  }}
                >
                  <span class="min-w-0 truncate" title={item.where}>{placeLabel(item)}</span>
                  <span class="ms-auto shrink-0 font-mono opacity-80" aria-hidden="true">
                    {STAGES.map((st, i) => (i <= reachedOf(item) ? st.glyph : "·")).join("")}
                  </span>
                  <span class="sr-only">
                    {` reached ${STAGES[Math.max(0, reachedOf(item))]?.label}, ${item.steps.length} steps`}
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}
