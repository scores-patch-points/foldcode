import { For, Show, createSignal } from "solid-js"
import { siteOf, typeOf } from "./fold-site-type"

/** A source's words, clipped: set in the source's own typesetting (its faces, ink and paper), named as the source names itself,
 *  so the quote reads as borrowed rather than as ours. Opens the source when it can. */
export function SourceClip(props: { text: string; source?: string; url?: string; refText?: string; onOpen?: () => void }) {
  const named = () => ({ name: props.source ?? "material", url: props.url, ref: props.refText })
  const type = () => typeOf(named())
  const label = () => siteOf(named())
  return (
    <Show
      when={props.onOpen}
      fallback={<ClipBody text={props.text} type={type()} site={label().site} title={label().title} />}
    >
      {(open) => (
        <button
          type="button"
          class="block w-full cursor-pointer text-start transition-shadow hover:shadow-sm"
          title="Open the source"
          onClick={(event) => {
            event.stopPropagation()
            open()()
          }}
        >
          <ClipBody text={props.text} type={type()} site={label().site} title={label().title} />
        </button>
      )}
    </Show>
  )
}

function ClipBody(props: { text: string; type: ReturnType<typeof typeOf>; site: string; title: string }) {
  return (
    <span
      data-slot="fold-clip"
      class="block overflow-hidden rounded-md"
      style={{ background: props.type.bg, color: props.type.ink, border: `1px solid ${props.type.edge}` }}
    >
      <span class="flex items-center gap-1.5 px-2 pt-1.5 text-[11px] leading-4" style={{ "font-family": props.type.title }}>
        <span
          class="flex size-3.5 shrink-0 items-center justify-center rounded-sm text-[9px] font-semibold"
          style={{ background: props.type.favBg, color: props.type.favFg, border: `1px solid ${props.type.edge}` }}
        >
          {props.type.fav}
        </span>
        <span class="truncate opacity-75">
          {props.site} · {props.title}
        </span>
      </span>
      <span class="block px-2 pt-1 pb-2 text-[13px] leading-[1.45] break-words" style={{ "font-family": props.type.body }}>
        {"“"}
        {props.text}
        {"”"}
      </span>
    </span>
  )
}

/** Two quotes are one when they read the same, whitespace and case aside, over their first eighty letters. */
const sameQuote = (a: string, b: string) => {
  const key = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80)
  return key(a) === key(b)
}

/** The ground of a run of the answer's sentences that rest on one page: the page named and set in its own typesetting, the source
 *  sentences they rest on quoted in its words (one shown, clamped, the rest on request), and how many of the answer's sentences it carries.
 *  The count opens the page with those sentences marked. */
export function SourceRun(props: {
  source?: string
  url?: string
  refText?: string
  quotes: string[]
  n: number
  active?: boolean
  onOpen?: () => void
}) {
  const [all, setAll] = createSignal(false)
  const named = () => ({ name: props.source ?? "material", url: props.url, ref: props.refText })
  const type = () => typeOf(named())
  const label = () => siteOf(named())
  // one quote by default, clamped to three lines, so a card stays beside the sentences it grounds; the rest on request
  const quotes = () => props.quotes.filter((q, i, list) => list.findIndex((o) => sameQuote(o, q)) === i)
  const shown = () => (all() ? quotes() : quotes().slice(0, 1))
  return (
    <span
      data-slot="fold-run"
      class="block overflow-hidden rounded-md transition-shadow"
      classList={{ "shadow-md": props.active }}
      style={{ background: type().bg, color: type().ink, border: `1px solid ${props.active ? type().ink : type().edge}` }}
    >
      <span class="flex items-center gap-1.5 px-2 pt-1.5 text-[11px] leading-4" style={{ "font-family": type().title }}>
        <span
          class="flex size-3.5 shrink-0 items-center justify-center rounded-sm text-[9px] font-semibold"
          style={{ background: type().favBg, color: type().favFg, border: `1px solid ${type().edge}` }}
        >
          {type().fav}
        </span>
        <span class="truncate opacity-75">
          {label().site} · {label().title}
        </span>
      </span>
      <For each={shown()}>
        {(quote) => (
          <span
            class="block px-2 pt-1 text-[13px] leading-[1.45] break-words"
            style={{
              "font-family": type().body,
              ...(all() ? {} : { display: "-webkit-box", "-webkit-line-clamp": "3", "-webkit-box-orient": "vertical", overflow: "hidden" }),
            }}
          >
            {"\u201C"}
            {quote}
            {"\u201D"}
          </span>
        )}
      </For>
      <span class="flex items-center gap-2 px-2 pt-1 pb-1.5 text-[11px] leading-4 opacity-70" style={{ "font-family": type().title }}>
        <Show when={quotes().length > 1 || props.quotes.some((q) => q.length > 160)}>
          <button
            type="button"
            class="cursor-pointer underline decoration-dotted underline-offset-2"
            onClick={(event) => {
              event.stopPropagation()
              setAll(!all())
            }}
          >
            {all() ? "less" : quotes().length > 1 ? `+${quotes().length - 1} more` : "more"}
          </button>
        </Show>
        <Show
          when={props.onOpen}
          fallback={<span class="ms-auto">{props.n} {props.n === 1 ? "sentence" : "sentences"}</span>}
        >
          {(open) => (
            <button
              type="button"
              class="ms-auto cursor-pointer hover:underline"
              title="Open the page with these sentences marked"
              onClick={(event) => {
                event.stopPropagation()
                open()()
              }}
            >
              {props.n} {props.n === 1 ? "sentence" : "sentences"} {"\u21E2"}
            </button>
          )}
        </Show>
      </span>
    </span>
  )
}

/** One source in the answer's reference list: the page named in its own colours, how many of the answer's sentences rest on it, and
 *  (when its text came with the ground) a way to open it with those sentences marked. */
export function SourceRow(props: { n: number; name: string; url?: string; count: number; onOpen?: () => void; onEnter?: () => void; onLeave?: () => void }) {
  const type = () => typeOf({ name: props.name, url: props.url })
  const label = () => siteOf({ name: props.name, url: props.url })
  return (
    <button
      type="button"
      disabled={!props.onOpen}
      class="flex w-full items-center gap-2 rounded-md px-2 py-1 text-start enabled:cursor-pointer enabled:hover:bg-border-weak-base"
      title={props.url ?? (/^https?:/.test(props.name) ? props.name : undefined)}
      onClick={() => props.onOpen?.()}
      onMouseEnter={() => props.onEnter?.()}
      onMouseLeave={() => props.onLeave?.()}
    >
      <span class="w-4 shrink-0 text-end text-v2-text-text-faint">{props.n}</span>
      <span
        class="flex size-4 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold"
        style={{ background: type().favBg, color: type().favFg, border: `1px solid ${type().edge}`, "font-family": type().title }}
      >
        {type().fav}
      </span>
      <span class="min-w-0 flex-1 truncate">
        <span class="text-v2-text-text-base">{label().title}</span>
        <span class="text-v2-text-text-faint"> · {label().site}</span>
      </span>
      <span class="shrink-0 text-v2-text-text-faint">
        {props.count} {props.onOpen ? "\u21E2" : ""}
      </span>
    </button>
  )
}
