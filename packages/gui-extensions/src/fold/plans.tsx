import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createLatest, type MountedSession } from "../sdk"
import { followBottom } from "./follow"
import { FOLD_URL } from "./panel"
import { ago, counts, KIND_GLYPH, KIND_WORD, order, spiralOf, titleOf, type Plan, type RecordView } from "./plans-model"

// Work plans: what each task's agents left behind in the stigmergic medium. Marks (fact, claim, done, block), what is
// still claimed, and every settled turn in full. Reasoning is kept, not erased, so it is here to read.

export default function SessionWorkPlans(props: { session: MountedSession }) {
  const [tick, setTick] = createSignal(0)
  const [picked, setPicked] = createSignal<string | undefined>()
  const [openTurn, setOpenTurn] = createSignal<string | undefined>()
  const timer = setInterval(() => setTick((value) => value + 1), 3000)
  onCleanup(() => clearInterval(timer))

  const data = createLatest(
    () => `${props.session.key}#${tick()}`,
    async (_key, signal) => {
      const response = await fetch(`${FOLD_URL}/v1/hooks/opencode/plans?limit=20`, { signal })
      if (!response.ok) throw new Error(`plans ${response.status}`)
      const body = (await response.json()) as { plans?: Plan[] }
      return body.plans ?? []
    },
  )

  // The verified record for the plan on screen: the frames REC re-entered and the answers held two ways.
  const recordFor = createLatest(
    () => `${picked() ?? props.session.id}#${tick()}`,
    async (key, signal) => {
      const task = key.split("#")[0]!
      const response = await fetch(`${FOLD_URL}/v1/hooks/opencode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "record", task }),
        signal,
      })
      if (!response.ok) throw new Error(`record ${response.status}`)
      return (await response.json()) as RecordView
    },
  )

  const plans = createMemo(() => order(data.latest ?? [], props.session.id))
  const current = createMemo(() => plans().find((item) => item.task === picked()) ?? plans()[0])
  const now = () => Date.now() + tick() * 0

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-work-plans">
      <div class="shrink-0 border-b border-v2-border-border-base px-5 py-3">
        <div class="text-13-regular text-text-base">Work plans</div>
        <div class="text-12-regular text-text-weak">
          What each task's agents left behind: marks, what is claimed, and every settled turn in full.
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-auto px-3 py-2" ref={(element) => onCleanup(followBottom(element))}>
        <Show
          when={plans().length > 0}
          fallback={
            <div class="px-2 py-4 text-[13px] opacity-70">
              {data.error ? "The door isn't answering, so no plans to show." : "No work plans yet. They appear as a turn leaves marks."}
            </div>
          }
        >
          <ul class="m-0 mb-3 flex list-none flex-col gap-1 p-0" aria-label="Plans">
            <For each={plans()}>
              {(item) => (
                <li>
                  <button
                    type="button"
                    aria-pressed={current()?.task === item.task}
                    class="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-start text-[13px] hover:bg-black/5 focus-visible:outline-2 focus-visible:outline-offset-2"
                    classList={{ "bg-black/5 font-semibold": current()?.task === item.task }}
                    onClick={() => {
                      setPicked(item.task)
                      setOpenTurn(undefined)
                    }}
                  >
                    <span class="min-w-0 truncate" title={item.task}>{titleOf(item)}</span>
                    <span class="ms-auto shrink-0 text-[11px] opacity-65">
                      {item.task === props.session.id ? "this session · " : ""}
                      {ago(item.updated, now())}
                    </span>
                  </button>
                </li>
              )}
            </For>
          </ul>

          <Show when={current()}>
            {(plan) => (
              <div class="flex flex-col gap-3 px-1">
                <div class="flex flex-wrap gap-3 text-[12px]" aria-label="Marks by kind">
                  <For each={(["fact", "claim", "done", "block"] as const)}>
                    {(kind) => (
                      <span>
                        <span aria-hidden="true">{KIND_GLYPH[kind]} </span>
                        {counts(plan())[kind]} {KIND_WORD[kind]}
                      </span>
                    )}
                  </For>
                </div>

                <Show when={plan().open.length > 0}>
                  <section aria-label="Still claimed">
                    <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Claimed, not done</div>
                    <For each={plan().open}>
                      {(claim) => (
                        <div class="text-[12px]">
                          ○ {claim.item} <span class="opacity-60">· {claim.agent.slice(0, 12)} · {ago(claim.since, now())}</span>
                        </div>
                      )}
                    </For>
                  </section>
                </Show>

                <section aria-label="Record">
                  <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Record, re-entered</div>
                  <Show
                    when={spiralOf(recordFor.latest).length > 0}
                    fallback={<div class="text-[12px] opacity-60">Nothing admitted to the record yet.</div>}
                  >
                    <For each={spiralOf(recordFor.latest)}>
                      {(row) => (
                        <div class="py-0.5 text-[12px]">
                          <span class="font-semibold">{row.referent}</span>
                          <span class="opacity-70">
                            {" "}
                            · {row.reentries > 0 ? `re-entered ×${row.reentries}` : "one pass, a line"}
                            {row.answers > 1 ? ` · held ${row.answers} ways` : ""}
                          </span>
                          <div class="opacity-80">{row.delta.join("; ")}</div>
                          <Show when={row.check}>
                            <div class="opacity-55">check: {row.check}</div>
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                </section>

                <section aria-label="Marks">
                  <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Marks</div>
                  <Show when={plan().marks.length > 0} fallback={<div class="text-[12px] opacity-60">None left yet.</div>}>
                    <ul class="m-0 flex list-none flex-col gap-1 p-0">
                      <For each={plan().marks}>
                        {(mark) => (
                          <li class="flex gap-2 text-[12px]">
                            <span aria-hidden="true" class="w-4 shrink-0 text-center">{KIND_GLYPH[mark.kind]}</span>
                            <span class="sr-only">{KIND_WORD[mark.kind]}: </span>
                            <span class="min-w-0 whitespace-pre-wrap break-words">{mark.text}</span>
                            <span class="ms-auto shrink-0 opacity-55">{ago(mark.t, now())}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </section>

                <section aria-label="Turns">
                  <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Turns, as kept</div>
                  <For each={plan().turns} fallback={<div class="text-[12px] opacity-60">No settled turns yet.</div>}>
                    {(turn) => {
                      const id = `${plan().task}:${turn.agent}:${turn.n}`
                      return (
                        <div class="border-t border-v2-border-border-base py-1">
                          <button
                            type="button"
                            aria-expanded={openTurn() === id}
                            class="flex w-full min-w-0 cursor-pointer items-baseline gap-2 text-start text-[12px] focus-visible:outline-2"
                            onClick={() => setOpenTurn(openTurn() === id ? undefined : id)}
                          >
                            <span aria-hidden="true">{openTurn() === id ? "▾" : "▸"}</span>
                            <span class="shrink-0 opacity-60">turn {turn.n}</span>
                            <span class="min-w-0 truncate">{turn.ask}</span>
                          </button>
                          <Show when={openTurn() === id}>
                            <div class="ps-5 pt-1 text-[12px]">
                              <Show when={turn.tools.length > 0}>
                                <div class="opacity-60">tools: {turn.tools.join(", ")}</div>
                              </Show>
                              <div class="whitespace-pre-wrap break-words">{turn.text || "(no text reply)"}</div>
                            </div>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </section>
              </div>
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}
