import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { Option, Schema } from "effect"
import { Button } from "@opencode/ui/button"
import { ScrollView } from "@opencode/ui/scroll-view"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { createLatest, useExtension, type MountedSession } from "../sdk"

// The fold door's default address (FOLD_URL on the doorway side). CORS is open, so the window reads the audit
// directly. This panel is a trust surface: it derives from the bytes the frontier received, never from the door's
// claims, so injected (non-model) material and model-authored material can never be confused.
const FOLD_URL = "http://127.0.0.1:11436"

const Project = Schema.Struct({
  drop: Schema.optional(Schema.Array(Schema.String)),
  keep: Schema.optional(Schema.Array(Schema.String)),
  record: Schema.optional(Schema.String),
  droppedChars: Schema.optional(Schema.Number),
  gap: Schema.optional(Schema.String),
})

type Project = Schema.Schema.Type<typeof Project>

const PlanStep = Schema.Struct({ name: Schema.optional(Schema.String), ok: Schema.optional(Schema.NullOr(Schema.Boolean)) })

const Turn = Schema.Struct({
  when: Schema.optional(Schema.String),
  ask: Schema.optional(Schema.String),
  address: Schema.optional(Schema.String),
  recall: Schema.optional(Schema.NullOr(Schema.String)),
  look: Schema.optional(Schema.NullOr(Schema.String)),
  project: Schema.optional(Schema.NullOr(Project)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  repeat: Schema.optional(Schema.Number),
  settled: Schema.optional(Schema.Boolean),
  plan: Schema.optional(Schema.Array(PlanStep)),
  answer: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Number),
  tokens: Schema.optional(Schema.Struct({ input: Schema.optional(Schema.Number), output: Schema.optional(Schema.Number) })),
  prompt: Schema.optional(Schema.NullOr(Schema.String)),
})

type Turn = Schema.Schema.Type<typeof Turn>

const Audit = Schema.Struct({
  door: Schema.optional(Schema.String),
  schema: Schema.optional(Schema.String),
  audited: Schema.optional(Schema.Number),
  turns: Schema.optional(Schema.Array(Turn)),
})

type Audit = Schema.Schema.Type<typeof Audit>

const Count = Schema.Struct({ n: Schema.optional(Schema.Number), tokens: Schema.optional(Schema.Number), recalled: Schema.optional(Schema.Number) })

const Meter = Schema.Struct({
  turns: Schema.optional(Schema.Number),
  classes: Schema.optional(Schema.Number),
  firstAsks: Schema.optional(Count),
  repeatAsks: Schema.optional(Count),
  titlesServedLocally: Schema.optional(Schema.Number),
  recallsServed: Schema.optional(Schema.Number),
  savings: Schema.optional(
    Schema.Struct({
      projectedChars: Schema.optional(Schema.Number),
      projectedTokensEst: Schema.optional(Schema.Number),
      titleTokensEst: Schema.optional(Schema.Number),
      savedUSD: Schema.optional(Schema.Number),
      folds: Schema.optional(Schema.Number),
      note: Schema.optional(Schema.String),
    }),
  ),
  unmeasured: Schema.optional(Schema.Array(Schema.String)),
})

type Meter = Schema.Schema.Type<typeof Meter>

const PromptMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Json),
  reasoning_content: Schema.optional(Schema.String),
})

type PromptMessage = Schema.Schema.Type<typeof PromptMessage>

const PromptDoc = Schema.Struct({
  model: Schema.optional(Schema.String),
  messages: Schema.optional(Schema.Array(PromptMessage)),
})

type PromptDoc = Schema.Schema.Type<typeof PromptDoc>

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Json))

const isArray = Schema.is(Schema.Array(Schema.Json))

const isString = Schema.is(Schema.String)

const textOf = (content: Schema.Json | undefined): string => {
  if (content === undefined) return ""

  if (isString(content)) return content

  if (isArray(content)) return content.map((part) => (isObject(part) && isString(part.text) ? part.text : "")).filter(Boolean).join("\n")

  if (isObject(content) && isString(content.text)) return content.text

  return JSON.stringify(content)
}

const parseJson = (text: string) => Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text))

const num = (value: number | undefined) => value ?? 0

type Origin = "fold" | "system" | "user" | "model" | "tool"

type Part = { role: string; origin: Origin; text: string; reasoning?: string }

const ORIGIN_LABEL: Record<Origin, string> = {
  fold: "fold-injected — verbatim, non-model",
  system: "system (harness)",
  user: "user ask",
  model: "model",
  tool: "tool result",
}

const originOf = (role: string, text: string, turn: Turn): Origin => {
  if (role === "system" && (text.includes("<fold-recall>") || text.includes("<fold-look>") || (turn.recall ? text.includes(turn.recall) : false))) return "fold"

  if (role === "system") return "system"

  if (role === "user") return "user"

  if (role === "assistant") return "model"

  return "tool"
}

