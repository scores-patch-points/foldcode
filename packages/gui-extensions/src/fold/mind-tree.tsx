import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { createLatest, useExtension, type MountedSession } from "../sdk"
import { followBottom } from "./follow"
import { buildTree, stageById, type Lap, type MindStage, type Snapshot, type TreeNode } from "./mind-tree-model"
import MindMapPane from "./mind-map"
import { FOLD_URL } from "./panel"
import { spiralOf, type RecordView } from "./plans-model"

// The stigmergic work tree, drawn as the autoindex this surface lives in (mikelacy.site's skin, scoped under .ftm in
// panel.css): a listing of THINGS — a row is a file, a command, a search, never the model's running commentary. Each
// row's state is a type-badge (RUN / DONE / MISS / OPEN); its ONE operator is the right-hand meta column, like a
// last-modified date. A target that began after another settled hangs under it; one that missed and tried again shows
// its passes. The commentary is a muted line under a running row, and the record of redefined referents closes the list.

const EVENT = "fold:mind"
const read = () => (window as unknown as { __foldMind?: Snapshot }).__foldMind

// The badge: the type-tag of the listing (DIR / TXT / APP become RUN / DONE / MISS / OPEN).
const STATE_TAG: Record<TreeNode["state"], string> = { running: "RUN", settled: "DONE", failed: "MISS", open: "OPEN" }
const STATE_WORD: Record<TreeNode["state"], string> = { running: "running", settled: "settled", failed: "failed", open: "open" }
const STEP_MARK = (status: string) => (status === "error" ? "✗" : status === "completed" ? "✓" : "…")

// The name column begins after the base gutter (20) + caret (14) + gap (10) + badge (44) + gap (10); each level indents
// by one step (16). Every line beneath a row (path, aim, pass, step) aligns to that same column.
const col = (depth: number) => 98 + depth * 16

// The one operator a row shows: where the walk is now, or where it ended. Glyph and word together, so no legend is
// needed and the same string never repeats down the page.
function Operator(props: { stage?: MindStage }) {
  return (
    <Show when={props.stage ? stageById(props.stage) : undefined}>
      {(stage) => (
        <span class="ftm-op" title={stage().doing}>
          <span class="g" aria-hidden="true">{stage().glyph}</span> {stage().label}
        </span>
      )}
    </Show>
  )
}

function Step(props: { step: Lap["steps"][number]; depth: number }) {
  const stage = () => stageById(props.step.stage)
  return (
    <li class="ftm-step" style={{ "padding-inline-start": `${col(props.depth)}px` }}>
      <span class={`m${props.step.status === "error" ? " err" : ""}`} aria-hidden="true">{STEP_MARK(props.step.status)}</span>
      <span class="n" title={props.step.name}>{props.step.name}</span>
      <span class="e" title={props.step.error}>{props.step.error ? `— ${props.step.error}` : ""}</span>
      <span class="g" aria-hidden="true" title={stage()?.doing}>{stage()?.glyph}</span>
    </li>
  )
}

