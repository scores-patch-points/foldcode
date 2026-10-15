import { createMemo, createSignal, For, Match, onCleanup, Show, Switch, type JSX } from "solid-js"
import { Option, Schema } from "effect"
import { Button } from "@opencode/ui/button"
import { ScrollView } from "@opencode/ui/scroll-view"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { createLatest, useExtension, type MountedSession } from "../sdk"

// The fold door's default address. CORS is open, so the window reads the audit directly. This panel shows exactly
// what the model was sent — built from the real request, not from the fold's own claims.
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
  firstAsks: Schema.optional(Count),
  repeatAsks: Schema.optional(Count),
  titlesServedLocally: Schema.optional(Schema.Number),
  recallsServed: Schema.optional(Schema.Number),
  savings: Schema.optional(
    Schema.Struct({
      projectedChars: Schema.optional(Schema.Number),
      projectedTokensEst: Schema.optional(Schema.Number),
      savedUSD: Schema.optional(Schema.Number),
    }),
  ),
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
  if (content === undefined || content === null) return ""

  if (isString(content)) return content

  if (isArray(content)) return content.map((part) => (isObject(part) && isString(part.text) ? part.text : "")).filter(Boolean).join("\n")

  if (isObject(content) && isString(content.text)) return content.text

  return JSON.stringify(content)
}

const parseJson = (text: string) => Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text))

const num = (value: number | undefined) => value ?? 0

const isGap = (value: string) => /^(no-|nothing)/.test(value)

type Origin = "fold" | "system" | "user" | "model" | "tool"

type Part = { origin: Origin; text: string; reasoning?: string }

const ORIGIN_LABEL: Record<Origin, string> = {
  fold: "added by the fold — verbatim, not the model",
  system: "instructions (system)",
  user: "you",
  model: "the model",
  tool: "a tool result",
}

const originOf = (role: string, text: string, turn: Turn): Origin => {
  if (role === "system" && (text.includes("<fold-recall>") || text.includes("<fold-look>") || (turn.recall ? text.includes(turn.recall) : false))) return "fold"

  if (role === "system") return "system"

  if (role === "user") return "user"

  if (role === "assistant") return "model"

  return "tool"
}

const classify = (message: PromptMessage, turn: Turn): Part => {
  const text = textOf(message.content)

  const origin = originOf(message.role ?? "?", text, turn)

  return message.reasoning_content ? { origin, text, reasoning: message.reasoning_content } : { origin, text }
}

const statusOf = (turn: Turn) => {
  const bits: string[] = []

  if (turn.recall) bits.push("remembered a settled answer")

  if (turn.look && !isGap(turn.look)) bits.push("pointed the model at files in your workspace")

  const dropped = turn.project?.drop?.length ?? 0

  if (dropped) bits.push(`left out ${dropped} earlier message(s)`)

  if (bits.length === 0) return false

  return bits.join(" · ")
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="mt-1 flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">{props.title}</div>
      {props.children}
    </div>
  )
}

function Text(props: { value: string }) {
  return (
    <Show
      when={props.value.length > 400}
      fallback={<div class="whitespace-pre-wrap break-words text-13-regular text-text-base">{props.value}</div>}
    >
      <details class="min-w-0">
        <summary class="cursor-pointer text-13-regular text-text-weak">show all ({props.value.length} characters)</summary>
        <div class="whitespace-pre-wrap break-words text-13-regular text-text-base">{props.value}</div>
      </details>
    </Show>
  )
}

