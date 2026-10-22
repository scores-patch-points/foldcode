import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { SourceClip, SourceRow, SourceRun } from "./fold-clip"
import { SourceModal } from "./fold-source"
import { locate, propositionsOf, rowAt, unitAt, type Proposition, type GroundRow, type GroundView, type Located, type ProfileItem, type ProfileSource, type ProfileTone, type ProfileView } from "./fold-ground"

// The notice row itself says only what the answer's own hover cannot: a settled turn's superseded draw, or no step.
export function FoldGround(props: { view: GroundView }) {
  return (
    <Show when={props.view.superseded || props.view.gap}>
      <div data-slot="fold-ground" class="w-full py-1 text-13-regular leading-text-compact text-v2-text-text-faint">
        <Show when={props.view.superseded}>
          {(draw) => (
            <details data-slot="fold-ground-superseded">
              <summary class="cursor-pointer">[superseded] the model's draw</summary>
              <div>{draw()}</div>
            </details>
          )}
        </Show>
        <Show when={props.view.gap}>{(gap) => <div>the ground · {gap()}</div>}</Show>
      </div>
    </Show>
  )
}

const offsetAt = (root: HTMLElement, x: number, y: number) => {
  const doc = root.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const at =
    doc.caretPositionFromPoint?.(x, y) ??
    (() => {
      const range = doc.caretRangeFromPoint?.(x, y)
      return range ? { offsetNode: range.startContainer, offset: range.startOffset } : null
    })()
  if (!at || !root.contains(at.offsetNode)) return undefined
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let total = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === at.offsetNode) return total + at.offset
    total += node.textContent?.length ?? 0
  }
}

const UNSETTLED_SHOWN = 3

// How the ground sits with the answer: facing (the default, a spread: answer left, ground right) or stacked under it.
export type GroundLayout = "facing" | "stacked"
const LAYOUT_KEY = "fold-ground-layout"
const [layout, setLayoutSignal] = createSignal<GroundLayout>(readLayout())
function readLayout(): GroundLayout {
  try {
    return globalThis.localStorage?.getItem(LAYOUT_KEY) === "stacked" ? "stacked" : "facing"
  } catch {
    return "facing"
  }
}
const setLayout = (next: GroundLayout) => {
  setLayoutSignal(next)
  try {
    globalThis.localStorage?.setItem(LAYOUT_KEY, next)
  } catch {}
}

// Typing a new prompt folds every facing page shut: the reader has moved on. A page reopens on a click, until the next prompt.
const [typedAt, setTypedAt] = createSignal(0)
let listening = false
function listenForPrompt() {
  if (listening || typeof document === "undefined") return
  listening = true
  document.addEventListener("input", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-component="composer-editor"]')) return
    if (Date.now() - typedAt() > 1000) setTypedAt(Date.now())
  })
}

// The stacks of claim validity, worst first. The standing is the door's (its tone); the page only files each unit under it.
const STACKS: Array<{ tone: ProfileTone; title: string }> = [
  { tone: "danger", title: "contradicted" },
  { tone: "warning", title: "unsupported" },
  { tone: "success", title: "supported" },
  { tone: "muted", title: "argument" },
]
// The stacks that open as notes by themselves: what was contested. Supported sentences open too, as the pages they rest on, quoted
// beside them; each stack's summary button folds or opens it.
const CONTESTED: ProfileTone[] = ["danger", "warning"]
// Below this width the two pages do not fit side by side and the ground drops under the answer.
const FACING_MIN = 640
// The page hangs in the margin outside the answer's column when the margin holds at least this much; it never grows past HANG_MAX.
const HANG_MIN = 280
const HANG_MAX = 400
const HANG_GAP = 16
// the margin page is never shorter than this, however short the answer; nor taller than the answer, past this
const MARGIN_FLOOR = 240

/** Where the door looked, in the reader's words: each place once, in order, with how many lookups it took ("Wikidata ×3"); the door's
 *  own log of each lookup stays on hover. "material" is what this turn read. */
const placeOf = (searched: string) => {
  if (searched === "material") return "what this turn read"
  if (searched.startsWith("not researched")) return "not looked up further"
  const kind = /^(wikidata|wikipedia|workspace)\b/i.exec(searched)?.[1]
  return kind ? kind[0].toUpperCase() + kind.slice(1).toLowerCase() : searched
}
const trailOf = (searched: string[]) =>
  searched
    .map(placeOf)
    .reduce<Array<{ place: string; n: number }>>((out, place) => {
      const last = out[out.length - 1]
      if (last?.place === place) last.n++
      else out.push({ place, n: 1 })
      return out
    }, [])
    .map((step) => (step.n > 1 ? `${step.place} \u00D7${step.n}` : step.place))
    .join(" \u2192 ")

/** The nearest ancestor that scrolls: its right edge is where the margin ends. */
const scrollerOf = (el: HTMLElement): HTMLElement => {
  for (let at = el.parentElement; at; at = at.parentElement) {
    const overflow = getComputedStyle(at).overflowY
    if (overflow === "auto" || overflow === "scroll") return at
  }
  return document.documentElement
}

type Mark = { unit: ProfileItem; top: number; height: number }
type Item =
  | { kind: "note"; key: string; top: number; unit: ProfileItem }
  | { kind: "run"; key: string; top: number; units: ProfileItem[]; evidence: NonNullable<ProfileItem["evidence"]> }
