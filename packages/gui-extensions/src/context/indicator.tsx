import { Show, createMemo, createSignal, onCleanup, type ComponentProps, type JSX } from "solid-js"
import { Option, Schema } from "effect"
import { Button } from "@opencode/ui/button"
import { Tooltip } from "@opencode/ui/tooltip"
import { useI18n } from "@opencode/ui/context/i18n"
import { createKeyed, useExtension, type MountedSession } from "../sdk"
import { catalogModel, syncCatalog } from "./catalog"

const FOLD_METER_URL = "http://127.0.0.1:11436/v1/hooks/opencode/meter"

/** The fold door's meter: what it kept out of the frontier's window, in estimated tokens. */
const Meter = Schema.Struct({
  savings: Schema.optional(
    Schema.Struct({
      projectedTokensEst: Schema.optional(Schema.Number),
      titleTokensEst: Schema.optional(Schema.Number),
    }),
  ),
})

const decodeMeter = Schema.decodeUnknownOption(Meter)

function ContextTooltipRow(props: { name: JSX.Element; value: JSX.Element }) {
  return (
    <div class="flex min-w-0 items-center gap-4">
      <span class="shrink-0 text-v2-text-text-muted">{props.name}</span>
      <span class="ml-auto min-w-0 truncate text-right text-v2-text-text-base">{props.value}</span>
    </div>
  )
}

export function SessionContextUsage(props: {
  session: MountedSession
  variant?: "button" | "indicator"
  placement?: ComponentProps<typeof Tooltip>["placement"]
}) {
  const ctx = useExtension()
  const layout = ctx.layout
  const i18n = useI18n()
  syncCatalog(() => props.session)

  const variant = createMemo(() => props.variant ?? "button")

  const messages = createMemo(() =>
    props.session.id ? props.session.server.data.session.message.list(props.session.id) : [],
  )

  const usd = createMemo(
    () =>
      new Intl.NumberFormat(i18n.locale(), {
        style: "currency",
        currency: "USD",
      }),
  )

  const info = createMemo(() =>
    props.session.id ? props.session.server.data.session.get(props.session.id) : undefined,
  )

  // The server's recorded usage for the whole session family, like the cost beside it: every step,
  // compaction, and title, whether or not the client has paged those messages in.
  const sessionTokens = createMemo(() =>
    props.session.id ? props.session.server.data.session.tokenTotal(props.session.id) : 0,
  )

  // A root session's cost includes its subagent sessions, as in the TUI.
  const spent = createMemo(() => (props.session.id ? props.session.server.data.session.cost(props.session.id) : 0))

  const cost = createMemo(() => usd().format(spent()))

  // Spend anywhere in the family keeps the cost visible, even when this session's model is free.
  const showCost = createMemo(() => {
    if (spent() > 0) return true
    const ref = info()?.model ?? messages().findLast((item) => item.type === "assistant")?.model
    const model = ref ? catalogModel(props.session, ref)?.model : undefined

    if (!model) return true

    return model.cost.some((cost) => cost.input > 0 || cost.output > 0 || cost.cache.read > 0 || cost.cache.write > 0)
  })

  const openContext = () => {
    if (!props.session.id) return
    layout.toggle(`${ctx.id}:main`, props.session)
  }

  // What the fold kept out of the frontier's window, read once per routed session; the local door may be down.
  const [foldSavings, setFoldSavings] = createSignal<number | undefined>()

  createKeyed(
    () => props.session.id,
    () => {
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      setFoldSavings(undefined)
      void fetch(FOLD_METER_URL, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : undefined))
        .then((json) => {
          const meter = Option.getOrUndefined(decodeMeter(json))

          if (!meter?.savings) return
          setFoldSavings((meter.savings.projectedTokensEst ?? 0) + (meter.savings.titleTokensEst ?? 0))
        })
        .catch(() => undefined)
    },
  )

  const tooltipValue = () => (
    <div class="flex w-[140px] flex-col gap-2">
      <Show when={showCost()}>
        <ContextTooltipRow name={ctx.t("usage.cost")} value={cost()} />
      </Show>
      <ContextTooltipRow name={ctx.t("usage.tokens")} value={sessionTokens().toLocaleString(i18n.locale())} />
      <Show when={foldSavings()}>
        {(savings) => (
          <ContextTooltipRow
            name={ctx.t("usage.withoutFold")}
            value={(sessionTokens() + savings()).toLocaleString(i18n.locale())}
          />
        )}
      </Show>
    </div>
  )

  return (
    <Show when={props.session.id}>
      <Tooltip
        value={variant() === "indicator" ? tooltipValue() : ctx.t("usage.toggle")}
        placement={props.placement ?? "top"}
      >
        <Button
          type="button"
          variant="ghost-muted"
          class="group shrink-0"
          style={{ padding: "0 6px", color: "var(--v2-text-text-faint)" }}
          onClick={openContext}
          aria-expanded={layout.state(`${ctx.id}:main`, props.session) === "visible"}
          aria-label={ctx.t("usage.toggle")}
        >
          <span class="flex items-center gap-2 whitespace-nowrap group-active:text-v2-text-text-muted">
            <span>
              {sessionTokens().toLocaleString(i18n.locale())} {ctx.t("usage.tokens")}
            </span>
            <Show when={showCost()}>
              <span aria-hidden="true" class="flex w-1.5 shrink-0 items-center justify-center">
                ·
              </span>
              <span>{cost()}</span>
            </Show>
          </span>
        </Button>
      </Tooltip>
    </Show>
  )
}
