// The Layers window — the projected reality at five grains, one toggle. The model only ever read an abridged
// projection of the fold; this window lets a person move the lens across the SAME record without any view
// re-authoring the text: as said → sourced (addresses resolved) → prompt (the exact bytes sent) → record (the chain).

import { createSignal, For, onMount, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { ScrollView } from "@opencode/ui/scroll-view"
import { useExtension, type MountedSession } from "../sdk"
import { FOLD_URL } from "./panel"
import { GRAINS, readLayers, resolveSource, tagOf, type Grain, type Layers } from "./layers-model"

function Grain(props: { label: string; value: string; tone?: "mech" | "gap" }) {
  return (
    <section class="flex flex-col gap-1 border-b border-v2-border-border-base px-5 py-3">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <pre
        class="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-v2-border-border-base bg-black/5 p-2 text-[11px] leading-relaxed"
        classList={{ "opacity-60": props.tone === "gap" }}
      >
        {props.value}
      </pre>
    </section>
  )
}

export default function SessionLayersPanel(props: { session: MountedSession }) {
  const ctx = useExtension()
  const [layers, setLayers] = createSignal<Layers>()
  const [grain, setGrain] = createSignal<Grain>("said")
  const [error, setError] = createSignal<string>()
  const [resolved, setResolved] = createSignal<Record<string, string>>({})

  const load = () => {
    setError(undefined)
    readLayers(FOLD_URL, { agent: props.session.id, workspace: props.session.directory })
      .then(setLayers)
      .catch((cause) => setError(String(cause)))
  }

  onMount(load)

  const pin = (ref?: string) => {
    if (!ref) return
    const task = layers()?.task ?? props.session.id
    resolveSource(FOLD_URL, { task, agent: props.session.id, ref }).then((answer) =>
      setResolved((map) => ({ ...map, [ref]: answer.ok ? (answer.bytes ?? "") : `(${answer.gap ?? "unresolved"})` })),
    )
  }

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-layers">
      <div class="flex shrink-0 items-start justify-between gap-3 border-b border-v2-border-border-base px-5 py-4">
        <div class="flex min-w-0 flex-col gap-0.5">
          <div class="flex min-w-0 items-center gap-2">
            <span class="size-1.5 shrink-0 rounded-full bg-v2-icon-icon-accent" aria-hidden="true" />
            <div class="min-w-0 truncate text-13-regular text-text-base">{ctx.t("layers.title")}</div>
          </div>
          <div class="min-w-0 truncate text-12-regular text-text-weak">{ctx.t("layers.subtitle")}</div>
        </div>
        <Button size="small" variant="outline" onClick={load}>
          {ctx.t("panel.refresh")}
        </Button>
      </div>

      <div class="flex shrink-0 items-center gap-1 border-b border-v2-border-border-base px-4 py-2">
        <For each={GRAINS}>
          {(name) => (
            <button
              type="button"
              class="cursor-pointer rounded-md border border-v2-border-border-base px-3 py-1 text-[12px] hover:bg-black/5 focus-visible:outline-2"
              classList={{ "bg-black/10 font-medium": grain() === name }}
              onClick={() => setGrain(name)}
            >
              {name}
            </button>
          )}
        </For>
        <span class="ml-auto text-[11px] opacity-60">{ctx.t("layers.hint")}</span>
      </div>

      <ScrollView class="min-h-0 flex-1">
        <Show when={error()}>
          <div class="border-b border-v2-border-border-base px-5 py-3 text-12-regular text-text-weak">{error()}</div>
        </Show>
        <Show
          when={layers()}
          fallback={<div class="px-5 py-4 text-13-regular opacity-70">{ctx.t("panel.loading")}</div>}
        >
          {(L) => (
            <>
              <Grain label="ask" value={L().ask ?? "(none)"} />
              <Grain
                label="L1 projection — the fold-index the model read"
                value={L().projection.note ?? `(${L().projection.gap ?? "empty"})`}
                tone={L().projection.note ? undefined : "gap"}
              />
              <Show when={grain() === "said"}>
                <section class="flex flex-col gap-2 border-b border-v2-border-border-base px-5 py-3">
                  <div class="text-12-regular text-text-weak">answer — each sentence carries its address</div>
                  <div class="text-[12px] leading-relaxed">
                    <For each={L().answer.sentences}>
                      {(sentence) => (
                        <>
                          <span>{sentence.text} </span>
                          <button
                            type="button"
                            class="cursor-pointer underline decoration-dotted"
                            classList={{ "opacity-50": tagOf(sentence).kind === "own" }}
                            onClick={() => pin(tagOf(sentence).ref)}
                          >
                            [{tagOf(sentence).label}]
                          </button>{" "}
                        </>
                      )}
                    </For>
                    <Show when={L().answer.sentences.length === 0}>{L().answer.text ?? "(no answer persisted)"}</Show>
                  </div>
                </section>
              </Show>
              <Show when={grain() === "sourced"}>
                <Grain
                  label="sources — click a [S#] in `as said`"
                  value={Object.entries(resolved()).map(([ref, bytes]) => `${ref}\n${bytes}`).join("\n\n") || "(nothing pinned yet)"}
                  tone={Object.keys(resolved()).length ? undefined : "gap"}
                />
              </Show>
              <Show when={grain() === "prompt"}>
                <Grain
                  label={`prompt — the exact bytes sent${L().prompt.ref ? ` (${L().prompt.ref})` : ""}`}
                  value={L().prompt.body ?? `(${L().prompt.gap ?? "not disclosed"})`}
                  tone={L().prompt.body ? undefined : "gap"}
                />
              </Show>
              <Show when={grain() === "record"}>
                <Grain
                  label="record — the EOT chain"
                  value={L().record.map((e) => `${e.stage} · ${e.standing} · ${e.agent}${e.unit ? ` · ${e.unit}` : ""}`).join("\n") || "(empty)"}
                  tone={L().record.length ? undefined : "gap"}
                />
              </Show>
            </>
          )}
        </Show>
      </ScrollView>
    </div>
  )
}
