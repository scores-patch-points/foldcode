import { createMemo, createSignal, Match, Switch } from "solid-js"
import { Option, Schema } from "effect"
import { Button } from "@opencode/ui/button"
import { ScrollView } from "@opencode/ui/scroll-view"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { Markdown } from "@opencode/session-ui/markdown"
import { createLatest, useExtension, type MountedSession } from "../sdk"

// The fold door's default address (FOLD_URL on the doorway side). CORS is open, so the window reads the audit
// directly; the panel only discloses, it never prompts.
const FOLD_URL = "http://127.0.0.1:11436"

const Turn = Schema.Struct({
  when: Schema.optional(Schema.String),
  ask: Schema.optional(Schema.String),
  address: Schema.optional(Schema.String),
  recall: Schema.optional(Schema.NullOr(Schema.String)),
  look: Schema.optional(Schema.NullOr(Schema.String)),
  project: Schema.optional(Schema.Json),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  repeat: Schema.optional(Schema.Number),
  settled: Schema.optional(Schema.Boolean),
})

type Turn = Schema.Schema.Type<typeof Turn>

const Audit = Schema.Struct({
  door: Schema.optional(Schema.String),
  schema: Schema.optional(Schema.String),
  audited: Schema.optional(Schema.Number),
  turns: Schema.optional(Schema.Array(Turn)),
})

type Audit = Schema.Schema.Type<typeof Audit>

const clip = (text: string, max = 600) => {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max}]` : text
}

// A turn becomes markdown. The door's mechanical cut rides its own fenced `snip` code block, so the snipped
// material is a separate block by construction, never mixed with anything the model wrote.
const toMarkdown = (audit: Audit) => {
  const turns = audit.turns ?? []

  if (turns.length === 0) return ""

  const one = (turn: Turn, index: number) => {
    const parts = [
      `### ${turns.length - index}. ${clip(turn.ask ?? "", 160)}`,
      `**address** \`${turn.address ?? "?"}\` · ${turn.repeat ? `repeat ×${turn.repeat}` : "first ask"} · ${turn.settled ? "settled" : "open"}`,
      `**title by rule** ${turn.title ? clip(turn.title, 120) : "—"}`,
    ]

    if (turn.recall) parts.push(`**recall injected**\n\n${clip(turn.recall)}`)

    if (turn.look) parts.push(`**look**\n\n${clip(turn.look)}`)

    const cut = turn.project === undefined ? "nothing cut this turn — every exchange rode" : clip(JSON.stringify(turn.project), 1200)

    parts.push(["```snip", cut, "```"].join("\n"))

    return parts.join("\n\n")
  }

  return turns.map(one).join("\n\n---\n\n")
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

  const markdown = createMemo(() => toMarkdown(audit.latest ?? {}))

  const refresh = () => setNonce((value) => value + 1)

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-fold-panel">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-v2-border-border-base px-5 py-4">
        <div class="min-w-0 truncate text-13-regular text-text-weak">{ctx.t("panel.title")}</div>
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
          <Match when={markdown()}>
            <ScrollView class="absolute inset-0">
              <div class="px-5 py-4 pb-8">
                <Markdown text={markdown()} class="text-14-regular" />
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
