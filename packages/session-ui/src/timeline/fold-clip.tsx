import { Show } from "solid-js"
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

/** A source named as a chip in its own colours, for the facing page's footer. */
export function SourceChip(props: { name: string; url?: string; n: number; onOpen?: () => void }) {
  const type = () => typeOf({ name: props.name, url: props.url })
  const label = () => siteOf({ name: props.name, url: props.url })
  return (
    <button
      type="button"
      disabled={!props.onOpen}
      class="inline-flex max-w-full items-center gap-1.5 rounded-full py-0.5 pr-2 pl-1 text-12-regular enabled:cursor-pointer enabled:hover:shadow-sm"
      style={{ background: type().bg, color: type().ink, border: `1px solid ${type().edge}` }}
      title={props.onOpen ? `Open ${label().title}` : label().title}
      onClick={() => props.onOpen?.()}
    >
      <span
        class="flex size-3.5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold"
        style={{ background: type().favBg, color: type().favFg, "font-family": type().title }}
      >
        {type().fav}
      </span>
      <span class="truncate" style={{ "font-family": type().title }}>
        {label().title}
      </span>
      <span class="opacity-60">{props.n}</span>
    </button>
  )
}
