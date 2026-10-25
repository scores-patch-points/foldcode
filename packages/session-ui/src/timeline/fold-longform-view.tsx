import { For, Show } from "solid-js"
import type { LongformSection, LongformView } from "./fold-longform"
import type { ResearchView } from "./fold-research"
import { FoldResearch, researchSummary } from "./fold-research-view"

// The piece being made, live: one panel for the turn. A header (what kind, on what, how many slots, how many sources, how long,
// how many model calls, the marked share so far), the layer at work, the slot being drawn or judged now with its facts, the
// outline with each slot's state and verdict (sentences · face their source · cut), the last step's cut sentences, the stitched
// text so far and the research folded under one line. Drawn from the latest fold-longform and fold-research notices of the
// active turn; replaced in place, never appended. Each state has its own mark and word, so nothing rests on colour alone.
const MARK: Record<LongformSection["state"], string> = {
  planned: "○",
  writing: "▸",
  judging: "◆",
  written: "✓",
  cut: "–",
  filled: "▪",
  gap: "□",
  drawing: "▸",
  admitted: "✓",
}
const WORD: Record<LongformSection["state"], string> = {
  planned: "",
  writing: "writing",
  judging: "judging",
  written: "written",
  cut: "cut",
  filled: "from the sources",
  gap: "no page states this",
  drawing: "drawing",
  admitted: "admitted",
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const elapsed = (startedAt?: number) => {
  if (!startedAt) return ""
  const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
}
const pct = (num: number, den: number) => (den ? `${Math.round((100 * num) / den)}%` : "")

export function FoldLongform(props: { view: LongformView; research?: ResearchView }) {
  const kept = () => props.view.outline.filter((s) => s.state !== "cut")
  const done = () => kept().filter((s) => s.state === "written" || s.state === "filled" || s.state === "admitted").length
  const current = () => props.view.outline.find((s) => s.id === props.view.current)
  const kindWord = () => (props.view.kind && props.view.kind !== "prose" && props.view.kind !== "longform" ? props.view.kind : "piece")
  const header = () => {
    const what = props.view.topic ? `a ${kindWord()} on ${props.view.topic}` : `a ${kindWord()}`
    const verb = props.view.done ? "Made" : props.view.layer === "stitched" ? "Stitching" : props.view.layer === "drawn" ? "Drawing into" : "Writing"
    const parts = [`${verb} ${what}`, plural(kept().length, "slot")]
    if (props.view.sources) parts.push(`${plural(props.view.sources, "source")} read`)
    const t = elapsed(props.view.startedAt)
    if (t && !props.view.done) parts.push(t)
    if (props.view.calls) parts.push(`${plural(props.view.calls, "model call")}`)
    if (props.view.marked && props.view.marked.placed) parts.push(`${pct(props.view.marked.marked, props.view.marked.placed)} the model's own`)
    return parts.join(" · ")
  }
  // what is happening right now, in one line: the slot being judged (against how many facts) or drawn
  const now = () => {
    const j = props.view.judging
    if (j) {
      const s = props.view.outline.find((x) => x.id === j.section)
      return `judging "${s?.title ?? j.section}" against ${plural(j.facts, "fact")}`
    }
    const c = current()
    if (c && (c.state === "writing" || c.state === "drawing" || c.state === "planned"))
      return `${c.state === "drawing" ? "drawing" : "writing"} "${c.title}"${c.facts ? ` from ${plural(c.facts, "fact")}` : ""}${c.round ? ` · repair round ${c.round}` : ""}`
    return ""
  }
  // a slot's verdict once judged: sentences · how many face their source · how many cut (or the model's own, for an admitted gap)
  const verdict = (s: LongformSection) => {
    if (s.sentences === undefined) return ""
    if (s.freeform) return `${plural(s.sentences, "sentence")} · not judged`
    const face = s.supported ?? 0
    const bits = [`${plural(s.sentences, "sentence")}`, `${face} face a source`]
    if (s.cut) bits.push(`${s.cut} cut`)
    if (s.marked) bits.push(`${s.marked} the model's own`)
    if (s.rounds && s.rounds > 1) bits.push(`${s.rounds} rounds`)
    return bits.join(" · ")
  }
  const detail = (s: LongformSection) => {
    const v = verdict(s)
    if (v) return v
    if (s.state === "writing" || s.state === "drawing" || (s.state === "planned" && s.id === props.view.current))
      return s.facts ? `${WORD[s.state === "drawing" ? "drawing" : "writing"]} from ${plural(s.facts, "fact")}` : WORD.writing
    return WORD[s.state]
  }
  return (
    <div data-component="fold-longform" class="flex min-w-0 flex-col gap-1 py-1 text-[13px] leading-text-compact">
      <div class="font-[530]">{header()}</div>
      <Show when={props.view.layer && !props.view.done}>
        <div class="text-v2-text-text-faint">
          {props.view.layer === "stitched"
            ? `layer A · the sources alone${props.view.stitched ? ` · ${props.view.stitched.filled} filled, ${plural(props.view.stitched.gaps, "gap")}` : ""}`
            : "layer B · the model, into the gaps only"}
        </div>
      </Show>
      <Show when={now()}>{(line) => <div aria-live="polite">{line()}</div>}</Show>
      <Show when={!props.view.done && props.view.round > 1}>
        <div class="text-v2-text-text-faint">
          round {props.view.round} · {done()} of {kept().length} done
        </div>
      </Show>
      <Show when={props.view.outline.length}>
        <ol data-slot="fold-longform-outline" class="m-0 list-none p-0">
          <For each={props.view.outline}>
            {(s) => {
              const active = () => s.id === props.view.current && s.state !== "written" && s.state !== "cut" && s.state !== "filled" && s.state !== "admitted"
              return (
                <li data-state={s.state} aria-current={active() ? "step" : undefined} class="flex min-w-0 flex-col">
                  <div
                    class="flex min-w-0 gap-2"
                    classList={{
                      "text-v2-text-text-faint": s.state === "planned" || s.state === "cut" || s.state === "gap",
                      "line-through": s.state === "cut",
                    }}
                  >
                    <span class="w-3 shrink-0 text-center" aria-hidden="true">
                      {active() ? MARK.writing : MARK[s.state]}
                    </span>
                    <span class="truncate" classList={{ "font-[530]": active() }}>
                      {s.title}
                    </span>
                    <Show when={detail(s)}>{(word) => <span class="shrink-0 text-v2-text-text-faint">· {word()}</span>}</Show>
                  </div>
                  <Show when={s.preview}>
                    {(p) => <div class="ml-5 truncate text-v2-text-text-faint">{p()}</div>}
                  </Show>
                </li>
              )
            }}
          </For>
        </ol>
      </Show>
      <Show when={props.view.graded && props.view.graded.failed.length}>
        <div data-slot="fold-longform-cut" class="ml-5 text-v2-text-text-faint">
          <div>
            cut from "{props.view.graded!.title ?? props.view.graded!.section}" (nothing read states them):
          </div>
          <ul class="m-0 list-none p-0">
            <For each={props.view.graded!.failed}>{(f) => <li class="truncate line-through">{f}</li>}</For>
          </ul>
        </div>
      </Show>
      <Show when={!props.view.outline.length && !current()}>
        <div class="text-v2-text-text-faint">{props.view.layer === "stitched" ? "hunting the sources for what the piece must say…" : "planning the outline…"}</div>
      </Show>
      <Show when={props.view.stitched?.text}>
        {(text) => (
          <details data-slot="fold-longform-stitched" class="min-w-0">
            <summary class="cursor-pointer text-v2-text-text-faint">the piece as the sources alone make it</summary>
            <pre class="whitespace-pre-wrap text-[12px]">{text()}</pre>
          </details>
        )}
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