/** The page a piece of evidence comes from: its url, else its source's name. */
const pageOf = (evidence: NonNullable<ProfileItem["evidence"]>) => evidence.url ?? evidence.source ?? ""

/** The facing page. The gutter between the pages carries a bar beside every unit the door read, in its standing's colour; the page
 *  carries the gloss of each opened unit, level with its sentence (pushed down only when the gloss above it is still running). The
 *  stacks along the top open and close their glosses. Everything drawn is the door's payload. */
function FacingPage(props: {
  profile: ProfileView
  answer: HTMLDivElement
  hovered?: string
  isOpen: (unit: ProfileItem) => boolean
  isStackOpen: (tone: ProfileTone) => boolean
  onToggle: (unit: ProfileItem) => void
  onStack: (tone: ProfileTone) => void
  onPick: (find: string | string[]) => void
  onHover: (key: string | undefined) => void
  onSource: (unit: ProfileItem | ProfileSource) => void
  onRevise?: (unit: ProfileItem) => void
  hasSource: (unit: ProfileItem) => boolean
  collapsed: boolean
  onCollapse: (collapsed: boolean) => void
  corner: JSX.Element
  /** the page's width when it hangs in the margin; inline it takes 20rem */
  width?: number
  onHeight?: (height: number) => void
}) {
  let gutter: HTMLDivElement | undefined
  let sheet: HTMLDivElement | undefined
  const [marks, setMarks] = createSignal<Mark[]>([])
  const [answerHeight, setAnswerHeight] = createSignal(0)
  const [allSources, setAllSources] = createSignal(false)
  let scroller: HTMLDivElement | undefined
  // re-places every item when any one changes size (a card expanded, a note folded, a quote reflowed); each is observed as it is placed
  const sized = new ResizeObserver(() => place())
  const unitsOf = (tone: ProfileTone) => props.profile.units.filter((unit) => unit.tone === tone)
  // What sits beside the answer, in reading order, each beside its first occurrence: a RUN of consecutive supported sentences that rest
  // on one page (quoted in that page's words), or a NOTE for a contested, revised or argued unit.
  const items = createMemo(() => {
    if (props.collapsed) return []
    const seen = new Set<string>()
    return marks().reduce<Item[]>((out, mark) => {
      if (seen.has(mark.unit.key) || !props.isOpen(mark.unit)) return out
      seen.add(mark.unit.key)
      const evidence = mark.unit.evidence
      if (mark.unit.tone !== "success" || !evidence || mark.unit.revised) {
        out.push({ kind: "note", key: mark.unit.key, top: mark.top, unit: mark.unit })
        return out
      }
      const last = out[out.length - 1]
      if (last?.kind === "run" && pageOf(last.evidence) === pageOf(evidence)) last.units.push(mark.unit)
      else out.push({ kind: "run", key: `run:${mark.unit.key}`, top: mark.top, units: [mark.unit], evidence })
      return out
    }, [])
  })
  const runOf = createMemo(() => new Map(items().flatMap((item) => (item.kind === "run" ? item.units.map((unit) => [unit.key, item.key] as const) : []))))
  const lit = (unit: ProfileItem) => props.hovered === unit.key || (!!props.hovered && runOf().get(unit.key) === props.hovered)
  const measure = () => {
    if (!gutter) return
    setAnswerHeight(props.answer.offsetHeight)
    const base = gutter.getBoundingClientRect().top
    setMarks(
      locate(props.profile.units, props.answer.textContent ?? "")
        .flatMap((at) => {
          const rects = [...(rangeAt(props.answer, at.start, at.end)?.getClientRects() ?? [])].filter((rect) => rect.width > 0)
          if (!rects.length) return []
          const top = rects[0].top - base
          return [{ unit: at.unit, top, height: rects[rects.length - 1].bottom - base - top }]
        })
        .sort((x, y) => x.top - y.top),
    )
    requestAnimationFrame(place)
  }
  onMount(() => {
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(props.answer)
    // the host lays the answer out in passes; place again once it has settled
    const settle = [setTimeout(measure, 300), setTimeout(measure, 1200)]
    onCleanup(() => {
      observer.disconnect()
      settle.forEach(clearTimeout)
    })
  })
  createEffect(() => {
    props.profile
    measure()
  })
  // place each item level with its sentence, below the one before it; again whenever one changes size (a card expanded, a note
  // folded, a quote reflowed), so nothing ever overlaps
  const place = () => {
    if (!sheet || !gutter) return
    const offset = sheet.getBoundingClientRect().top - gutter.getBoundingClientRect().top + (scroller?.scrollTop ?? 0)
    const bottom = items().reduce((floor, item) => {
      const el = sheet!.querySelector<HTMLElement>(`[data-gloss="${item.key}"]`)
      if (!el) return floor
      sized.observe(el)
      const top = Math.max(floor, item.top - offset)
      el.style.top = `${top}px`
      el.style.visibility = "visible"
      return top + el.offsetHeight + 6
    }, 0)
    // the reference list follows the last note; the page scrolls when the two run longer than the answer
    sheet.style.height = `${bottom}px`
  }
  onCleanup(() => sized.disconnect())
  createEffect(() => {
    items()
    allSources()
    requestAnimationFrame(place)
  })
  // pointing at a sentence of the answer brings the card or note that grounds it into the margin's view
  createEffect(() => {
    const key = props.hovered
    if (!key || !sheet || !scroller) return
    const item = runOf().get(key) ?? key
    const el = sheet.querySelector<HTMLElement>(`[data-gloss="${item}"]`)
    if (!el) return
    const box = el.getBoundingClientRect()
    const view = scroller.getBoundingClientRect()
    if (box.top < view.top || box.bottom > view.bottom)
      scroller.scrollTo({ top: scroller.scrollTop + box.top - view.top - (view.height - box.height) / 2, behavior: "smooth" })
  })
  const enter = (unit: ProfileItem) => {
    props.onPick(unit.find)
    props.onHover(unit.key)
  }
  const leave = () => {
    props.onPick("")
    props.onHover(undefined)
  }
  const enterRun = (item: Extract<Item, { kind: "run" }>) => {
    props.onPick(item.units.map((unit) => unit.find))
    props.onHover(item.key)
  }

  return (
    <div
      ref={(el) => {
        if (!props.onHeight) return
        const observer = new ResizeObserver(() => props.onHeight?.(el.offsetHeight))
        observer.observe(el)
        onCleanup(() => observer.disconnect())
      }}
      data-slot="fold-facing"
      data-collapsed={props.collapsed}
      class="flex shrink-0"
      style={{ width: props.collapsed ? "2.25rem" : props.width ? `${props.width}px` : "20rem" }}
    >
      <div ref={gutter} data-slot="fold-gutter" class="relative w-3 shrink-0">
        <For each={marks()}>
          {(mark) => (
            <button
              type="button"
              data-tone={mark.unit.tone}
              class="absolute left-1.5 w-[3px] cursor-pointer rounded-full transition-opacity"
              style={{
                top: `${mark.top}px`,
                height: `${Math.max(mark.height, 12)}px`,
                background: toneEdge[mark.unit.tone],
                opacity: lit(mark.unit) ? 1 : props.isOpen(mark.unit) ? 0.7 : 0.3,
              }}
              aria-label={`${mark.unit.label}: ${mark.unit.title}`}
              aria-expanded={props.isOpen(mark.unit)}
              onMouseEnter={() => enter(mark.unit)}
              onMouseLeave={leave}
              onClick={() => {
                if (props.collapsed) return props.onCollapse(false)
                props.onToggle(mark.unit)
              }}
            />
          )}
        </For>
      </div>
      <Show when={props.collapsed}>
        <button
          type="button"
          class="h-fit cursor-pointer px-1 text-13-regular text-v2-text-text-faint hover:text-v2-text-text-base"
          title="Open the ground"
          aria-label="Open the ground"
          onClick={() => props.onCollapse(false)}
        >
          {"\u2039"}
        </button>
      </Show>
      <div
        ref={scroller}
        data-slot="fold-facing-page"
        class="min-w-0 flex-1 overflow-y-auto overscroll-contain pl-1 text-13-regular leading-text-compact"
        classList={{ hidden: props.collapsed }}
        // the ground is never longer than the answer it grounds: past the answer's height it scrolls in place
        style={{ "max-height": `${Math.max(answerHeight(), MARGIN_FLOOR)}px`, "scrollbar-width": "thin" }}
      >
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-2 pb-2 text-v2-text-text-faint">
          <For each={STACKS.filter((stack) => unitsOf(stack.tone).length)}>
            {(stack) => (
              <button
                type="button"
                aria-pressed={props.isStackOpen(stack.tone)}
                class={`cursor-pointer whitespace-nowrap hover:text-v2-text-text-base ${props.isStackOpen(stack.tone) ? "text-v2-text-text-base" : ""}`}
                onMouseEnter={() => props.onPick(unitsOf(stack.tone).map((unit) => unit.find))}
                onMouseLeave={() => props.onPick("")}
                onClick={() => props.onStack(stack.tone)}
              >
                <span class={toneText[stack.tone]}>{"\u25CF"}</span> {unitsOf(stack.tone).length} {stack.title}
              </button>
            )}
          </For>
          <Show when={props.profile.rests.length > 0}>
            <button
              type="button"
              aria-expanded={allSources()}
              class={`cursor-pointer whitespace-nowrap hover:text-v2-text-text-base ${allSources() ? "text-v2-text-text-base" : ""}`}
              title={allSources() ? "Hide the list of sources" : "Show every source this answer rests on"}
              onClick={() => setAllSources(!allSources())}
            >
              {"\u00B7"} {props.profile.rests.length} {props.profile.rests.length === 1 ? "source" : "sources"}{" "}
              {allSources() ? "\u25B4" : "\u25BE"}
            </button>
          </Show>
        </div>
        <Show when={allSources() && props.profile.rests.length > 0}>
          <div data-slot="fold-references" class="mb-2 flex flex-col border-b border-border-weak-base pb-2">
            <For each={props.profile.rests}>
              {(row, i) => {
                const source = () => props.profile.sources.find((s) => s.name === row.source)
                const units = () => props.profile.units.filter((unit) => unit.evidence?.source === row.source || unit.from.some((f) => f.source === row.source))
                return (
                  <SourceRow
                    n={i() + 1}
                    name={row.source}
                    url={source()?.url}
                    count={row.n}
                    onOpen={source() ? () => props.onSource(source()!) : undefined}
                    onEnter={() => props.onPick(units().map((unit) => unit.find))}
                    onLeave={() => props.onPick("")}
                  />
                )
              }}
            </For>
          </div>
        </Show>
        <Show when={props.profile.noMaterial}>
          <div class="pb-2 text-v2-text-text-faint">Nothing was read this turn, so these claims rest on the model's own knowledge.</div>
        </Show>
        <Show when={props.profile.researching}>
          <div class="pb-2 text-v2-text-text-faint">Checking the unsupported claims against the workspace and Wikipedia…</div>
        </Show>
        <div ref={sheet} data-slot="fold-sheet" class="relative">
          <For each={items()}>
            {(item) => (
              <Show
                when={item.kind === "run" && item}
                fallback={
                  <Show when={item.kind === "note" && item}>
                    {(note) => (
                      <div
                        data-gloss={note().key}
                        class={`absolute inset-x-0 rounded-md px-2 py-1 transition-colors ${lit(note().unit) ? "bg-border-weak-base" : ""}`}
                        style={{ visibility: "hidden" }}
                        onMouseEnter={() => enter(note().unit)}
                        onMouseLeave={leave}
                      >
                        <UnitTip
                          unit={note().unit}
                          onFold={() => props.onToggle(note().unit)}
                          onSource={props.hasSource(note().unit) ? () => props.onSource(note().unit) : undefined}
                          onRevise={
                            props.onRevise && (note().unit.tone === "danger" || note().unit.tone === "warning")
                              ? () => props.onRevise?.(note().unit)
                              : undefined
                          }
                        />
                      </div>
                    )}
                  </Show>
                }
              >
                {(run) => (
                  <div
                    data-gloss={run().key}
                    class="absolute inset-x-0 px-1"
                    style={{ visibility: "hidden" }}
                    onMouseEnter={() => enterRun(run())}
                    onMouseLeave={leave}
                  >
                    <SourceRun
                      source={run().evidence.source}
                      url={run().evidence.url}
                      refText={run().evidence.ref}
                      quotes={[...new Set(run().units.flatMap((unit) => [unit.evidence?.text, ...unit.from.map((f) => f.text)]).filter((t): t is string => !!t))]}
                      n={run().units.length}
                      active={props.hovered === run().key || run().units.some((unit) => unit.key === props.hovered)}
                      focus={run().units.find((unit) => unit.key === props.hovered)?.evidence?.text}
                      via={run().units.find((unit) => unit.via)?.via}
                      indexOnly={run().units.every((unit) => unit.tier === "index")}
                      onOpen={props.hasSource(run().units[0]) ? () => props.onSource(run().units[0]) : undefined}
                    />
                  </div>
                )}
              </Show>
            )}
          </For>
        </div>
        <For each={props.profile.unrevised}>
          {(was) => (
            <div class="text-v2-text-text-faint">
              Asked to revise <span class="line-through">{was}</span>; no sentence of this answer stands for it.
            </div>
          )}
        </For>
        <div class="flex flex-col gap-1.5 px-2 pt-2 text-v2-text-text-faint">
          <div class="flex gap-3">
            <button type="button" class="cursor-pointer hover:text-v2-text-text-base" onClick={() => props.onCollapse(true)}>
              Fold the ground {"\u203A"}
            </button>
            {props.corner}
          </div>
        </div>
      </div>
    </div>
  )
}

