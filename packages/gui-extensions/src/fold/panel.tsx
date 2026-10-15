import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { Option, Schema } from "effect"
import { Button } from "@opencode/ui/button"
import { ScrollView } from "@opencode/ui/scroll-view"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { createLatest, useExtension, type MountedSession } from "../sdk"

// The fold door's default address (FOLD_URL on the doorway side). CORS is open, so the window reads the audit
// directly; the panel only discloses, it never prompts, embeds, or ranks.
const FOLD_URL = "http://127.0.0.1:11436"

const Project = Schema.Struct({
  drop: Schema.optional(Schema.Array(Schema.String)),
  keep: Schema.optional(Schema.Array(Schema.String)),
  record: Schema.optional(Schema.String),
  droppedChars: Schema.optional(Schema.Number),
  gap: Schema.optional(Schema.String),
})

type Project = Schema.Schema.Type<typeof Project>

const PromptMessage = Schema.Struct({
  role: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Json),
  reasoning_content: Schema.optional(Schema.String),
})

const PromptDoc = Schema.Struct({
  model: Schema.optional(Schema.String),
  messages: Schema.optional(Schema.Array(PromptMessage)),
})

type PromptDoc = Schema.Schema.Type<typeof PromptDoc>

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

const isObject = Schema.is(Schema.Record(Schema.String, Schema.Json))

const isArray = Schema.is(Schema.Array(Schema.Json))

const isString = Schema.is(Schema.String)

// The readable text of a message content: a string as-is, a parts array concatenated, an object's text field.
const textOf = (content: Schema.Json | undefined): string => {
  if (content === undefined) return ""

  if (isString(content)) return content

  if (isArray(content)) return content.map((part) => (isObject(part) && isString(part.text) ? part.text : "")).filter(Boolean).join("\n")

  if (isObject(content) && isString(content.text)) return content.text

  return JSON.stringify(content)
}

const parseJson = (text: string) => {
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text)

  return Option.getOrUndefined(decoded)
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

function PromptView(props: { text: string }) {
  const doc = createMemo(() => {
    const parsed = parseJson(props.text)

    return parsed === undefined ? undefined : Option.getOrUndefined(Schema.decodeUnknownOption(PromptDoc)(parsed))
  })

  return (
    <Show when={doc()} fallback={<Field label="prompt — verbatim" value={props.text} />}>
      {(value) => (
        <div class="mt-2 flex flex-col gap-3">
          <Show when={value().model}>
            <div class="text-12-regular text-text-weak">model · {value().model}</div>
          </Show>
          <For each={value().messages ?? []}>
            {(message) => (
              <div class="flex flex-col gap-1">
                <div class="text-12-regular text-text-weak">{message.role ?? "message"}</div>
                <div class="whitespace-pre-wrap break-words text-13-regular text-text-base">{textOf(message.content)}</div>
                <Show when={message.reasoning_content}>
                  <details>
                    <summary class="cursor-pointer text-12-regular text-text-weak">reasoning</summary>
                    <div class="whitespace-pre-wrap break-words text-13-regular text-text-base">{message.reasoning_content}</div>
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

function Cut(props: { project: Project | null | undefined }) {
  const summary = () => {
    const project = props.project

    if (!project) return "none — no earlier exchanges to snip"

    if (project.gap) return `none — ${project.gap}`

    const drop = (project.drop ?? []).join(", ") || "none"
    const keep = (project.keep ?? []).join(", ") || "none"

    return `cut: ${drop} · kept: ${keep}`
  }

  return (
    <div class="mt-1 flex flex-col gap-1">
      <div class="text-12-regular text-text-weak">the mechanical cut — verbatim, no vectors, no RAG</div>
      <div class="text-13-regular text-text-base">{summary()}</div>
      <Show when={props.project?.record}>
        <div class="whitespace-pre-wrap break-words text-13-regular text-text-base">{props.project?.record}</div>
      </Show>
    </div>
  )
}

function TurnView(props: { turn: Turn; index: number; total: number }) {
  return (
    <div class="flex flex-col gap-2 border-b border-v2-border-border-base py-4">
      <div class="text-13-regular font-[530] text-text-base">
        {props.total - props.index}. {props.turn.ask || "(no ask)"}
      </div>
      <div class="flex flex-wrap gap-x-4 text-12-regular text-text-weak">
        <span>address {props.turn.address ?? "?"}</span>
        <span>{props.turn.repeat ? `repeat ×${props.turn.repeat}` : "first ask"}</span>
        <span>{props.turn.settled ? "settled" : "open"}</span>
      </div>
      <Show when={props.turn.title}>
        <div class="text-12-regular text-text-weak">title by rule: {props.turn.title}</div>
      </Show>

      <Show when={props.turn.prompt}>
        <details class="mt-1">
          <summary class="cursor-pointer text-12-regular text-text-weak">
            the exact prompt the frontier received — verbatim
          </summary>
          <PromptView text={props.turn.prompt ?? ""} />
        </details>
      </Show>

      <Show when={props.turn.recall}>
        <Field label="recall injected — verbatim" value={props.turn.recall ?? ""} />
      </Show>

      <Show when={props.turn.look}>
        <Field label="look — verbatim addresses" value={props.turn.look ?? ""} />
      </Show>

      <Cut project={props.turn.project} />
    </div>
  )
}

export default function SessionFoldPanel(props: { session: MountedSession }) {
  const ctx = useExtension()
  const [nonce, setNonce] = createSignal(0)

  const audit = createLatest(
    () => `${props.session.key}#${nonce()}`,
    async (_key, signal) => {
      const response = await fetch(`${FOLD_URL}/v1/hooks/opencode/audit`, { signal })

      if (!response.ok) throw new Error(`fold audit ${response.status}`)

      const decoded = Schema.decodeUnknownOption(Audit)(await response.json())

      if (Option.isNone(decoded)) throw new Error("unexpected fold audit shape")

      return decoded.value
    },
  )

  const turns = createMemo(() => audit.latest?.turns ?? [])

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
          <Match when={audit.loading && audit.latest === undefined}>
            <div
              data-component="session-working"
              role="status"
              class="flex h-9 items-center px-5 pt-3 text-[13px] font-[530] leading-text-compact"
            >
              <TextShimmer text={ctx.t("panel.loading")} active />
            </div>
          </Match>
          <Match when={audit.error !== undefined && audit.latest === undefined}>
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
                <For each={turns()}>{(turn, index) => <TurnView turn={turn} index={index()} total={turns().length} />}</For>
              </div>
            </ScrollView>
          </Match>
          <Match when={audit.latest}>
            <div class="flex h-full items-center justify-center px-8 pb-24 text-center text-13-regular text-text-weak">
              {ctx.t("panel.empty")}
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
