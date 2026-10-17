import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { Option, Schema } from "effect"
import { Icon } from "@opencode/ui/icon"
import { Tooltip } from "@opencode/ui/tooltip"
import { compact, money } from "@opencode/util/savings"
import { doorHealth, type DoorHealth } from "./health"
import { useExtension } from "../sdk"
import type Fold from "./index"

// The fold door's default address. The tally reads the same meter the panel
// shows, so the corner number and the panel never disagree.
const FOLD_URL = "http://127.0.0.1:11436"

// The door's contract as the tally reads it: the event names it serves (a fold door serves
// "ground") and the sense hunt's found organs. Decoded at the boundary, so the verdict reads a
// typed value instead of probing a shape.
const Contract = Schema.Struct({
  events: Schema.optionalKey(Schema.Array(Schema.String)),
  senses: Schema.optionalKey(Schema.Struct({ found: Schema.optionalKey(Schema.Array(Schema.Unknown)) })),
})

// What the tally shows, reduced from the door's savings: tokens kept out of
// the frontier (projected folds + titles served by rule) and the dollars that
// kept out is estimated to be worth.
type Meter = { tokens: number; usd: number }

// The tally reads the money and token shape from @opencode/util/savings, the same one the Sent
// panel and the door's /fold readout use — the corner number and those never disagree.

export default function FoldTally() {
  const ctx = useExtension<typeof Fold>()

  const [meter, setMeter] = createSignal<Meter | undefined>()
  const [health, setHealth] = createSignal<DoorHealth>()

  // The contract answers whether a fold door is there at all; the meter answers what it saved. The
  // health verdict lets the pill name WHICH invariant is broken (no door / not a ground door)
  // instead of showing a stale number when the app is grounding nothing.
  const pollHealth = async () => {
    try {
      const r = await fetch(`${FOLD_URL}/v1/hooks/opencode`)

      if (!r.ok) throw new Error(`contract ${r.status}`)

      const contract = Option.getOrUndefined(Schema.decodeUnknownOption(Contract)(await r.json()))
      setHealth(doorHealth({ reachable: true, events: contract?.events ?? [], senses: contract?.senses?.found?.length ?? 0 }))
    } catch {
      setHealth(doorHealth({ reachable: false }))
    }
  }

  const pollMeter = () => {
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
      })
      .catch(() => undefined)
  }

  const poll = () => {
    void pollHealth()
    pollMeter()
  }

  poll()
  const timer = setInterval(poll, 5000)
  onCleanup(() => clearInterval(timer))

  const tally = ctx.stores.tally
  const hidden = () => tally.value.hidden
  const baseline = () => tally.value.baseline

  const tokens = createMemo(() => Math.max(0, (meter()?.tokens ?? 0) - baseline().tokens))
  const usd = createMemo(() => Math.max(0, (meter()?.usd ?? 0) - baseline().usd))

  // A door that is down or not a fold door means no turn is being ground; the pill says so.
  const ungrounded = () => {
    const state = health()?.state

    return state === "down" || state === "incompatible"
  }

  const label = () => {
    const state = health()?.state

    if (state === "down") return ctx.t("tally.offline")

    if (state === "incompatible") return ctx.t("tally.incompatible")

    return ctx.t("tally.saved", { tokens: compact(tokens()), money: money(usd()) })
  }

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
        <Tooltip placement="bottom" value={ctx.t("tally.title")}>
          <span
            class="shrink-0 whitespace-nowrap text-[11px] leading-4 text-v2-text-text-muted"
            classList={{ "opacity-60": ungrounded() }}
          >
            {label()}
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
