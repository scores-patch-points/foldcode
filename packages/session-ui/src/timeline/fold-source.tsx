import { For, Show, createEffect, createMemo, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import type { ProfileItem, ProfileTone, Proposition } from "./fold-ground"
import { domainOf, typeOf } from "./fold-site-type"


const tint: Record<ProfileTone, string> = {
  danger: "rgba(229, 72, 77, 0.16)",
  warning: "rgba(214, 160, 30, 0.18)",
  success: "rgba(48, 164, 108, 0.16)",
  muted: "rgba(120, 120, 130, 0.14)",
}
const ink: Record<ProfileTone, string> = {
  danger: "#d93036",
  warning: "#b7791f",
  success: "#2f8a55",
  muted: "#77777f",
}

/** The source modal: the source drawn whole, in its own site's typesetting, with each proposition marked where it stands in it
 *  (its standing's colour; the one in hand outlined), and the answer's own sentences beside it. ← and → (or ‹ ›) go back and
 *  forth through every proposition, across sources. Nothing here edits either text. */
export function SourceModal(props: {
  propositions: Proposition[]
  at: number
  onAt: (index: number) => void
  onClose: () => void
  onPick?: (find: string) => void
  onRevise?: (unit: ProfileItem) => void
}) {
  let sheet: HTMLDivElement | undefined
  const current = () => props.propositions[props.at]
  const source = () => current()?.source
  const here = createMemo(() => props.propositions.filter((p) => p.source.name === source()?.name))
  const type = () => (source() ? typeOf(source()!) : undefined)
  const domain = () => domainOf(source()?.url)
  const title = () => {
    const name = source()?.name ?? ""
    return name.replace(/^wikipedia:\s*/, "")
  }
  const site = () => (source()?.name.startsWith("wikipedia:") ? "Wikipedia" : domain() || "Workspace file")
  const step = (by: number) => props.onAt((props.at + by + props.propositions.length) % props.propositions.length)
  const otherSources = () => props.propositions.map((p) => p.source).filter((s, i, all) => all.findIndex((t) => t.name === s.name) === i)

  onMount(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") return props.onClose()
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault()
        step(1)
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault()
        step(-1)
      }
    }
    document.addEventListener("keydown", key)
    onCleanup(() => document.removeEventListener("keydown", key))
  })
  // bring the proposition in hand into view, in the sheet and in the answer
  createEffect(() => {
    const p = current()
    if (!p) return
    props.onPick?.(p.unit.find)
    requestAnimationFrame(() => sheet?.querySelector(`[data-prop="${p.n}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }))
  })

  // the source as blocks (a heading or a paragraph per line), each with the propositions that fall in it
  const blocks = createMemo(() => {
    const text = source()?.text ?? ""
    const out: Array<{ start: number; end: number; heading: boolean }> = []
    for (const match of text.matchAll(/[^\n]+/g)) {
      const line = match[0]
      if (!line.trim()) continue
      const start = match.index!
      out.push({ start, end: start + line.length, heading: /^#{1,6}\s/.test(line) })
    }
    return out
  })
  const pieces = (block: { start: number; end: number; heading: boolean }) => {
    const text = source()?.text ?? ""
    const marks = here()
      .filter((p) => p.start < block.end && p.end > block.start)
      .sort((x, y) => x.start - y.start)
    const out: Array<{ text: string; prop?: Proposition }> = []
    let cursor = block.start + (block.heading ? (text.slice(block.start).match(/^#{1,6}\s+/)?.[0].length ?? 0) : 0)
    for (const p of marks) {
      const from = Math.max(p.start, cursor)
      if (from > cursor) out.push({ text: text.slice(cursor, from) })
      const to = Math.min(p.end, block.end)
      if (to > from) out.push({ text: text.slice(from, to), prop: p })
      cursor = Math.max(cursor, to)
    }
    if (cursor < block.end) out.push({ text: text.slice(cursor, block.end) })
    return { out, marked: marks.length > 0 }
  }

  return (
    <Portal>
      <div
        data-slot="fold-source-backdrop"
        class="fixed inset-0 z-[100] flex items-center justify-center p-4"
        style={{ background: "rgba(10, 10, 14, 0.5)", "backdrop-filter": "blur(2px)" }}
        onClick={() => props.onClose()}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${site()}: ${title()}`}
          data-slot="fold-source"
          class="flex max-h-[min(86vh,860px)] w-[min(1000px,96vw)] flex-col overflow-hidden rounded-xl border border-border-weak-base bg-background-base text-13-regular leading-text-compact shadow-2xl"
          onClick={(event) => event.stopPropagation()}
        >
          {/* our chrome: quiet, one line */}
          <div class="flex items-center gap-3 border-b border-border-weak-base px-4 py-2.5">
            <Show when={type()}>
              {(t) => (
                <span
                  class="flex size-6 shrink-0 items-center justify-center rounded text-12-medium"
                  style={{ background: t().favBg, color: t().favFg, border: `1px solid ${t().edge}`, "font-family": t().title }}
                >
                  {t().fav}
                </span>
              )}
            </Show>
            <div class="min-w-0">
              <div class="truncate font-[530] text-v2-text-text-base">{title()}</div>
              <div class="truncate text-v2-text-text-faint">{site()}</div>
            </div>
            <Show when={otherSources().length > 1}>
              <div class="flex min-w-0 gap-1 overflow-x-auto">
                <For each={otherSources()}>
                  {(s) => (
                    <button
                      type="button"
                      class={`shrink-0 cursor-pointer rounded-full px-2 py-0.5 ${s.name === source()?.name ? "bg-border-weak-base text-v2-text-text-base" : "text-v2-text-text-faint hover:text-v2-text-text-base"}`}
                      onClick={() => props.onAt(props.propositions.findIndex((p) => p.source.name === s.name))}
                    >
                      {s.name.replace(/^wikipedia:\s*/, "")}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <div class="ms-auto flex items-center gap-3 text-v2-text-text-faint">
              <Show when={source()?.url}>
                {(url) => (
                  <a href={url()} target="_blank" rel="noreferrer" class="hover:text-v2-text-text-base">
                    Open page {"↗"}
                  </a>
                )}
              </Show>
              <button type="button" aria-label="Close" class="cursor-pointer text-16-regular hover:text-v2-text-text-base" onClick={() => props.onClose()}>
                {"✕"}
              </button>
            </div>
          </div>

          {/* the proposition in hand: what the answer said, how the source bears on it, and the way back and forth */}
          <Show when={current()}>
            {(p) => (
              <div data-slot="fold-source-claim" class="flex flex-col gap-1.5 border-b border-border-weak-base px-5 py-3">
                <div class="flex items-center gap-2">
                  <span class="text-11-medium uppercase tracking-wide" style={{ color: ink[p().unit.tone] }}>
                    {p().unit.label}
                  </span>
                  <span class="text-v2-text-text-faint">· the answer said</span>
                  <div class="ms-auto flex items-center gap-1">
                    <For each={props.propositions}>
                      {(other) => (
                        <button
                          type="button"
                          aria-label={`${other.n}: ${other.unit.label}`}
                          aria-current={other.n === p().n}
                          class="size-5 cursor-pointer rounded-full text-[10px] font-semibold"
                          style={{
                            background: other.n === p().n ? ink[other.unit.tone] : tint[other.unit.tone],
                            color: other.n === p().n ? "#fff" : ink[other.unit.tone],
                          }}
                          onClick={() => props.onAt(other.n - 1)}
                        >
                          {other.n}
                        </button>
                      )}
                    </For>
                    <button type="button" aria-label="Previous proposition" class="ms-2 cursor-pointer rounded px-1.5 text-v2-text-text-faint hover:bg-border-weak-base hover:text-v2-text-text-base" onClick={() => step(-1)}>
                      {"\u2190"}
                    </button>
                    <button type="button" aria-label="Next proposition" class="cursor-pointer rounded px-1.5 text-v2-text-text-faint hover:bg-border-weak-base hover:text-v2-text-text-base" onClick={() => step(1)}>
                      {"\u2192"}
                    </button>
                  </div>
                </div>
                <div class="text-16-regular leading-text-base text-v2-text-text-base">{"\u201C"}{p().unit.title}{"\u201D"}</div>
                <Show when={p().unit.why || (props.onRevise && (p().unit.tone === "danger" || p().unit.tone === "warning"))}>
                  <div class="flex items-start gap-3">
                    <span class="min-w-0 flex-1 text-v2-text-text-faint">{p().unit.why}</span>
                    <Show when={props.onRevise && (p().unit.tone === "danger" || p().unit.tone === "warning")}>
                      <button
                        type="button"
                        class="shrink-0 cursor-pointer rounded-md border border-border-weak-base px-2.5 py-1 text-v2-text-text-base hover:bg-border-weak-base"
                        onClick={() => props.onRevise?.(p().unit)}
                      >
                        Revise this sentence
                      </button>
                    </Show>
                  </div>
                </Show>
              </div>
            )}
          </Show>

          <div class="flex min-h-0 flex-1">
            {/* the source, in its own typesetting: the page is theirs */}
            <div
              ref={sheet}
              data-slot="fold-source-sheet"
              class="min-w-0 flex-1 overflow-y-auto"
              style={{ background: type()?.bg, color: type()?.ink }}
            >
              <article class="mx-auto max-w-[68ch] px-10 py-9" style={{ "font-family": type()?.body, "font-size": type()?.bodySize, "line-height": "1.6" }}>
                <h1
                  class="mb-5 pb-2 text-[28px] leading-tight"
                  style={{
                    "font-family": type()?.title,
                    "font-weight": type()?.titleWeight,
                    "text-transform": type()?.titleCase as "none",
                    "letter-spacing": type()?.titleTrack,
                    "border-bottom": `1px solid ${type()?.rule}`,
                  }}
                >
                  {title()}
                </h1>
                <For each={blocks()}>
                  {(block) => {
                    const made = () => pieces(block)
                    return (
                      <div
                        class={block.heading ? "mt-5 mb-2 text-[1.25em]" : "mb-3"}
                        style={{
                          "font-family": block.heading ? type()?.title : undefined,
                          "font-weight": block.heading ? type()?.titleWeight : undefined,
                          // the page stays readable, the propositions lead: paragraphs that carry none recede
                          opacity: made().marked || block.heading ? 1 : 0.5,
                        }}
                      >
                        <For each={made().out}>
                          {(piece) => (
                            <Show when={piece.prop} fallback={piece.text}>
                              {(prop) => {
                                const active = () => prop().n === current()?.n
                                return (
                                  <mark
                                    data-prop={prop().n}
                                    class="cursor-pointer rounded-[3px] px-0.5 transition-[outline-color,background]"
                                    style={{
                                      background: tint[prop().unit.tone],
                                      color: "inherit",
                                      outline: active() ? `2px solid ${ink[prop().unit.tone]}` : "2px solid transparent",
                                      "outline-offset": "1px",
                                      "text-decoration": prop().unit.tone === "danger" ? `underline wavy ${ink.danger}` : undefined,
                                      "text-decoration-skip-ink": "none",
                                    }}
                                    onClick={() => props.onAt(prop().n - 1)}
                                  >
                                    <sup
                                      class="me-0.5 select-none rounded-full px-1 text-[10px] font-semibold"
                                      style={{ background: ink[prop().unit.tone], color: "#fff", "font-family": "-apple-system,BlinkMacSystemFont,sans-serif" }}
                                    >
                                      {prop().n}
                                    </sup>
                                    {piece.text}
                                  </mark>
                                )
                              }}
                            </Show>
                          )}
                        </For>
                      </div>
                    )
                  }}
                </For>
              </article>
            </div>

          </div>
        </div>
      </div>
    </Portal>
  )
}
