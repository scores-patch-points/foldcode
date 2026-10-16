import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { useExtension } from "../sdk"
import type Fold from "./index"

// The fold door's default address. The tally reads the same meter the panel
// shows, so the corner number and the panel never disagree.
const FOLD_URL = "http://127.0.0.1:11436"

// What the tally shows, reduced from the door's savings: tokens kept out of
// the frontier (projected folds + titles served by rule) and the dollars that
// kept out is estimated to be worth.
type Meter = { tokens: number; usd: number }

const money = (usd: number) => `$${usd.toFixed(4)}`

// The counter reads out tokens the fold KEPT OUT, in the compact form a person reads at a glance:
// 3130000 -> "3.13M". Two decimals from K up, a plain integer below.
const compact = (n: number) => {
  const abs = Math.abs(n)

  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`

  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`

  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`

  return String(Math.round(n))
}

export default function FoldTally() {
  const ctx = useExtension<typeof Fold>()

  const [meter, setMeter] = createSignal<Meter | undefined>()
  const [offline, setOffline] = createSignal(false)

  const poll = () => {
    void fetch(`${FOLD_URL}/v1/hooks/opencode/meter`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`meter ${r.status}`))))
      .then((data) => {
        // SAFETY: this is the fold door's own JSON; we read only these three numeric savings fields and
        // coerce each through Number, so a wrong shape yields 0 rather than a thrown read.
        const savings = (data?.savings ?? {}) as { projectedTokensEst?: number; titleTokensEst?: number; savedUSD?: number }
        const projected = Number(savings.projectedTokensEst ?? 0) || 0
        const titles = Number(savings.titleTokensEst ?? 0) || 0
        const usd = Number(savings.savedUSD ?? 0) || 0
        setMeter({ tokens: projected + titles, usd })
        setOffline(false)
      })
      .catch(() => setOffline(true))
  }

  poll()
  const timer = setInterval(poll, 5000)
  onCleanup(() => clearInterval(timer))

  const tally = ctx.stores.tally
  const hidden = () => tally.value.hidden
  const baseline = () => tally.value.baseline

  const tokens = createMemo(() => Math.max(0, (meter()?.tokens ?? 0) - baseline().tokens))
  const usd = createMemo(() => Math.max(0, (meter()?.usd ?? 0) - baseline().usd))

  const reset = () => {
    const now = meter()

    if (!now) return

    tally.update((draft) => {
      draft.baseline = { tokens: now.tokens, usd: now.usd }
    })
  }

  const hide = () => tally.update((draft) => void (draft.hidden = true))
  const show = () => tally.update((draft) => void (draft.hidden = false))

  return (
    <Show
      when={!hidden()}
      fallback={
        <Tooltip placement="bottom" value={ctx.t("tally.show")}>
          <button
            type="button"
            class="flex size-5 shrink-0 items-center justify-center rounded-full text-v2-icon-icon-muted hover:bg-v2-background-bg-layer-02 hover:text-v2-icon-icon-base focus-visible:outline-none [app-region:no-drag]"
            onClick={show}
            aria-label={ctx.t("tally.show")}
          >
            <Icon name="outline-eye" size="small" />
          </button>
        </Tooltip>
      }
    >
      <div class="flex h-5 shrink-0 items-center gap-0.5 rounded-full bg-v2-background-bg-layer-02 ps-2 pe-1 [app-region:no-drag]">
        <Tooltip placement="bottom" value={`${ctx.t("tally.title")} (${money(usd())})`}>
          <span
            class="shrink-0 whitespace-nowrap text-[11px] leading-4 text-v2-text-text-muted"
            classList={{ "opacity-60": offline() }}
          >
            {offline() ? ctx.t("tally.offline") : `${compact(tokens())} ${ctx.t("tally.saved")}`}
          </span>
        </Tooltip>
        <button
          type="button"
          class="flex size-4 shrink-0 items-center justify-center rounded-full text-v2-icon-icon-muted hover:bg-v2-background-bg-layer-03 hover:text-v2-icon-icon-base focus-visible:outline-none"
          onClick={reset}
          aria-label={ctx.t("tally.reset")}
          disabled={!meter()}
        >
          <Icon name="refresh" size="small" />
        </button>
        <button
          type="button"
          class="flex size-4 shrink-0 items-center justify-center rounded-full text-v2-icon-icon-muted hover:bg-v2-background-bg-layer-03 hover:text-v2-icon-icon-base focus-visible:outline-none"
          onClick={hide}
          aria-label={ctx.t("tally.hide")}
        >
          <Icon name="xmark-small" size="small" />
        </button>
      </div>
    </Show>
  )
}