// Classify each prompt message by origin, from the bytes actually sent. A system note the door injected is
// marked fold; the model's own words are marked model. This is the separation the model cannot forge.
const classify = (message: PromptMessage, turn: Turn): Part => {
  const text = textOf(message.content)

  const role = message.role ?? "?"

  const origin = originOf(role, text, turn)

  return message.reasoning_content ? { role, origin, text, reasoning: message.reasoning_content } : { role, origin, text }
}

const disposition = (turn: Turn) => {
  const bits: string[] = []

  if (turn.recall) bits.push("recalled a settled ask")

  if (turn.look && !/^(no-|nothing)/.test(turn.look)) bits.push("looked addresses in the workspace")

  const dropped = turn.project?.drop?.length ?? 0

  if (dropped) bits.push(`withheld ${dropped} exchange(s)`)

  if (bits.length === 0) return { engaged: false, text: "idle — nothing to recall, look up, or withhold; the request went through as upstream" }

  return { engaged: true, text: bits.join(" · ") }
}

function Field(props: { label: string; value: string }) {
  return (
    <div class="mt-1 flex flex-col gap-0.5">
      <div class="text-12-regular text-text-weak">{props.label}</div>
      <Show
        when={props.value.length > 400}
        fallback={<div class="whitespace-pre-wrap break-words text-13-regular text-text-base">{props.value}</div>}
      >
        <details class="min-w-0">
          <summary class="cursor-pointer text-12-regular text-text-weak">
            {props.value.slice(0, 200)}… ({props.value.length} chars)
          </summary>
          <div class="whitespace-pre-wrap break-words text-13-regular text-text-base">{props.value}</div>
        </details>
      </Show>
    </div>
  )
}

function PromptReading(props: { turn: Turn }) {
  const doc = createMemo(() => {
    const parsed = props.turn.prompt ? parseJson(props.turn.prompt) : undefined

    return parsed === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(PromptDoc)(parsed))
  })

  const parts = createMemo(() => (doc()?.messages ?? []).map((message) => classify(message, props.turn)))

  return (
    <Show when={doc()} fallback={<Field label="prompt — verbatim" value={props.turn.prompt ?? ""} />}>
      {(value) => (
        <div class="mt-2 flex flex-col gap-3">
          <div class="text-12-regular text-text-weak">model · {value().model}</div>
          <For each={parts()}>
            {(part) => (
              <div class="flex flex-col gap-1">
                <div
                  classList={{
                    "text-12-regular": true,
                    "text-text-weak": part.origin !== "fold",
                    "text-v2-text-text-accent": part.origin === "fold",
                  }}
                >
                  {part.origin === "fold" ? "fold-injected — verbatim, non-model" : ORIGIN_LABEL[part.origin]}
                </div>
                <div class="whitespace-pre-wrap break-words text-13-regular text-text-base">{part.text}</div>
                <Show when={part.reasoning}>
                  <details>
                    <summary class="cursor-pointer text-12-regular text-text-weak">reasoning</summary>
                    <div class="whitespace-pre-wrap break-words text-13-regular text-text-base">{part.reasoning}</div>
                  </details>
                </Show>
              </div>
            )}
          </For>
        </div>
      )}
    </Show>
  )
}

function Withheld(props: { project: Project | null | undefined }) {
  return (
    <Show when={props.project}>
      {(project) => (
        <div class="mt-1 flex flex-col gap-1">
          <div class="text-12-regular text-text-weak">withheld — verbatim, address-based, no vectors</div>
          <Show
            when={(project().drop ?? []).length}
            fallback={<div class="text-13-regular text-text-base">none withheld</div>}
          >
            <div class="text-13-regular text-text-base">
              left out of the frontier: {(project().drop ?? []).join(", ")} · kept whole: {(project().keep ?? []).join(", ") || "none"}
            </div>
          </Show>
          <Show when={project().record}>
            <div class="mt-0.5 text-12-regular text-text-weak">the stand-in record</div>
            <div class="whitespace-pre-wrap break-words text-13-regular text-text-base">{project().record}</div>
          </Show>
          <Show when={project().gap}>
            <div class="text-13-regular text-text-base">no projection: {project().gap}</div>
          </Show>
        </div>
      )}
    </Show>
  )
}