function Node(props: { node: TreeNode; depth: number; session: MountedSession; open: (path: string) => void }) {
  const [expanded, setExpanded] = createSignal(true)
  const stepCount = () => props.node.laps.reduce((n, lap) => n + lap.steps.length, 0)
  const hasMore = () => props.node.children.length > 0 || stepCount() > 0
  // The path is worth a line of its own unless it is the name itself (a command, or a nameless task).
  const showPath = () => !!props.node.where && props.node.where !== props.node.label

  return (
    <li role="treeitem" aria-expanded={hasMore() ? expanded() : undefined} aria-level={props.depth + 1} class="ftm-node">
      <div class="ftm-row" style={{ "padding-inline-start": `${20 + props.depth * 16}px` }}>
        <button
          type="button"
          disabled={!hasMore()}
          aria-label={expanded() ? "Collapse" : "Expand"}
          class="ftm-caret"
          onClick={() => setExpanded(!expanded())}
        >
          <span aria-hidden="true">{hasMore() ? (expanded() ? "▾" : "▸") : "·"}</span>
        </button>
        <span class={`ftm-badge ${props.node.state}`} title={STATE_WORD[props.node.state]}>
          {STATE_TAG[props.node.state]}
          <span class="ftm-sr">{STATE_WORD[props.node.state]}</span>
        </span>
        <Show
          when={showPath() && props.node.openable}
          fallback={<span class="ftm-name" title={props.node.where}>{props.node.label}</span>}
        >
          <button
            type="button"
            title={`Open ${props.node.where}`}
            class="ftm-name"
            onClick={() => props.open(props.node.where!)}
          >
            {props.node.label}
          </button>
        </Show>
        <Operator stage={props.node.at} />
      </div>

      <Show when={showPath()}>
        <div class="ftm-path" style={{ "padding-inline-start": `${col(props.depth)}px` }}>
          <Show
            when={props.node.openable}
            fallback={<span title={props.node.where}>{props.node.where}</span>}
          >
            <button
              type="button"
              title={`Open ${props.node.where}`}
              onClick={() => props.open(props.node.where!)}
            >
              {props.node.where}
            </button>
          </Show>
          <Show when={props.node.detail}>
            <span class="d">{props.node.detail}</span>
          </Show>
        </div>
      </Show>

      <Show when={props.node.state === "running" && props.node.aim}>
        <div class="ftm-aim" style={{ "padding-inline-start": `${col(props.depth)}px` }} title={props.node.aim}>
          {props.node.aim}
        </div>
      </Show>

      <Show when={expanded()}>
        <ul role="group">
          <For each={props.node.laps}>
            {(lap) => (
              <>
                <Show when={props.node.laps.length > 1}>
                  <li class="ftm-pass" style={{ "padding-inline-start": `${col(props.depth)}px` }}>
                    <span aria-hidden="true">{lap.failed ? "✗" : "↻"}</span>
                    <span>pass {lap.n + 1}</span>
                    <Show when={lap.carried}>
                      <span class="carry" title={lap.carried}>carried: {lap.carried}</span>
                    </Show>
                  </li>
                </Show>
                <For each={lap.steps}>{(step) => <Step step={step} depth={props.depth} />}</For>
              </>
            )}
          </For>
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

  // The verified record beside the tree: which referents were redefined (the spiral turning) and which stayed one pass.
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((value) => value + 1), 4000)
  onCleanup(() => clearInterval(timer))
  const record = createLatest(
    () => `${props.session.id}#${tick()}`,
    async (_key, signal) => {
      const response = await fetch(`${FOLD_URL}/v1/hooks/opencode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event: "record", task: props.session.id }),
        signal,
      })
      if (!response.ok) throw new Error(`record ${response.status}`)
      return (await response.json()) as RecordView
    },
  )
  const rows = createMemo(() => spiralOf(record.latest))
  const open = (path: string) => ctx.links.open({ href: path, exact: true, session: props.session })

  // Two lenses on the same turn, from the same snapshot so neither is a mock-up of the other: `things` is the work
  // tree (what it touched, in order); `map` is the concepts relating, drawn the way the holodeck draws names.
  const [lens, setLens] = createSignal<"things" | "map">("things")

  return (
    <div class="ftm flex h-full min-h-0 flex-col" data-slot="session-mind-tree">
      <header class="ftm-head">
        <div class="ftm-site">the fold</div>
        <div class="ftm-title">{ctx.t("tab.title")}</div>
        <div class="ftm-sub">
          What this turn is thinking, two ways — the things it touched, in order, or the concepts it is relating, drawn
          from whichever one you enter. A target that began after another settled hangs under it; one that missed and
          tried again shows its passes.
        </div>
      </header>

      <div class="ftm-now" role="status" aria-live="polite" title={snapshot()?.murmur}>
        <span class="k">now</span>
        <span class="t">{snapshot()?.murmur || "waiting for the first move"}</span>
      </div>

      <div class="ftm-lens" role="tablist" aria-label="Lens">
        <button type="button" role="tab" aria-selected={lens() === "things"} onClick={() => setLens("things")}>
          things
        </button>
        <button type="button" role="tab" aria-selected={lens() === "map"} onClick={() => setLens("map")}>
          concepts
        </button>
      </div>

      <Show when={lens() === "map"}>
        <div class="ftm-body ftm-body-map">
          <MindMapPane snapshot={snapshot()} record={record.latest} open={open} />
        </div>
      </Show>

      <Show when={lens() === "things"}>
        <div class="ftm-body" ref={(element) => onCleanup(followBottom(element))}>
          <Show
            when={tree().length > 0}
            fallback={<div class="ftm-empty ftm-mutedline">Nothing yet. The tree grows as the turn works.</div>}
          >
            <ul role="tree" aria-label="Work tree">
              <For each={tree()}>{(node) => <Node node={node} depth={0} session={props.session} open={open} />}</For>
            </ul>
          </Show>

          <Show when={rows().length > 0}>
            <section class="ftm-rec" aria-label="Record">
              <div class="h">Record</div>
              <For each={rows()}>
                {(row) => (
                  <div class="r">
                    <span class="ref" title={row.referent}>{row.referent}</span>
                    <span class="disp">
                      {row.reentries > 0 ? `re-entered ×${row.reentries}` : "one pass"}
                      {row.answers > 1 ? <span class="re">{` · ${row.answers} ways`}</span> : null}
                    </span>
                  </div>
                )}
              </For>
            </section>
          </Show>
        </div>
      </Show>
    </div>
  )
}
