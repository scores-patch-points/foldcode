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
  whereOf,
} from "./session-mind-stage"

// The mind: what the model is doing right now, in words, while a turn runs.
// The shimmering "Working" label says only that something is happening; this says
// what, keeps the earlier stages visible, announces each change once, and does
// not rely on motion or colour (the current stage is marked by text and
// aria-current, the pulse is dropped under prefers-reduced-motion).

export function SessionMind(props: {
  parts?: ReadonlyArray<Part | undefined>
  startedAt?: number
  /** Open a path in the right-hand panel. */
  onOpen?: (path: string) => void
}) {
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

  const duration = (secs: number) => (secs >= 3600 ? `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m` : secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`)
  const canOpen = (where: string) => !!props.onOpen && /[\\/.]/.test(where) && !/\s/.test(where) && !/^https?:/.test(where)
  const openWhere = (where: string) => {
    if (canOpen(where)) props.onOpen?.(where)
  }
  const current = () => STAGES.find((item) => item.id === here()) ?? STAGES[0]!

  return (
    <div data-component="session-mind" class="flex min-w-0 max-w-md flex-col gap-2">
      <div role="status" aria-live="polite" aria-atomic="true" class="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden="true"
          class="flex size-8 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,currentColor_12%,transparent)] text-[17px] leading-none"
        >
          {current().glyph}
        </span>
        <span class="flex min-w-0 flex-col">
          <span class="text-[13px] font-[560]">{doing()}</span>
          <Show
            when={canOpen(shown()?.where ?? "")}
            fallback={
              <span class="min-w-0 truncate text-[12px] opacity-75" title={shown()?.where}>
                {placeLabel(shown() ?? { key: "", where: "", range: "", steps: [] })}
                {shown()?.range ? ` · ${shown()?.range}` : ""}
              </span>
            }
          >
            <button
              type="button"
              class="min-w-0 cursor-pointer truncate text-start text-[12px] underline decoration-dotted underline-offset-2 opacity-90 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2"
              title={`Open ${shown()?.where} in the side panel`}
              onClick={() => openWhere(shown()!.where)}
            >
              {shown()?.where}
              {shown()?.range ? ` · ${shown()?.range}` : ""}
            </button>
          </Show>
          <span class="text-[11px] opacity-60" aria-hidden="true">
            {toolCount() > 0 ? `step ${toolCount()}` : "starting"} · {duration(total())}
            {lastPart()?.type === "tool" && lastPart()?.time?.created ? ` · this step ${duration(seconds(lastPart()?.time?.created))}` : ""}
          </span>
        </span>
      </div>

      <ol class="m-0 grid list-none grid-cols-3 gap-1.5 p-0" aria-label="The nine operators, for this target">
        <For each={STAGES}>
          {(item) => {
            const isHere = () => item.id === here()
            return (
              <li aria-current={isLive() && isHere() ? "step" : undefined} class="min-w-0">
                <button
                  type="button"
                  disabled={count(item.id) === 0}
                  aria-expanded={open() === item.id}
                  aria-controls={`mind-${item.id}`}
                  class="flex w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-start text-[12px] transition-colors enabled:cursor-pointer enabled:hover:bg-[color-mix(in_srgb,currentColor_10%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-2 motion-reduce:transition-none"
                  classList={{
                    "bg-[color-mix(in_srgb,currentColor_14%,transparent)] font-[600] ring-1 ring-current": isHere(),
                    "bg-[color-mix(in_srgb,currentColor_5%,transparent)]": !isHere() && lit(item.id),
                    "opacity-45": !isHere() && !lit(item.id),
                  }}
                  onClick={() => setOpen(open() === item.id ? undefined : item.id)}
                >
                  <span
                    aria-hidden="true"
                    class="flex size-5 shrink-0 items-center justify-center rounded-full text-[12px] leading-none"
                    classList={{ "bg-current/0": true }}
                  >
                    {item.glyph}
                  </span>
                  <span class="min-w-0 truncate">{item.label}</span>
                  <span class="ms-auto shrink-0 text-[11px] opacity-70" aria-hidden="true">
                    {isHere() ? "now" : count(item.id) > 1 ? `×${count(item.id)}` : lit(item.id) ? "✓" : ""}
                  </span>
                  <span class="sr-only">
                    {isHere() ? " (current)" : lit(item.id) ? " (passed)" : ""}
                    {count(item.id) > 0 ? `, ${count(item.id)} step${count(item.id) === 1 ? "" : "s"}, press to show` : ""}
                  </span>
                </button>
              </li>
            )
          }}
        </For>
      </ol>

      <Show when={open()}>
        {(id) => (
          <div
            id={`mind-${id()}`}
            class="max-h-64 overflow-auto rounded-lg bg-[color-mix(in_srgb,currentColor_5%,transparent)] p-2 text-[12px]"
            role="region"
            aria-label={`${STAGES.find((item) => item.id === id())?.label} steps on ${placeLabel(shown() ?? { key: "", where: "", range: "", steps: [] })}`}
          >
            <For each={steps().filter((step) => step.stage === id())} fallback={<div class="opacity-70">Nothing here yet.</div>}>
              {(step, index) => {
                const where = () => whereOf(step.part)
                return (
                  <div class="flex min-w-0 flex-col gap-0.5 py-1" classList={{ "border-t border-current/10": index() > 0 }}>
                    <div class="flex min-w-0 items-baseline gap-2">
                      <span aria-hidden="true">{step.part.type === "tool" ? mark(step.part) : "•"}</span>
                      <span class="font-[560]">
                        {step.part.type === "tool" ? step.part.name : step.part.type === "text" ? "wrote" : "thought"}
                      </span>
                      <Show when={step.part.type === "tool" && where()}>
                        <Show
                          when={canOpen(where())}
                          fallback={<span class="min-w-0 truncate opacity-70" title={where()}>{where()}</span>}
                        >
                          <button
                            type="button"
                            class="min-w-0 cursor-pointer truncate text-start underline decoration-dotted underline-offset-2 opacity-90 hover:opacity-100 focus-visible:outline-2"
                            title={`Open ${where()} in the side panel`}
                            onClick={() => openWhere(where())}
                          >
                            {where()}
                          </button>
                        </Show>
                      </Show>
                      <span class="ms-auto shrink-0 opacity-70">
                        {step.part.type === "tool" ? `${markWord(step.part)} ${took(step.part)}`.trim() : ""}
                      </span>
                    </div>
                    <Show when={rangeOf(step.part)}>
                      <div class="ps-5 opacity-60">{rangeOf(step.part)}</div>
                    </Show>
                    <Show when={step.part.type !== "tool" && clip(step.part.text)}>
                      <div class="whitespace-pre-wrap ps-5 opacity-80">{clip(step.part.text)}</div>
                    </Show>
                    <Show when={step.part.state?.status === "error" && step.part.state?.error}>
                      <div class="whitespace-pre-wrap ps-5">{clip(String(step.part.state?.error))}</div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </div>
        )}
      </Show>

      <Show when={open() && targets().length > 1}>
        <div class="text-[11px] opacity-60">{targets().length} targets this turn — pick one to follow it</div>
        <Show when={true}>
          <ul id="mind-targets" class="m-0 flex list-none flex-col gap-0.5 p-0 text-[12px]" aria-label="Targets this turn">
            <For each={[...targets()].reverse().slice(0, 8)}>
              {(item) => (
                <li class="flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    aria-pressed={shown() === item}
                    class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-start hover:bg-[color-mix(in_srgb,currentColor_8%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-2"
                    classList={{ "bg-[color-mix(in_srgb,currentColor_10%,transparent)] font-[600]": shown() === item }}
                    onClick={() => {
                      setPickedKey(item === targets().at(-1) ? undefined : item.key)
                      setOpen(undefined)
                    }}
                  >
                    <span class="min-w-0 truncate" title={item.where}>{placeLabel(item)}</span>
                    <span class="ms-auto shrink-0 font-mono opacity-80" aria-hidden="true">
                      {STAGES.map((st, i) => (i <= reachedOf(item) ? st.glyph : "·")).join("")}
                    </span>
                    <span class="sr-only">{` reached ${STAGES[Math.max(0, reachedOf(item))]?.label}, ${item.steps.length} steps`}</span>
                  </button>
                  <Show when={canOpen(item.where)}>
                    <button
                      type="button"
                      aria-label={`Open ${item.where} in the side panel`}
                      title="Open in the side panel"
                      class="shrink-0 cursor-pointer rounded-md px-1 opacity-70 hover:opacity-100 focus-visible:outline-2"
                      onClick={() => openWhere(item.where)}
                    >
                      ↗
                    </button>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </div>
  )
}
