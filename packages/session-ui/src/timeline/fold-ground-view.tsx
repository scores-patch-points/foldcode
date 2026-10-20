import { Show, createSignal, type JSX } from "solid-js"
import { rowAt, type GroundRow, type GroundView } from "./fold-ground"

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

// Hover the answer's own text to see what, if anything, the sentence under the pointer rests on.
export function GroundHover(props: { view: GroundView; children: JSX.Element }) {
  let root: HTMLDivElement | undefined
  const [tip, setTip] = createSignal<{ x: number; y: number; row: GroundRow }>()

  return (
    <div
      ref={root}
      data-slot="fold-ground-hover"
      onMouseMove={(event) => {
        if (!root) return
        const offset = offsetAt(root, event.clientX, event.clientY)
        const row = offset === undefined ? undefined : rowAt(props.view.rows, root.textContent ?? "", offset)
        setTip(row ? { x: event.clientX, y: event.clientY, row } : undefined)
      }}
      onMouseLeave={() => setTip(undefined)}
    >
      {props.children}
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
