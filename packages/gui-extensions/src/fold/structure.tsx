import { createMemo, createSignal, For, Show } from "solid-js"
import type { MountedSession } from "../sdk"
import { structureFromText } from "./structure-model"

// Structure: point the fold at material and read back the shape it MEASURES — the nine
// registers, model-free, every tie, echo, group and break decided against 199 drawn nulls.
// Nothing here is a model call. Paste material (or a whole record) and press Read; the
// reader cuts it into statements and the vendored terrain engine lays them out by register.
// A `break` is a referent-anchored contradiction; a same-unit collision with no shared
// referent is `nominated`, reported but never called a contradiction.

export default function SessionStructure(props: { session: MountedSession }) {
  const [text, setText] = createSignal("")
  const [read, setRead] = createSignal<string | undefined>()

  const t = createMemo(() => {
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
          <span class="text-[11px] opacity-60">{t() ? "measured" : "nothing read yet"}</span>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-auto px-4 py-2">
        <Show when={t()} fallback={<div class="px-1 py-4 text-[13px] opacity-70">Paste material above, then Read structure.</div>}>
          {(s) => (
            <div class="flex flex-col gap-3 pb-6">
              <div class="text-[12px] opacity-80">
                {s().counts.sources} source(s) · {s().counts.statements} statements · {s().counts.referents} referents ({s().counts.earned} earned) ·{" "}
                {s().counts.ties} ties · {s().counts.echoes} echoes
              </div>

              <section aria-label="Names">
                <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Names</div>
                <For each={s().seen.entity.rows.slice(0, 12)} fallback={<div class="text-[12px] opacity-60">None.</div>}>
                  {(row) => (
                    <div class="text-[12px]">
                      {row.name} <span class="opacity-55">· {row.standing} · {row.sources.length} src</span>
                    </div>
                  )}
                </For>
              </section>

              <section aria-label="Figures">
                <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Figures</div>
                <For each={s().seen.field.units.slice(0, 12)} fallback={<div class="text-[12px] opacity-60">None.</div>}>
                  {(unit) => (
                    <div class="text-[12px]">
                      <span class="font-semibold">{unit.unit}</span>{" "}
                      <span class="opacity-70">
                        {unit.values.map((v: { raw: string }) => v.raw).slice(0, 6).join(" / ")}
                        {unit.contradicts ? " ⚠ break" : unit.differs ? " · differs" : ""}
                      </span>
                    </div>
                  )}
                </For>
              </section>

              <section aria-label="Connections">
                <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Connections</div>
                <For each={s().seen.network.edges.slice(0, 12)} fallback={<div class="text-[12px] opacity-60">None beat chance.</div>}>
                  {(edge) => (
                    <div class="text-[12px]">
                      {edge.a} — {edge.b} <span class="opacity-55">· k={edge.k} · {edge.witnesses} source(s)</span>
                    </div>
                  )}
                </For>
              </section>

              <section aria-label="Patterns">
                <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Patterns</div>
                <Show when={s().seeing.paradigm.breaks.length > 0}>
                  <For each={s().seeing.paradigm.breaks.slice(0, 12)}>
                    {(b) => (
                      <div class="text-[12px]">
                        ✗ break [{b.unit}]{(b.anchors ?? []).length ? ` · anchored on ${b.anchors.join(", ")}` : ""}:{" "}
                        {b.values.map((v: { raw: string }) => v.raw).slice(0, 6).join(" vs ")}
                      </div>
                    )}
                  </For>
                </Show>
                <Show when={s().seeing.paradigm.nominated.length > 0}>
                  <For each={s().seeing.paradigm.nominated.slice(0, 12)}>
                    {(b) => (
                      <div class="text-[12px] opacity-75">
                        ~ nominated [{b.unit}] (no shared referent): {b.values.map((v: { raw: string }) => v.raw).slice(0, 6).join(" vs ")}
                      </div>
                    )}
                  </For>
                </Show>
                <Show when={s().seeing.paradigm.breaks.length === 0 && s().seeing.paradigm.nominated.length === 0}>
                  <div class="text-[12px] opacity-60">No break and no collision.</div>
                </Show>
              </section>

              <Show when={s().gaps.length > 0}>
                <section aria-label="Residue">
                  <div class="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-60">Residue</div>
                  <For each={s().gaps}>
                    {(gap) => (
                      <div class="text-[12px] opacity-75">
                        [{gap.kind}] {gap.why}
                      </div>
                    )}
                  </For>
                </section>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}
