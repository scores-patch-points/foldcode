import { For, Show, createSignal, onCleanup, type JSX } from "solid-js"
import { rowAt, type GroundRow, type GroundView, type ProfileItem, type ProfileTone, type ProfileView } from "./fold-ground"

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

const toneText: Record<ProfileTone, string> = {
  danger: "text-v2-state-fg-danger",
  warning: "text-v2-state-fg-warning",
  success: "text-v2-state-fg-success",
  muted: "text-v2-text-text-faint",
}
const toneBg: Record<ProfileTone, string> = {
  danger: "bg-v2-state-bg-danger",
  warning: "bg-v2-state-bg-warning",
  success: "bg-v2-state-bg-success",
  muted: "bg-border-weak-base",
}

// Point at a unit's text in the answer: the browser's own highlight (never wrapping or editing the answer's nodes).
function highlight(root: HTMLElement, find: string) {
  const registry = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
  if (!registry || !Highlight) return
  registry.delete("fold-ground")
  if (!find) return
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
  const text = nodes.map((node) => node.data).join("")
  const at = text.indexOf(find)
  if (at < 0) return
  const locate = (offset: number) => {
    let seen = 0
    for (const node of nodes) {
      if (offset <= seen + node.data.length) return { node, offset: offset - seen }
      seen += node.data.length
    }
  }
  const from = locate(at)
  const to = locate(at + find.length)
  if (!from || !to) return
  const range = doc.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  registry.set("fold-ground", new Highlight(range))
}

function Item(props: { item: ProfileItem; onPick: (find: string) => void }) {
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
            <div>Looked in: {props.item.searched.join(" → ")}</div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

// The profile of the answer, as the door computed it: what it is, the mix of what it rests on, the items that need a
// look (always open), and what checks out (on request). The panel draws the door's payload; it decides nothing.
export function ProfilePanel(props: { profile: ProfileView; onPick: (find: string) => void }) {
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
        <span class="text-v2-text-text-faint">{props.profile.size}</span>
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

// The answer, untouched, with its profile panel under it. The hover tip below is the older per-sentence reading and
// shows only for a ground that carries no profile.
export function GroundHover(props: { view: GroundView; children: JSX.Element }) {
  let root: HTMLDivElement | undefined
  const [tip, setTip] = createSignal<{ x: number; y: number; row: GroundRow }>()
  onCleanup(() => highlight(document.body, ""))

  return (
    <div
      ref={root}
      data-slot="fold-ground-hover"
      onMouseMove={(event) => {
        if (!root || props.view.profile) return
        const offset = offsetAt(root, event.clientX, event.clientY)
        const row = offset === undefined ? undefined : rowAt(props.view.rows, root.textContent ?? "", offset)
        setTip(row ? { x: event.clientX, y: event.clientY, row } : undefined)
      }}
      onMouseLeave={() => setTip(undefined)}
    >
      {props.children}
      <Show when={props.view.profile}>
        {(profile) => <ProfilePanel profile={profile()} onPick={(find) => root && highlight(root, find)} />}
      </Show>
      <Show when={tip()}>
        {(tip) => (
          <div
            data-slot="fold-ground-tip"
            class="pointer-events-none fixed z-50 max-w-[420px] rounded-md border border-border-weak-base bg-background-base p-2 text-13-regular leading-text-compact shadow-md"
            style={{ left: `${tip().x + 12}px`, top: `${tip().y + 16}px` }}
          >
            <div class="font-[530] text-v2-text-text-faint">[{tip().row.tag}]</div>
            <Show
              when={tip().row.sources[0]}
              fallback={
                <div>
                  {tip().row.standing === "self:model"
                    ? "Nothing in what this turn read states this."
                    : "No passage sentence located."}
                </div>
              }
            >
              {(source) => (
                <>
                  <div>{source().text}</div>
                  <div class="text-v2-text-text-faint">{source().passage}</div>
                </>
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}