const toneText: Record<ProfileTone, string> = {
  danger: "text-v2-state-fg-danger",
  warning: "text-v2-state-fg-warning",
  success: "text-v2-state-fg-success",
  muted: "text-v2-text-text-faint",
}
const toneEdge: Record<ProfileTone, string> = {
  danger: "var(--v2-state-fg-danger)",
  warning: "var(--v2-state-fg-warning)",
  success: "var(--v2-state-fg-success)",
  muted: "var(--v2-text-text-faint)",
}
const toneBg: Record<ProfileTone, string> = {
  danger: "bg-v2-state-bg-danger",
  warning: "bg-v2-state-bg-warning",
  success: "bg-v2-state-bg-success",
  muted: "bg-border-weak-base",
}

// Point at text in the answer with the browser's own highlights: never wrapping or editing the answer's nodes.
type HighlightApi = { highlights?: Map<string, unknown> }
const highlightApi = () => (globalThis.CSS as unknown as HighlightApi | undefined)?.highlights
const makeHighlight = (ranges: Range[]) => {
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  return Highlight && ranges.length ? new Highlight(...ranges) : undefined
}

/** The range of `[start, end)` in the root's rendered text. */
function rangeAt(root: HTMLElement, start: number, end: number): Range | undefined {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  const locateAt = (offset: number) => {
    let seen = 0
    for (const node of nodes) {
      if (offset <= seen + node.data.length) return { node, offset: offset - seen }
      seen += node.data.length
    }
  }
  const from = locateAt(start)
  const to = locateAt(end)
  if (!from || !to) return undefined
  const range = doc.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  return range
}

