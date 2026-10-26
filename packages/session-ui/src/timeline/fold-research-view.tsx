import { For, Show } from "solid-js"
import type { ResearchView } from "./fold-research"

const SHOWN = 12

/** One line for the research: "Read 26 pages · 30 results from 2 searches · 56 s". The longform panel uses it as a <details> summary. */
export const researchSummary = (view: ResearchView) => {
  const seconds = Math.round(view.elapsedMs / 1000)
  const results = view.searches.reduce((n, s) => n + s.n, 0)
  const queries = new Set(view.searches.map((s) => s.q)).size
  const pages = view.read.length
  return `${view.done ? "Read" : "Reading"} ${pages} page${pages === 1 ? "" : "s"} · ${results} result${results === 1 ? "" : "s"} from ${queries} search${queries === 1 ? "" : "es"} · ${seconds} s`
}

// What the door is researching, live: the queries, the page being read now, the pages read so far. Replaces "Working"
// saying nothing for a minute. Drawn from the latest fold-research notice of the active turn; it is replaced, never appended.
// `bare` leaves the summary line out, for a parent that already shows it (the longform panel's <details> summary).
export function FoldResearch(props: { view: ResearchView; bare?: boolean }) {
  const queries = () => [...new Set(props.view.searches.map((s) => s.q))]
  const label = (p: { host: string; title?: string }) => (p.title ? `${p.host} — ${p.title}` : p.host)
  return (
    <div data-component="fold-research" class="flex min-w-0 flex-col gap-1 py-1 text-[13px] leading-text-compact">
      <Show when={!props.bare}>
        <div class="font-[530]">{researchSummary(props.view)}</div>
      </Show>
      <Show when={queries().length}>
        <div class="text-v2-text-text-faint">
          searched:{" "}
          <For each={queries().slice(0, 4)}>
            {(q, i) => (
              <span>
                {i() ? " · " : ""}“{q}”
              </span>
            )}
          </For>
          <Show when={queries().length > 4}> · +{queries().length - 4} more</Show>
        </div>
      </Show>
      <Show when={!props.view.done && props.view.reading}>
        {(p) => (
          <div data-slot="fold-research-now" class="truncate">
            now reading <span class="font-[530]">{label(p())}</span>
          </div>
        )}
      </Show>
      <Show when={props.view.read.length}>
        <ul data-slot="fold-research-read" class="m-0 list-none p-0 text-v2-text-text-faint">
          <For each={props.view.read.slice(-SHOWN)}>{(p) => <li class="truncate">· {label(p)}</li>}</For>
          <Show when={props.view.read.length > SHOWN}>
            <li>· +{props.view.read.length - SHOWN} earlier</li>
          </Show>
        </ul>
      </Show>
      <Show when={props.view.stop}>{(stop) => <div class="text-v2-text-text-faint">stopped: {stop()}</div>}</Show>
    </div>
  )
}