function TurnView(props: { turn: Turn; index: number; total: number }) {
  const state = createMemo(() => disposition(props.turn))
  const plan = createMemo(() => (props.turn.plan ?? []).map((step) => step.name).filter(Boolean).join(", "))

  return (
    <div class="flex flex-col gap-2 border-b border-v2-border-border-base py-4">
      <div class="text-13-regular font-[530] text-text-base">
        {props.total - props.index}. {props.turn.ask || "(no ask)"}
      </div>
      <div classList={{ "text-12-regular": true, "text-text-base": state().engaged, "text-text-weak": !state().engaged }}>
        {state().text}
      </div>

      <Show when={props.turn.prompt}>
        <details class="mt-1">
          <summary class="cursor-pointer text-12-regular text-text-weak">
            the prompt the frontier received — reconstructed, by origin
          </summary>
          <PromptReading turn={props.turn} />
        </details>
      </Show>

      <Show when={props.turn.recall}>
        <Field label="recall injected — verbatim" value={props.turn.recall ?? ""} />
      </Show>

      <Show when={props.turn.look}>
        <Field label="look — verbatim addresses" value={props.turn.look ?? ""} />
      </Show>

      <Withheld project={props.turn.project} />

      <Show when={plan()}>
        <div class="text-12-regular text-text-weak">the model ran: {plan()}</div>
      </Show>

      <div class="text-12-regular text-text-weak">
        effect: not measured — whether the model used what was injected, or re-read what was withheld, needs the
        tool arguments, which this turn did not record
      </div>

      <div class="text-12-regular text-text-weak">
        this turn: in {num(props.turn.tokens?.input).toLocaleString()} · out {num(props.turn.tokens?.output).toLocaleString()} ·
        $ {num(props.turn.cost).toFixed(4)}
      </div>
    </div>
  )
}

function MeterHeader(props: { meter: Meter | undefined }) {
  return (
    <div class="flex shrink-0 flex-col gap-0.5 border-b border-v2-border-border-base px-5 py-3 text-12-regular text-text-weak">
      <div class="text-text-base">{props.meter ? "session meter" : "session meter — unavailable"}</div>
      <Show when={props.meter}>
        {(meter) => (
          <>
            <div>
              kept out of the frontier: {num(meter().savings?.projectedChars).toLocaleString()} chars ≈{" "}
              {num(meter().savings?.projectedTokensEst).toLocaleString()} tokens (estimated, chars/4)
            </div>
            <div>titles served by rule: {num(meter().titlesServedLocally)} · recalls served: {num(meter().recallsServed)}</div>
            <div>
              frontier bought: {num(meter().turns)} turns · first {num(meter().firstAsks?.n)} · repeats {num(meter().repeatAsks?.n)} (
              {num(meter().repeatAsks?.recalled)} recalled)
            </div>
            <div>estimated saved: $ {num(meter().savings?.savedUSD).toFixed(4)}</div>
            <div>unmeasured: {(meter().unmeasured ?? []).join(", ")}</div>
          </>
        )}
      </Show>
    </div>
  )
}

const Result = Schema.Struct({ audit: Audit, meter: Schema.optional(Meter) })

type Result = Schema.Schema.Type<typeof Result>

export default function SessionFoldPanel(props: { session: MountedSession }) {
  const ctx = useExtension()
  const [nonce, setNonce] = createSignal(0)

  const data = createLatest(
    () => `${props.session.key}#${nonce()}`,
    async (_key, signal) => {
      const [audit, meter] = await Promise.all([
        fetch(`${FOLD_URL}/v1/hooks/opencode/audit`, { signal }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`audit ${r.status}`)))),
        fetch(`${FOLD_URL}/v1/hooks/opencode/meter`, { signal })
          .then((r) => (r.ok ? r.json() : undefined))
          .catch(() => undefined),
      ])

      const decoded = Schema.decodeUnknownOption(Result)({ audit, meter })

      if (Option.isNone(decoded)) throw new Error("unexpected fold audit shape")

      return decoded.value
    },
  )

  const turns = createMemo(() => data.latest?.audit.turns ?? [])

  const refresh = () => setNonce((value) => value + 1)

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-fold-panel">
      <div class="flex shrink-0 items-start justify-between gap-3 border-b border-v2-border-border-base px-5 py-4">
        <div class="flex min-w-0 flex-col gap-0.5">
          <div class="min-w-0 truncate text-13-regular text-text-base">{ctx.t("panel.title")}</div>
          <div class="min-w-0 truncate text-12-regular text-text-weak">{ctx.t("panel.subtitle")}</div>
        </div>
        <Button size="small" variant="outline" onClick={refresh}>
          {ctx.t("panel.refresh")}
        </Button>
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
          <Match when={data.latest}>
            {(value) => (
              <div class="flex h-full min-h-0 flex-col">
                <MeterHeader meter={value().meter} />
                <ScrollView class="absolute inset-x-0 bottom-0 top-[92px]">
                  <div class="px-5">
                    <For each={turns()}>{(turn, index) => <TurnView turn={turn} index={index()} total={turns().length} />}</For>
                  </div>
                </ScrollView>
              </div>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  )
}