const PATH_RE = /(~\/|\/Users\/|\/home\/)[^\s"'`):,\]]+/g

// Text where an absolute path becomes a link that opens the file at its source (the desktop file panel).
function LinkedText(props: { text: string; session: MountedSession }) {
  const ctx = useExtension()

  const segments = createMemo(() => {
    const out: { path: boolean; value: string }[] = []
    let last = 0

    for (const match of props.text.matchAll(PATH_RE)) {
      const index = match.index ?? 0

      if (index > last) out.push({ path: false, value: props.text.slice(last, index) })

      out.push({ path: true, value: match[0] })
      last = index + match[0].length
    }

    if (last < props.text.length) out.push({ path: false, value: props.text.slice(last) })

    return out
  })

  return (
    <div class="whitespace-pre-wrap break-words text-13-regular text-text-base">
      <For each={segments()}>
        {(segment) => (
          <Show when={segment.path} fallback={<span>{segment.value}</span>}>
            <button
              type="button"
              class="cursor-pointer underline decoration-dotted"
              onClick={() => ctx.links.open({ href: segment.value, session: props.session })}
            >
              {segment.value}
            </button>
          </Show>
        )}
      </For>
    </div>
  )
}

function PromptReading(props: { turn: Turn; session: MountedSession }) {
  const doc = createMemo(() => {
    const parsed = props.turn.prompt ? parseJson(props.turn.prompt) : undefined

    return parsed === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(PromptDoc)(parsed))
  })

  const parts = createMemo(() => (doc()?.messages ?? []).map((message) => classify(message, props.turn)).filter((part) => part.text.trim().length > 0))

  return (
    <Show when={doc()} fallback={<Text value={props.turn.prompt ?? ""} />}>
      {(value) => (
        <div class="mt-2 flex flex-col gap-3">
          <div class="text-13-regular text-text-weak">model: {value().model}</div>
          <For each={parts()}>
            {(part) => (
              <div class="flex flex-col gap-1">
                <div
                  classList={{
                    "text-13-regular": true,
                    "text-v2-text-text-accent": part.origin === "fold",
                    "text-text-weak": part.origin !== "fold",
                  }}
                >
                  {ORIGIN_LABEL[part.origin]}
                </div>
                <LinkedText text={part.text} session={props.session} />
                <Show when={part.reasoning}>
                  <details>
                    <summary class="cursor-pointer text-13-regular text-text-weak">reasoning</summary>
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
  const dropped = () => props.project?.drop ?? []
  const kept = () => props.project?.keep ?? []

  return (
    <Show when={props.project && dropped().length > 0}>
      <Section title="What the fold left out of the model's view — verbatim">
        <div class="text-13-regular text-text-base">
          Left out earlier messages: {dropped().join(", ")} · kept whole: {kept().join(", ") || "none"}
        </div>
        <Show when={props.project?.record}>
          <div class="mt-1 text-12-regular text-text-weak">What stood in for them</div>
          <div class="whitespace-pre-wrap break-words text-13-regular text-text-base">{props.project?.record}</div>
        </Show>
      </Section>
    </Show>
  )
}

// The fold's reading animation, reused: the turn as a drawn watch — you → fold → model, edges drawing in and
// flowing, the fold node pulsing when it acted, a loop arc marking the fold's own move, withheld shown beside.
function Watch(props: { turn: Turn }) {
  const engaged = () => !!props.turn.recall || !!(props.turn.look && !isGap(props.turn.look)) || (props.turn.project?.drop?.length ?? 0) > 0
  const withheld = () => props.turn.project?.drop?.length ?? 0

  return (
    <svg viewBox="0 0 300 52" class="mt-1 w-full text-text-weak" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <path class="fw-edge" d="M26 30 H112" />
      <g classList={{ "text-v2-text-text-accent": engaged() }}>
        <Show when={engaged()} fallback={<path class="fw-edge" d="M144 30 H232" />}>
          <path class="fw-edge flow" d="M144 30 H232" />
          <path class="fw-arc" d="M126 12 A 20 20 0 1 0 126 48" />
        </Show>
      </g>
      <g class="fw-node" style={{ "animation-delay": "60ms" }}>
        <circle cx="20" cy="30" r="5" fill="currentColor" />
        <text x="20" y="50" text-anchor="middle" fill="currentColor" style={{ "font-size": "9px" }}>
          you
        </text>
      </g>
      <g class="fw-node" style={{ "animation-delay": "160ms" }}>
        <circle cx="128" cy="30" r="5" fill="currentColor" classList={{ "fw-dot": engaged() }} />
        <text x="128" y="50" text-anchor="middle" fill="currentColor" style={{ "font-size": "9px" }}>
          fold
        </text>
      </g>
      <g class="fw-node" style={{ "animation-delay": "260ms" }}>
        <circle cx="248" cy="30" r="5" fill="currentColor" />
        <text x="248" y="50" text-anchor="middle" fill="currentColor" style={{ "font-size": "9px" }}>
          model
        </text>
      </g>
      <Show when={withheld()}>
        <text x="128" y="12" text-anchor="middle" fill="currentColor" style={{ "font-size": "9px" }}>
          ⊘ {withheld()} withheld
        </text>
      </Show>
    </svg>
  )
}

function TurnView(props: { turn: Turn; index: number; total: number; session: MountedSession }) {
  const status = createMemo(() => statusOf(props.turn))
  const plan = createMemo(() => (props.turn.plan ?? []).map((step) => step.name).filter(Boolean).join(", "))

  return (
    <div
      class="fold-arrive flex flex-col gap-2 border-b border-v2-border-border-base py-4"
      style={{ "animation-delay": `${props.index * 45}ms` }}
    >
      <div class="text-13-regular font-[530] text-text-base">
        {props.total - props.index}. {props.turn.ask || "(no question)"}
      </div>
      <div classList={{ "text-13-regular": true, "text-text-base": !!status(), "text-text-weak": !status() }}>
        {status() ? `The fold ${status()}` : "The fold did nothing here — the request went straight to the model."}
      </div>

      <Watch turn={props.turn} />

      <Show when={props.turn.prompt}>
        <details class="mt-1">
          <summary class="cursor-pointer text-13-regular text-text-base">What the model was sent</summary>
          <PromptReading turn={props.turn} session={props.session} />
        </details>
      </Show>

      <Show when={props.turn.recall}>
        <Section title="A note the fold added from memory — verbatim">
          <Text value={props.turn.recall ?? ""} />
        </Section>
      </Show>

      <Show when={props.turn.look && !isGap(props.turn.look)}>
        <Section title="Places in your workspace the fold pointed at — verbatim">
          <Text value={props.turn.look ?? ""} />
        </Section>
      </Show>

      <Withheld project={props.turn.project} />

      <Show when={plan()}>
        <div class="text-13-regular text-text-weak">Tools the model ran here: {plan()}</div>
      </Show>

      <div class="text-13-regular text-text-weak">
        Not checked yet: whether the model used what the fold gave it, or needed what the fold left out.
      </div>

      <div class="text-13-regular text-text-weak">
        This turn: {num(props.turn.tokens?.input).toLocaleString()} in · {num(props.turn.tokens?.output).toLocaleString()} out · $
        {" "}
        {num(props.turn.cost).toFixed(4)}
      </div>
    </div>
  )
}

function Summary(props: { meter: Meter | undefined; fallbackTurns: number }) {
  const turns = () => props.meter?.turns ?? props.fallbackTurns
  const repeats = () => num(props.meter?.repeatAsks?.n)
  const recalls = () => num(props.meter?.recallsServed)
  const chars = () => num(props.meter?.savings?.projectedChars)
  const tokens = () => num(props.meter?.savings?.projectedTokensEst)

  return (
    <div class="flex shrink-0 flex-col gap-1 border-b border-v2-border-border-base px-5 py-3">
      <div class="text-13-regular text-text-base">
        {turns()} {turns() === 1 ? "turn" : "turns"} so far · {repeats()} repeated questions · {recalls()} answered from memory
      </div>
      <div class="text-13-regular text-text-base">
        Kept out of the model's view: {chars().toLocaleString()} characters (~{tokens().toLocaleString()} tokens, an estimate)
      </div>
      <div class="text-12-regular text-text-weak">
        Nothing here is measured against results yet — only what the fold did, not whether it helped.
      </div>
    </div>
  )
}

const Result = Schema.Struct({ audit: Audit, meter: Schema.optional(Meter) })

type Result = Schema.Schema.Type<typeof Result>

export default function SessionFoldPanel(props: { session: MountedSession }) {
  const ctx = useExtension()
  const [nonce, setNonce] = createSignal(0)
  const [tick, setTick] = createSignal(0)
  const [replay, setReplay] = createSignal(0)

  // Poll the door so the panel tracks turns as they land, without a manual Refresh. The audit is a local read.
  const timer = setInterval(() => setTick((value) => value + 1), 1000)

  onCleanup(() => clearInterval(timer))

  const data = createLatest(
    () => `${props.session.key}#${nonce()}#${tick()}`,
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

  // Keep turn objects stable across polls so only genuinely new turns remount (and animate in).
  const cache = new Map<string, Turn>()

  const turns = createMemo(() => {
    const next = (data.latest?.audit.turns ?? []).map((turn) => {
      const key = `${replay()}#${turn.when ?? ""}#${turn.address ?? ""}`
      const kept = cache.get(key) ?? turn

      cache.set(key, kept)

      return kept
    })

    const live = new Set(next.map((turn) => `${replay()}#${turn.when ?? ""}#${turn.address ?? ""}`))

    for (const key of cache.keys()) if (!live.has(key)) cache.delete(key)

    return next
  })

  const refresh = () => setNonce((value) => value + 1)

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-fold-panel">
      <div class="flex shrink-0 items-start justify-between gap-3 border-b border-v2-border-border-base px-5 py-4">
        <div class="flex min-w-0 flex-col gap-0.5">
          <div class="flex min-w-0 items-center gap-2">
            <button
              type="button"
              class="flex shrink-0 cursor-pointer items-center"
              aria-label={ctx.t("panel.replay")}
              title={ctx.t("panel.replay")}
              onClick={() => setReplay((value) => value + 1)}
            >
              <span class="size-1.5 animate-pulse rounded-full bg-v2-icon-icon-accent" aria-hidden="true" />
            </button>
            <div class="min-w-0 truncate text-13-regular text-text-base">{ctx.t("panel.title")}</div>
          </div>
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
                <Summary meter={value().meter} fallbackTurns={value().audit.audited ?? 0} />
                <div class="relative min-h-0 flex-1">
                  <ScrollView class="absolute inset-0">
                    <div class="px-5">
                      <For each={turns()}>{(turn, index) => <TurnView turn={turn} index={index()} total={turns().length} session={props.session} />}</For>
                    </div>
                  </ScrollView>
                </div>
              </div>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  )
}
