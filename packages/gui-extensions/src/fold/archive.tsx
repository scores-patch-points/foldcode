import { createMemo, createSignal, For, Match, onCleanup, Switch } from "solid-js"
import { Option, Schema } from "effect"
import { Button } from "@opencode/ui/button"
import { ScrollView } from "@opencode/ui/scroll-view"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { createLatest, useExtension, type MountedSession } from "../sdk"
import { Audit, FOLD_URL, TurnView, type Turn } from "./panel"

// The Holodeck tab: every past turn in full, scrollable and explorable. Nothing clipped on purpose — a turn's
// whole prompt, tool outputs and notes are here, verbatim, with file paths that open at source.
export default function SessionHolodeckPanel(props: { session: MountedSession }) {
  const ctx = useExtension()
  const [nonce, setNonce] = createSignal(0)
  const [tick, setTick] = createSignal(0)

  const timer = setInterval(() => setTick((value) => value + 1), 1000)

  onCleanup(() => clearInterval(timer))

  const data = createLatest(
    () => `${props.session.key}#${nonce()}#${tick()}`,
    async (_key, signal) => {
      const response = await fetch(`${FOLD_URL}/v1/hooks/opencode/audit`, { signal })

      if (!response.ok) throw new Error(`fold audit ${response.status}`)

      const decoded = Schema.decodeUnknownOption(Audit)(await response.json())

      if (Option.isNone(decoded)) throw new Error("unexpected fold audit shape")

      return decoded.value
    },
  )

  const cache = new Map<string, Turn>()

  const turns = createMemo(() => {
    const next = (data.latest?.turns ?? []).map((turn) => {
      const key = `${turn.when ?? ""}#${turn.address ?? ""}`
      const kept = cache.get(key) ?? turn

      cache.set(key, kept)

      return kept
    })

    const live = new Set(next.map((turn) => `${turn.when ?? ""}#${turn.address ?? ""}`))

    for (const key of cache.keys()) if (!live.has(key)) cache.delete(key)

    return next
  })

  const refresh = () => setNonce((value) => value + 1)

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-holodeck-panel">
      <div class="foldlive flex shrink-0 flex-col gap-0.5 border-b border-v2-border-border-base px-5 py-4">
        <div class="text-13-regular text-text-base">{ctx.t("holodeck.title")}</div>
        <div class="text-12-regular text-text-weak">{ctx.t("holodeck.subtitle")}</div>
      </div>

      <div class="relative min-h-0 flex-1">
        <Switch>
          <Match when={data.loading && data.latest === undefined}>
            <div
              data-component="session-working"
              role="status"
              class="flex h-9 items-center px-5 pt-3 text-[13px] font-[530] leading-text-compact"
            >
              <TextShimmer text={ctx.t("panel.loading")} active />
            </div>
          </Match>
          <Match when={data.error !== undefined && data.latest === undefined}>
            <div class="flex h-full flex-col items-center justify-center gap-3 px-8 pb-24 text-center">
              <div class="text-13-regular text-text-weak">{ctx.t("panel.offline")}</div>
              <Button size="small" variant="outline" onClick={refresh}>
                {ctx.t("panel.retry")}
              </Button>
            </div>
          </Match>
          <Match when={turns().length > 0}>
            <ScrollView class="absolute inset-0">
              <div class="px-5">
                <For each={turns()}>{(turn, index) => <TurnView turn={turn} index={index()} total={turns().length} session={props.session} />}</For>
              </div>
            </ScrollView>
          </Match>
          <Match when={data.latest}>
            <div class="flex h-full items-center justify-center px-8 pb-24 text-center text-13-regular text-text-weak">
              {ctx.t("holodeck.empty")}
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