function highlight(root: HTMLElement, find: string | string[]) {
  const registry = highlightApi()
  if (!registry) return
  registry.delete("fold-ground")
  const text = root.textContent ?? ""
  const ranges = (Array.isArray(find) ? find : [find]).flatMap((one) => {
    const at = one ? text.indexOf(one) : -1
    return at < 0 ? [] : (rangeAt(root, at, at + one.length) ?? [])
  })
  const made = makeHighlight(ranges)
  if (made) registry.set("fold-ground", made)
}

// The text the door CONTRADICTED (or could not find) stays marked in the answer itself; every other unit is read on hover. One
// highlight for every answer on screen: each root keeps its own ranges.
const marked = new Map<HTMLElement, Range[]>()
function mark(root: HTMLElement, ranges: Range[]) {
  const registry = highlightApi()
  if (!registry) return
  if (ranges.length) marked.set(root, ranges)
  else marked.delete(root)
  const made = makeHighlight([...marked.values()].flat())
  if (made) registry.set("fold-bad", made)
  else registry.delete("fold-bad")
}

let styled = false
function ensureStyle() {
  if (styled || typeof document === "undefined") return
  styled = true
  const style = document.createElement("style")
  style.textContent =
    "::highlight(fold-ground){background-color:color-mix(in srgb,var(--v2-state-fg-info,#4f8cff) 28%,transparent)}" +
    "::highlight(fold-bad){text-decoration:underline wavy var(--v2-state-fg-danger,#e5484d);text-decoration-skip-ink:none}"
  document.head.appendChild(style)
}

