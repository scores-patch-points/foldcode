import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useExtension, type MountedSession } from "../sdk"
import { followBottom } from "./follow"
import { buildTree, type Snapshot, type TreeNode } from "./mind-tree-model"

// The stigmergic work tree: what the turn has touched, how far each thing has walked the nine operators, and
// what grew from what. The app publishes snapshots on a window event; this draws the latest one.

const EVENT = "fold:mind"
const read = () => (window as unknown as { __foldMind?: Snapshot }).__foldMind

const STATE: Record<TreeNode["state"], string> = { running: "running", settled: "settled", failed: "failed", open: "" }
const MARK: Record<TreeNode["state"], string> = { running: "…", settled: "✓", failed: "✗", open: "" }

function Node(props: { node: TreeNode; depth: number; session: MountedSession; open: (path: string) => void }) {
  const [expanded, setExpanded] = createSignal(props.node.kind === "target")
  const hasMore = () => props.node.children.length > 0 || (props.node.steps?.length ?? 0) > 0

  return (
    <li role="treeitem" aria-expanded={hasMore() ? expanded() : undefined} aria-level={props.depth + 1} class="list-none">
      <div class="flex min-w-0 items-center gap-1.5 py-0.5" style={{ "padding-inline-start": `${props.depth * 16}px` }}>
        <button
          type="button"
          disabled={!hasMore()}
          aria-label={expanded() ? "Collapse" : "Expand"}
          class="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm opacity-70 hover:opacity-100 disabled:cursor-default disabled:opacity-20 focus-visible:outline-2"
          onClick={() => setExpanded(!expanded())}
        >
          <span aria-hidden="true">{hasMore() ? (expanded() ? "▾" : "▸") : "·"}</span>
        </button>
        <span aria-hidden="true" class="w-4 shrink-0 text-center">{MARK[props.node.state]}</span>
        <Show
          when={props.node.openable}
          fallback={<span class="min-w-0 truncate text-[13px]" title={props.node.where}>{props.node.label}</span>}
        >
          <button
            type="button"
            title={`Open ${props.node.where}`}
            class="min-w-0 cursor-pointer truncate text-start text-[13px] underline decoration-dotted underline-offset-2 hover:opacity-100 focus-visible:outline-2"
            onClick={() => props.open(props.node.where!)}
          >
            {props.node.label}
          </button>
        </Show>
        <Show when={props.node.detail}>
          <span class="shrink-0 text-[11px] opacity-60">{props.node.detail}</span>
        </Show>
        <span class="ms-auto shrink-0 pe-2 font-mono text-[12px] opacity-85" aria-hidden="true">{props.node.track}</span>
        <span class="sr-only">
          {STATE[props.node.state]} {props.node.track.split("").filter((glyph) => glyph !== "·").length} of 9 operators
        </span>
      </div>
      <Show when={expanded()}>
        <ul role="group" class="m-0 p-0">
          <Show when={props.node.steps}>
            <For each={props.node.steps}>
              {(step) => (
                <li class="list-none text-[12px] opacity-80" style={{ "padding-inline-start": `${(props.depth + 1) * 16 + 28}px` }}>
                  <span aria-hidden="true">{step.status === "error" ? "✗" : step.status === "completed" ? "✓" : "…"} </span>
                  {step.name}
                  <Show when={step.error}>
                    <span class="opacity-70"> — {step.error}</span>
                  </Show>
                </li>
              )}
            </For>
          </Show>
          <For each={props.node.children}>
            {(child) => <Node node={child} depth={props.depth + 1} session={props.session} open={props.open} />}
          </For>
        </ul>
      </Show>
    </li>
  )
}

export default function SessionMindTree(props: { session: MountedSession }) {
  const ctx = useExtension()
  const [snapshot, setSnapshot] = createSignal<Snapshot | undefined>(read())
  const listener = (event: Event) => setSnapshot((event as CustomEvent<Snapshot>).detail)
  window.addEventListener(EVENT, listener)
  onCleanup(() => window.removeEventListener(EVENT, listener))

  const tree = createMemo(() => buildTree(snapshot()))
  const open = (path: string) => ctx.links.open({ href: path, exact: true, session: props.session })

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-mind-tree">
      <div class="shrink-0 border-b border-v2-border-border-base px-5 py-3">
        <div class="text-13-regular text-text-base">Work tree</div>
        <div class="text-12-regular text-text-weak">
          Each thing the turn touched, and how far it has walked ∅ ○ ● ｜ ⋈ △ ⊢ ⊨ ◉. A target that began after another
          settled hangs under it.
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-auto px-3 py-2" ref={(element) => onCleanup(followBottom(element))}>
        <Show
          when={tree().length > 0}
          fallback={<div class="px-2 py-4 text-[13px] opacity-70">Nothing yet. The tree grows as the turn works.</div>}
        >
          <ul role="tree" aria-label="Work tree" class="m-0 p-0">
            <For each={tree()}>{(node) => <Node node={node} depth={0} session={props.session} open={open} />}</For>
          </ul>
        </Show>
      </div>
    </div>
  )
}
