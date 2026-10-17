import { createMemo, createSignal, For, Show } from "solid-js"
import type { MountedSession } from "../sdk"
import { structureFromText } from "./structure-model"

// Structure: point the fold at material and read back the shape it MEASURES — the nine
// registers, model-free, every tie, echo, group and break decided against 199 drawn nulls.
// Nothing here is a model call. A `break` is a referent-anchored contradiction; a same-unit
// collision with no shared referent is `nominated`, reported but never called a contradiction.
//
// `StructureView` is the pure presentation (a structure in, JSX out) so it renders in a story
// or a test with no door; the default export is the session panel that owns the input shell.

type Structure = ReturnType<typeof structureFromText>

export function StructureView(props: { structure: Structure }) {
  return (
    <div class="flex flex-col gap-3 pb-6">
      <div class="text-[12px] opacity-80">
        {props.structure.counts.sources} source(s) · {props.structure.counts.statements} statements · {props.structure.counts.referents} referents (
        {props.structure.counts.earned} earned) · {props.structure.counts.ties} ties · {props.structure.counts.echoes} echoes
      </div>

      <section aria-label="Names">
        <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Names</div>
        <For each={props.structure.seen.entity.rows.slice(0, 12)} fallback={<div class="text-[12px] opacity-60">None.</div>}>
          {(row) => (
            <div class="text-[12px]">
              {row.name} <span class="opacity-55">· {row.standing} · {row.sources.length} src</span>
            </div>
          )}
        </For>
      </section>

      <section aria-label="Figures">
        <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Figures</div>
        <For each={props.structure.seen.field.units.slice(0, 12)} fallback={<div class="text-[12px] opacity-60">None.</div>}>
          {(unit) => (
            <div class="text-[12px]">
              <span class="font-semibold">{unit.unit}</span>{" "}
              <span class="opacity-70">
                {unit.values.map((value: { raw: string }) => value.raw).slice(0, 6).join(" / ")}
                {unit.contradicts ? " ⚠ break" : unit.differs ? " · differs" : ""}
              </span>
            </div>
          )}
        </For>
      </section>

      <section aria-label="Connections">
        <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Connections</div>
        <For each={props.structure.seen.network.edges.slice(0, 12)} fallback={<div class="text-[12px] opacity-60">None beat chance.</div>}>
          {(edge) => (
            <div class="text-[12px]">
              {edge.a} — {edge.b} <span class="opacity-55">· k={edge.k} · {edge.witnesses} source(s)</span>
            </div>
          )}
        </For>
      </section>

      <section aria-label="Patterns">
        <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Patterns</div>
        <For each={props.structure.seeing.paradigm.breaks.slice(0, 12)}>
          {(breaking) => (
            <div class="text-[12px]">
              ✗ break [{breaking.unit}]
              {(breaking.anchors ?? []).length ? ` · anchored on ${breaking.anchors.join(", ")}` : ""}:{" "}
              {breaking.values.map((value: { raw: string }) => value.raw).slice(0, 6).join(" vs ")}
            </div>
          )}
        </For>
        <For each={props.structure.seeing.paradigm.nominated.slice(0, 12)}>
          {(collision) => (
            <div class="text-[12px] opacity-75">
              ~ nominated [{collision.unit}] (no shared referent): {collision.values.map((value: { raw: string }) => value.raw).slice(0, 6).join(" vs ")}
            </div>
          )}
        </For>
        <Show when={props.structure.seeing.paradigm.breaks.length === 0 && props.structure.seeing.paradigm.nominated.length === 0}>
          <div class="text-[12px] opacity-60">No break and no collision.</div>
        </Show>
      </section>

      <Show when={props.structure.gaps.length > 0}>
        <section aria-label="Residue">
          <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Residue</div>
          <For each={props.structure.gaps}>
            {(gap) => (
              <div class="text-[12px] opacity-75">
                [{gap.kind}] {gap.why}
              </div>
            )}
          </For>
        </section>
      </Show>
    </div>
  )
}

export default function SessionStructure(props: { session: MountedSession }) {
  const [text, setText] = createSignal("")
  const [read, setRead] = createSignal<string | undefined>()

  const structure = createMemo(() => {
    const source = read()

    if (!source || !source.trim()) return undefined

    return structureFromText(source, props.session.id)
  })

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-structure">
      <div class="shrink-0 border-b border-v2-border-border-base px-5 py-3">
        <div class="text-13-regular text-text-base">Structure</div>
        <div class="text-12-regular text-text-weak">
          Point the fold at material; read back the nine registers it measures. No model, no embeddings.
        </div>
      </div>

      <div class="shrink-0 px-4 py-3">
        <textarea
          class="h-28 w-full resize-y rounded-md border border-v2-border-border-base bg-transparent p-2 text-[12px] outline-none focus-visible:outline-2"
          placeholder="Paste material — a record, a report, a log, a page…"
          value={text()}
          onInput={(event) => setText(event.currentTarget.value)}
        />
        <div class="mt-2 flex items-center gap-2">
          <button
            type="button"
            class="cursor-pointer rounded-md border border-v2-border-border-base px-3 py-1 text-[12px] hover:bg-black/5 focus-visible:outline-2"
            onClick={() => setRead(text())}
          >
            Read structure
          </button>
          <span class="text-[11px] opacity-60">{structure() ? "measured" : "nothing read yet"}</span>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-auto px-4 py-2">
        <Show when={structure()} fallback={<div class="px-1 py-4 text-[13px] opacity-70">Paste material above, then Read structure.</div>}>
          {(value) => <StructureView structure={value()} />}
        </Show>
      </div>
    </div>
  )
}