function Item(props: { item: ProfileItem; onPick: (find: string | string[]) => void }) {
  const [open, setOpen] = createSignal(false)
  return (
    <div data-slot="fold-profile-item" class="rounded-md border border-border-weak-base">
      <button
        type="button"
        class="flex w-full cursor-pointer items-start gap-2 px-2 py-1.5 text-start"
        onMouseEnter={() => props.onPick(props.item.find)}
        onClick={() => {
          props.onPick(props.item.find)
          setOpen(!open())
        }}
      >
        <span class={`mt-1.5 size-2 shrink-0 rounded-full ${toneBg[props.item.tone]} ${toneText[props.item.tone]}`} style={{ background: "currentColor" }} />
        <span class="min-w-0">
          <span class={`font-[530] ${toneText[props.item.tone]}`}>{props.item.label}</span>
          <span class="text-v2-text-text-faint"> · </span>
          <span class="break-words">{props.item.title}</span>
          <Show when={props.item.why}>{(why) => <div class="text-v2-text-text-faint">{why()}</div>}</Show>
        </span>
      </button>
      <Show when={open()}>
        <div class="flex flex-col gap-1 border-t border-border-weak-base px-2 py-1.5 text-v2-text-text-faint">
          <Show when={props.item.evidence}>
            {(evidence) => (
              <div>
                <div class="break-words rounded bg-border-weak-base px-1.5 py-1 font-mono text-12-regular">{evidence().text}</div>
                <div>
                  {evidence().source}
                  <Show when={evidence().ref && evidence().ref !== evidence().source}>{` · ${evidence().ref}`}</Show>
                  <Show when={evidence().url}>
                    {(url) => (
                      <>
                        {" · "}
                        <a href={url()} target="_blank" rel="noreferrer" class="underline">
                          open
                        </a>
                      </>
                    )}
                  </Show>
                </div>
              </div>
            )}
          </Show>
          <Show when={props.item.from.length > 0}>
            <div class="flex flex-col gap-1">
              <div>Abstracts {props.item.from.length} source sentence{props.item.from.length === 1 ? "" : "s"}</div>
              <For each={props.item.from}>
                {(source) => (
                  <div class="break-words rounded bg-border-weak-base px-1.5 py-1 font-mono text-12-regular">
                    {source.text}
                    <div class="text-v2-text-text-faint">{source.ref ?? source.source}</div>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show when={props.item.residue.length > 0}>
            <div>Not in the source: {props.item.residue.join(", ")}</div>
          </Show>
          <Show when={props.item.janus}>{(finding) => <div>Janus: {finding()}</div>}</Show>
          <Show when={props.item.who}>{(who) => <div>Resolved to {who()}</div>}</Show>
          <Show when={props.item.searched.length > 0}>
            <div title={props.item.searched.join("\n")}>Looked in: {trailOf(props.item.searched)}</div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

// The profile of the answer, as the door computed it: what it is, the mix of what it rests on, the items that need a
// look (always open), and what checks out (on request). The panel draws the door's payload; it decides nothing.
export function ProfilePanel(props: { profile: ProfileView; onPick: (find: string | string[]) => void; corner?: JSX.Element }) {
  const total = () => props.profile.bar.reduce((sum, part) => sum + part.n, 0)
  const [fine, setFine] = createSignal(false)
  const [more, setMore] = createSignal(false)
  // contradicted and not-found items always show; a long run of merely unsupported ones is collapsed behind a count
  const unsettled = () => props.profile.look.filter((item) => item.tone !== "danger")
  return (
    <div
      data-slot="fold-profile"
      class="mt-2 flex w-full flex-col gap-2 rounded-lg border border-border-weak-base p-3 text-13-regular leading-text-compact"
      onMouseLeave={() => props.onPick("")}
    >
      <div class="flex items-baseline justify-between gap-2">
        <span class="font-[530] capitalize">{props.profile.kind}</span>
        <span class="flex items-baseline gap-2 text-v2-text-text-faint">
          {props.profile.size}
          {props.corner}
        </span>
      </div>
      <Show when={total() > 0}>
        <div class="flex h-2 overflow-hidden rounded bg-border-weak-base" role="img" aria-label="what the answer rests on">
          <For each={props.profile.bar}>
            {(part) => <div class={toneText[part.tone]} style={{ flex: part.n, background: "currentColor" }} title={`${part.n} ${part.label}`} />}
          </For>
        </div>
        <div class="flex flex-wrap gap-x-3 text-v2-text-text-faint">
          <For each={props.profile.bar}>
            {(part) => (
              <span>
                <span class={toneText[part.tone]}>{"\u25CF"}</span> {part.n} {part.label}
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.profile.rests.length > 0}>
        <div class="text-v2-text-text-faint">
          Rests on{" "}
          <For each={props.profile.rests}>{(row, i) => <span>{i() ? ", " : ""}{row.source} ({row.n})</span>}</For>
        </div>
      </Show>
      <Show when={props.profile.researching}>
        <div class="text-v2-text-text-faint">Checking the unsupported claims against the workspace and Wikipedia…</div>
      </Show>
      <Show when={props.profile.noMaterial}>
        <div class="text-v2-text-text-faint">Nothing was read this turn, so these claims rest on the model's own knowledge.</div>
      </Show>
      <Show when={props.profile.look.length > 0}>
        <div class="flex flex-col gap-1">
          <div class="text-v2-text-text-faint">Needs a look · {props.profile.look.length}</div>
          <For each={props.profile.look.filter((item) => item.tone === "danger")}>{(item) => <Item item={item} onPick={props.onPick} />}</For>
          <For each={more() ? unsettled() : unsettled().slice(0, UNSETTLED_SHOWN)}>{(item) => <Item item={item} onPick={props.onPick} />}</For>
          <Show when={unsettled().length > UNSETTLED_SHOWN}>
            <button type="button" class="cursor-pointer text-start text-v2-text-text-faint" onClick={() => setMore(!more())}>
              {more() ? "Show fewer" : `Show ${unsettled().length - UNSETTLED_SHOWN} more unsupported`}
            </button>
          </Show>
        </div>
      </Show>
      <Show when={props.profile.leftOut}>
        {(left) => (
          <div class="flex flex-col gap-1">
            <div class="text-v2-text-text-faint">Left out of the summary</div>
            <Show when={left().beings.length > 0}>
              <div class="break-words">
                <For each={left().beings}>{(being, i) => <span>{i() ? ", " : ""}{being.name} ({being.mentions}&times;)</span>}</For>
              </div>
            </Show>
            <For each={left().figures}>
              {(figure) => (
                <div class="break-words text-v2-text-text-faint" title={figure.ref}>
                  <span class="font-[530] text-v2-text-text-base">{figure.figure}</span> · {figure.text}
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
      <Show when={props.profile.beings.length > 0}>
        <div class="flex flex-col gap-0.5 text-v2-text-text-faint">
          <For each={props.profile.beings}>
            {(being) => (
              <div class="break-words" title={being.basis}>
                {being.name} →{" "}
                <Show when={being.verdict === "bound" && being.url} fallback={being.verdict}>
                  <a href={being.url} target="_blank" rel="noreferrer" class="underline">
                    {being.label} ({being.qid})
                  </a>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.profile.fine.length > 0}>
        <div class="flex flex-col gap-1">
          <button type="button" class="cursor-pointer text-start text-v2-text-text-faint" onClick={() => setFine(!fine())}>
            Checks out · {props.profile.fine.length} {fine() ? "\u25B4" : "\u25BE"}
          </button>
          <Show when={fine()}>
            <For each={props.profile.fine}>{(item) => <Item item={item} onPick={props.onPick} />}</For>
          </Show>
        </div>
      </Show>
    </div>
  )
}

// The answer, untouched, and its ground. Wide enough, the ground is the facing page beside it (the default); otherwise, or when the
// reader asks, the profile panel under it. Point at any of the answer's text and its grounding shows: on the facing page as that
// unit's gloss, else as a tooltip. Text the door contradicted stays underlined in place.
export function GroundHover(props: { view: GroundView; children: JSX.Element; onRevise?: (unit: ProfileItem) => void }) {
  let answer: HTMLDivElement | undefined
  const [answerEl, setAnswerEl] = createSignal<HTMLDivElement>()
  const [width, setWidth] = createSignal(0)
  const [hovered, setHovered] = createSignal<string>()
  const [stacks, setStacks] = createSignal(new Set<ProfileTone>([...CONTESTED, "success"]))
  const [toggled, setToggled] = createSignal(new Set<string>())
  // open since the later of birth or the last click open; shut by the next prompt typed, or by the reader
  const [openedAt, setOpenedAt] = createSignal(Date.now())
  const [closedAt, setClosedAt] = createSignal(0)
  const collapsed = () => Math.max(typedAt(), closedAt()) > openedAt()
  const [sourceAt, setSourceAt] = createSignal<number>()
  const propositions = (): Proposition[] => (props.view.profile ? propositionsOf(props.view.profile.units, props.view.profile.sources) : [])
  const openSource = (target: ProfileItem | ProfileSource) => {
    const at = propositions().findIndex((p) => ("key" in target ? p.unit.key === target.key : p.source.name === target.name))
    if (at >= 0) setSourceAt(at)
  }
  listenForPrompt()
  // measured once the row is in the page (its scroller is only known then), and again whenever the row or its scroller resizes
  let rootEl: HTMLDivElement | undefined
  onMount(() => {
    const el = rootEl
    if (!el) return
    const measure = () => {
      setWidth(el.clientWidth)
      setMargin(scrollerOf(el).getBoundingClientRect().right - el.getBoundingClientRect().right - HANG_GAP)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    observer.observe(scrollerOf(el))
    if (answer) observer.observe(answer)
    window.addEventListener("resize", measure)
    // the host lays the row out in passes (a hidden mount, fonts, the answer's markdown): measure again once it has settled
    requestAnimationFrame(measure)
    const settle = [setTimeout(measure, 300), setTimeout(measure, 1200)]
    onCleanup(() => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
      settle.forEach(clearTimeout)
    })
  })
  // the room to the right of the answer's column, inside the scroller: when the page fits there it hangs in the margin and the answer
  // keeps the whole column; otherwise it faces inline, or (narrower still) drops under the answer
  const [margin, setMargin] = createSignal(0)
  const [pageHeight, setPageHeight] = createSignal(0)
  const hangs = () => layout() === "facing" && !!props.view.profile && margin() >= HANG_MIN
  const facing = () => layout() === "facing" && !!props.view.profile && (hangs() || width() >= FACING_MIN)
  // a revision always shows beside its sentence; any other unit opens with its stack
  const isOpen = (unit: ProfileItem) => (!!unit.revised || stacks().has(unit.tone)) !== toggled().has(unit.key)
  const flip = <T,>(set: Set<T>, value: T) => {
    const next = new Set(set)
    if (!next.delete(value)) next.add(value)
    return next
  }
  const [tip, setTip] = createSignal<{ x: number; y: number; row?: GroundRow; unit?: ProfileItem }>()
  const located = (): Located[] => (props.view.profile && answer ? locate(props.view.profile.units, answer.textContent ?? "") : [])
  const pick = (find: string | string[]) => answer && highlight(answer, find)
  const corner = () => (
    <button
      type="button"
      class="cursor-pointer text-v2-text-text-faint hover:text-v2-text-text-base"
      title={facing() ? "Put the ground under the answer" : "Put the ground beside the answer"}
      aria-label={facing() ? "Put the ground under the answer" : "Put the ground beside the answer"}
      onClick={() => setLayout(facing() ? "stacked" : "facing")}
    >
      {facing() ? "Under the answer \u2193" : "Beside the answer \u2192"}
    </button>
  )
  ensureStyle()
  onCleanup(() => {
    highlight(document.body, "")
    if (answer) mark(answer, [])
  })
  // the contradicted and not-found units stay underlined in the answer, recomputed as the answer renders
  createEffect(() => {
    const profile = props.view.profile
    if (!profile) return
    const redo = () => {
      if (!answer) return
      mark(
        answer,
        locate(profile.units, answer.textContent ?? "")
          .filter((l) => l.unit.tone === "danger")
          .flatMap((l) => rangeAt(answer!, l.start, l.end) ?? []),
      )
    }
    redo()
    const later = setTimeout(redo, 400)
    onCleanup(() => clearTimeout(later))
  })

  return (
    <div
      ref={rootEl}
      data-slot="fold-ground-hover"
      data-layout={hangs() ? "margin" : facing() ? "facing" : "stacked"}
      class={hangs() ? "relative" : facing() ? "flex gap-1" : undefined}
      style={hangs() ? { "min-height": `${pageHeight()}px` } : undefined}
    >
      <div
        ref={(el) => {
          answer = el
          setAnswerEl(el)
        }}
        data-slot="fold-ground-answer"
        class={facing() && !hangs() ? "min-w-0 flex-1" : undefined}
        onMouseMove={(event) => {
          if (!answer) return
          const offset = offsetAt(answer, event.clientX, event.clientY)
          if (offset === undefined) {
            setHovered(undefined)
            return setTip(undefined)
          }
          if (props.view.profile) {
            const hit = unitAt(located(), offset)
            const range = hit ? rangeAt(answer, hit.start, hit.end) : undefined
            const registry = highlightApi()
            const made = range ? makeHighlight([range]) : undefined
            if (registry) made ? registry.set("fold-ground", made) : registry.delete("fold-ground")
            setHovered(hit?.unit.key)
            // on the facing page an opened unit answers in its own gloss; the tooltip is for what the page does not show
            const shown = hit && facing() && isOpen(hit.unit)
            return setTip(hit && !shown ? { x: event.clientX, y: event.clientY, unit: hit.unit } : undefined)
          }
          const row = rowAt(props.view.rows, answer.textContent ?? "", offset)
          setTip(row ? { x: event.clientX, y: event.clientY, row } : undefined)
        }}
        onMouseLeave={() => {
          setTip(undefined)
          setHovered(undefined)
          highlight(document.body, "")
        }}
      >
        {props.children}
      </div>
      <Show when={props.view.profile}>
        {(profile) => (
          <Show
            when={facing() && answerEl()}
            fallback={<ProfilePanel profile={profile()} onPick={pick} corner={corner()} />}
          >
            {(el) => (
              <div class={hangs() ? "absolute top-0" : "contents"} style={hangs() ? { left: `calc(100% + ${HANG_GAP}px)` } : undefined}>
              <FacingPage
                width={hangs() ? Math.min(margin() - HANG_GAP, HANG_MAX) : undefined}
                onHeight={setPageHeight}
                profile={profile()}
                answer={el()}
                hovered={hovered()}
                isOpen={isOpen}
                isStackOpen={(tone) => stacks().has(tone)}
                onToggle={(unit) => setToggled(flip(toggled(), unit.key))}
                onStack={(tone) => {
                  setStacks(flip(stacks(), tone))
                  setToggled(new Set([...toggled()].filter((key) => profile().units.find((unit) => unit.key === key)?.tone !== tone)))
                }}
                onPick={pick}
                onHover={setHovered}
                onSource={openSource}
                onRevise={props.onRevise}
                hasSource={(unit) => propositions().some((p) => p.unit.key === unit.key)}
                collapsed={collapsed()}
                onCollapse={(shut) => (shut ? setClosedAt(Date.now()) : setOpenedAt(Date.now()))}
                corner={corner()}
              />
              </div>
            )}
          </Show>
        )}
      </Show>
      <Show when={sourceAt() !== undefined && propositions().length > 0}>
        <SourceModal
          propositions={propositions()}
          at={sourceAt()!}
          onAt={setSourceAt}
          onClose={() => {
            setSourceAt(undefined)
            pick("")
          }}
          onPick={pick}
          onRevise={props.onRevise}
        />
      </Show>
      <Show when={tip()}>
        {(tip) => (
          <div
            data-slot="fold-ground-tip"
            class="pointer-events-none fixed z-50 max-w-[420px] rounded-md border border-border-weak-base bg-background-base p-2 text-13-regular leading-text-compact shadow-md"
            style={{ left: `${Math.min(tip().x + 12, window.innerWidth - 440)}px`, top: `${tip().y + 16}px` }}
          >
            <Show when={tip().unit}>{(unit) => <UnitTip unit={unit()} />}</Show>
            <Show when={tip().row}>
              {(row) => (
                <>
                  <div class="font-[530] text-v2-text-text-faint">[{row().tag}]</div>
                  <Show
                    when={row().sources[0]}
                    fallback={<div>{row().standing === "self:model" ? "Nothing in what this turn read states this." : "No passage sentence located."}</div>}
                  >
                    {(source) => (
                      <>
                        <div>{source().text}</div>
                        <div class="text-v2-text-text-faint">{source().passage}</div>
                      </>
                    )}
                  </Show>
                </>
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}

/** One unit's grounding, as the door read it: the verdict and why, what it rests on (its own bytes, addressed), what it leaves
 *  uncarried, and where the door looked. Everything shown is the door's payload. */
function UnitTip(props: { unit: ProfileItem; onSource?: () => void; onRevise?: () => void; onFold?: () => void }) {
  return (
    <div class="flex flex-col gap-1">
      <Show when={props.unit.revised}>
        {(was) => (
          <div class="flex flex-col gap-0.5 pb-1">
            <span class="text-11-medium uppercase tracking-wide text-v2-text-text-faint">Revises</span>
            <span class="text-v2-text-text-faint line-through decoration-v2-state-fg-danger">{was()}</span>
          </div>
        )}
      </Show>
      <Show
        when={props.onFold}
        fallback={
          <div>
            <span class={`font-[530] ${toneText[props.unit.tone]}`}>{props.unit.label}</span>
            <Show when={props.unit.kind === "symbol"}>
              <span class="text-v2-text-text-faint"> · {props.unit.title}</span>
            </Show>
          </div>
        }
      >
        {(fold) => (
          <button
            type="button"
            class="flex w-full cursor-pointer items-baseline gap-1 text-start"
            title="Fold this note away"
            onClick={(event) => {
              event.stopPropagation()
              fold()()
            }}
          >
            <span class={`font-[530] ${toneText[props.unit.tone]}`}>{props.unit.label}</span>
            <Show when={props.unit.kind === "symbol"}>
              <span class="text-v2-text-text-faint">· {props.unit.title}</span>
            </Show>
            <Show when={props.onRevise}>
              {(revise) => (
                <span
                  role="button"
                  tabIndex={0}
                  class="ms-auto shrink-0 cursor-pointer rounded px-1.5 text-v2-text-text-base hover:bg-border-weak-base"
                  title="Ask for this sentence to be revised"
                  onClick={(event) => {
                    event.stopPropagation()
                    revise()()
                  }}
                >
                  Revise
                </span>
              )}
            </Show>
          </button>
        )}
      </Show>
      <Show when={props.onFold && props.unit.kind === "claim"}>
        <div class="truncate text-v2-text-text-base" title={props.unit.title}>
          {"\u201C"}
          {props.unit.title.split(/\s+/).slice(0, 9).join(" ")}
          {props.unit.title.split(/\s+/).length > 9 ? "\u2026" : ""}
          {"\u201D"}
        </div>
      </Show>
      <Show when={props.unit.why}>{(why) => <div class="text-v2-text-text-faint">{why()}</div>}</Show>
      <Show when={props.unit.evidence}>
        {(evidence) => (
          <SourceClip text={evidence().text} source={evidence().source} url={evidence().url} refText={evidence().ref} onOpen={props.onSource} />
        )}
      </Show>
      <For each={props.unit.from.slice(0, 3)}>
        {(source) => <SourceClip text={source.text} source={source.source} url={source.url} refText={source.ref} onOpen={props.onSource} />}
      </For>
      <Show when={props.unit.residue.length > 0}>
        <div class="text-v2-text-text-faint">Not in the source: {props.unit.residue.join(", ")}</div>
      </Show>
      <Show when={props.unit.janus}>{(finding) => <div class="text-v2-text-text-faint">Janus: {finding()}</div>}</Show>
      <Show when={props.unit.who}>{(who) => <div class="text-v2-text-text-faint">Resolved to {who()}</div>}</Show>
      <Show when={props.unit.tone === "warning" && props.unit.searched.length > 0}>
        <div class="text-v2-text-text-faint" title={props.unit.searched.join("\n")}>
          Looked in: {trailOf(props.unit.searched)}
        </div>
      </Show>
    </div>
  )
}
