import { For, Show } from "solid-js"
import type { LongformSection, LongformView } from "./fold-longform"
import type { ResearchView } from "./fold-research"
import { FoldResearch, researchSummary } from "./fold-research-view"

// The piece being written, live: one panel for the turn. A header line (what, how many sections, how many sources), the
// outline with each section's state, and the research folded under one line once writing has begun. Drawn from the
// latest fold-longform and fold-research notices of the active turn; replaced in place, never appended.
// Each state has its own mark and word, so nothing rests on colour alone.
const MARK: Record<LongformSection["state"], string> = { planned: "○", writing: "▸", written: "✓", cut: "–" }
const WORD: Record<LongformSection["state"], string> = {
  planned: "",
  writing: "writing",
  written: "written",
  cut: "cut",
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function FoldLongform(props: { view: LongformView; research?: ResearchView }) {
  const kept = () => props.view.outline.filter((s) => s.state !== "cut")
  const written = () => kept().filter((s) => s.state === "written").length
  const current = () => props.view.outline.find((s) => s.id === props.view.current)
  const header = () => {
    const what = props.view.topic ? `a piece on ${props.view.topic}` : "a piece"
    const parts = [props.view.done ? `Wrote ${what}` : `Writing ${what}`, plural(kept().length, "section")]
    if (props.view.sources) parts.push(`${plural(props.view.sources, "source")} read`)
    return parts.join(" · ")
  }
  const detail = (s: LongformSection) => {
    if (s.state === "writing" || (s.state === "planned" && s.id === props.view.current))
      return s.facts ? `writing from ${plural(s.facts, "fact")}` : "writing"
    return WORD[s.state]
  }
  return (
    <div data-component="fold-longform" class="flex min-w-0 flex-col gap-1 py-1 text-[13px] leading-text-compact">
      <div class="font-[530]">{header()}</div>
      <Show when={!props.view.done && props.view.round > 1}>
        <div class="text-v2-text-text-faint">
          round {props.view.round} · {written()} of {kept().length} written
        </div>
      </Show>
      <Show when={props.view.outline.length}>
        <ol data-slot="fold-longform-outline" class="m-0 list-none p-0">
          <For each={props.view.outline}>
            {(s) => {
              const now = () => s.id === props.view.current && s.state !== "written" && s.state !== "cut"
              return (
                <li
                  data-state={s.state}
                  aria-current={now() ? "step" : undefined}
                  class="flex min-w-0 gap-2"
                  classList={{
                    "text-v2-text-text-faint": s.state === "planned" || s.state === "cut",
                    "line-through": s.state === "cut",
                  }}
                >
                  <span class="w-3 shrink-0 text-center" aria-hidden="true">
                    {now() ? MARK.writing : MARK[s.state]}
                  </span>
                  <span class="truncate" classList={{ "font-[530]": now() }}>
                    {s.title}
                  </span>
                  <Show when={detail(s)}>
                    {(word) => <span class="shrink-0 text-v2-text-text-faint">· {word()}</span>}
                  </Show>
                </li>
              )
            }}
          </For>
        </ol>
      </Show>
      <Show when={!props.view.outline.length && !current()}>
        <div class="text-v2-text-text-faint">planning the outline…</div>
      </Show>
      <Show when={props.research}>
        {(research) => (
          <details data-slot="fold-longform-research" class="min-w-0">
            <summary class="cursor-pointer text-v2-text-text-faint">{researchSummary(research())}</summary>
            <FoldResearch view={research()} bare />
          </details>
        )}
      </Show>
    </div>
  )
}
