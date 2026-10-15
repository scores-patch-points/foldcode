import { createMemo, createSignal, Match, Switch } from "solid-js"
import { Option, Schema } from "effect"
import { Button } from "@opencode/ui/button"
import { ScrollView } from "@opencode/ui/scroll-view"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { Markdown } from "@opencode/session-ui/markdown"
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

const Turn = Schema.Struct({
  when: Schema.optional(Schema.String),
  ask: Schema.optional(Schema.String),
  address: Schema.optional(Schema.String),
  recall: Schema.optional(Schema.NullOr(Schema.String)),
  look: Schema.optional(Schema.NullOr(Schema.String)),
  project: Schema.optional(Project),
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

const clip = (text: string, max = 600) => {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max}]` : text
}

// The mechanical cut, verbatim: which earlier exchanges were left out, which ride whole, and the record that
// stood in for the dropped ones. Address/line-based, never embedded or scored.
const verbatimCut = (project: Project | undefined) => {
  if (project === undefined) return "**the mechanical cut** — none (no earlier exchanges to snip)"

  if (project.gap) return `**the mechanical cut** — none (${project.gap})`

  const drop = project.drop ?? []
  const keep = project.keep ?? []

  return [
    "**the mechanical cut** — verbatim, no vectors, no RAG",
    "```snip",
    `cut (left out of the frontier): ${drop.length}${drop.length ? ` — ${drop.join(", ")}` : ""}`,
    `kept (ride whole): ${keep.length ? keep.join(", ") : "none"}`,
    "record (the verbatim stand-in):",
    project.record || "(none)",
    "```",
  ].join("\n")
}

// A turn becomes markdown. The exact prompt and the mechanical cut each ride their own fenced block, so bytes
// from the door are physically separate from anything the model wrote.
const toMarkdown = (audit: Audit) => {
  const turns = audit.turns ?? []

  if (turns.length === 0) return ""

  const one = (turn: Turn, index: number) => {
    const parts = [
      `### ${turns.length - index}. ${clip(turn.ask ?? "", 160)}`,
      `**address** \`${turn.address ?? "?"}\` · ${turn.repeat ? `repeat ×${turn.repeat}` : "first ask"} · ${turn.settled ? "settled" : "open"}`,
      `**title by rule** ${turn.title ? clip(turn.title, 120) : "—"}`,
    ]

    if (turn.prompt) parts.push(["**the exact prompt the frontier received** — verbatim", "```prompt", turn.prompt, "```"].join("\n"))

    if (turn.recall) parts.push(`**recall injected** — verbatim\n\n${clip(turn.recall)}`)

    if (turn.look) parts.push(`**look** — verbatim addresses\n\n${clip(turn.look)}`)

    parts.push(verbatimCut(turn.project))

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
      <div class="flex shrink-0 flex-col gap-0.5 border-b border-v2-border-border-base px-5 py-4">
        <div class="min-w-0 truncate text-13-regular text-text-base">{ctx.t("panel.title")}</div>
        <div class="min-w-0 truncate text-12-regular text-text-weak">{ctx.t("panel.subtitle")}</div>
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
