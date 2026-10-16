import { createMemo, createSignal, For, Show, onCleanup, onMount } from "solid-js"
import { stageById, type Snapshot } from "./mind-tree-model"
import {
  buildMindMap,
  cursorPos,
  levelsOf,
  localize,
  nestOf,
  openAtLevel,
  orbitAt,
  profileOf,
  stepCursor,
  RELATION_WORD,
  type Concept,
  type Placement,
  type ProfileRow,
} from "./mind-map-model"
import type { RecordView } from "./plans-model"

// The mind map: the concepts this turn is relating, drawn as the holodeck draws names — a mark per concept, a tie per
// relation, a ring where a concept holds more than it shows. The map is RELATIVISTIC: it is always drawn from one
// concept's standpoint (the POSITION), and you move around it with a CURSOR. The two are deliberately separate, which
// is what the clicking used to get wrong: a cursor that recentred the map would re-lay the whole draw under the
// pointer. So the cursor moves (← →) and the map stays; ENTER, or a click, opens the concept's PROFILE — the drill-in
// page — and the profile has a cursor of its own that steps its lines, ENTER follows the line you are on. To recenter
// the map on a concept you say so: "center the map here". The live line is the model's own thinking, in real time.

const SHORT = (value: string, max = 16) => (value.length > max ? `${value.slice(0, max - 1)}…` : value)
const TIE_CLASS: Record<string, string> = {
  "derived-from": "grow",
  "redefined-by": "redef",
  carried: "carry",
  "same-value": "held",
}

/** The one mark per concept: greys by where its walk is, the focus in the accent, the anomaly drawn apart, and the
 *  cursor as a dashed ring around it — the thing you are on. Its position is read from `pos` every tick, so the body
 *  rides its orbit while the mark itself is built once. A holon that holds more carries a ring: clicking the ring
 *  opens it (its members fold out) or closes it (they fold in); clicking the mark itself opens the concept's profile. */
function Mark(props: {
  node: Placement
  pos: () => Placement
  cursor: boolean
  onOpen: (id: string) => void
  onToggle: (id: string) => void
}) {
  const stage = () => (props.node.at ? stageById(props.node.at) : undefined)
  const label = () =>
    props.node.holds && !props.node.open ? `${SHORT(props.node.label)} +${props.node.members - 1}` : SHORT(props.node.label)
  return (
    <g
      class={`ftm-c node-${props.node.state}${props.node.focus ? " focus" : ""}${props.node.contested ? " contested" : ""}${props.node.holds ? " holds" : ""}${props.node.open ? " open" : ""}${props.cursor ? " cur" : ""}`}
      role="button"
      tabindex={-1}
      aria-label={`${props.node.label}${props.node.standing === "witnessed" ? ", closed by a check" : ""}${props.node.holds ? (props.node.open ? ", open, holds more" : `, holds ${props.node.members} concepts, closed`) : ""}`}
      onClick={() => props.onOpen(props.node.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") props.onOpen(props.node.id)
      }}
    >
      <Show when={props.cursor}>
        <circle class="cur-ring" cx={props.pos().x} cy={props.pos().y} r={props.node.r + 4.4} />
      </Show>
      <Show when={props.node.holds}>
        <circle
          class="ring"
          cx={props.pos().x}
          cy={props.pos().y}
          r={props.node.r + 2.6}
          role="button"
          aria-label={props.node.open ? `close ${props.node.label}` : `open ${props.node.label}`}
          onClick={(event) => {
            event.stopPropagation()
            props.onToggle(props.node.id)
          }}
        />
      </Show>
      <Show when={props.node.focus}>
        <circle class="halo" cx={props.pos().x} cy={props.pos().y} r={props.node.r + 5} />
      </Show>
      <circle class="dot" cx={props.pos().x} cy={props.pos().y} r={props.node.r} />
      <Show when={stage()}>
        <text class="glyph" x={props.pos().x} y={props.pos().y + 1.4}>
          {stage()!.glyph}
        </text>
      </Show>
      <text class="label" x={props.pos().x} y={props.pos().y + props.node.r + 5.4}>
        {label()}
      </text>
    </g>
  )
}

/** The profile: the drill-in page a concept opens onto. It is drawn from the same map and the same snapshot, so it can
 *  never be a mock-up of what the map shows. Its own cursor steps the lines — a tie leads to its peer, a pass is the
 *  header of one walk, a step is the walk's own record, a note is the same concept holding more than it shows. */
function Profile(props: {
  concept: Concept
  rows: ReadonlyArray<ProfileRow>
  read: string
  at: number
  onStep: (to: number) => void
  onFollow: (to: string) => void
  onCenter: (id: string) => void
  onClose: () => void
}) {
  const stage = () => (props.concept.at ? stageById(props.concept.at) : undefined)
  return (
    <div class="ftm-profile" role="dialog" aria-label={`profile: ${props.concept.label}`}>
      <div class="ftm-prof-head">
        <span class="nm">{props.concept.label}</span>
        <span class="st">{props.concept.standing === "witnessed" ? "closed by a check" : "asserted"}</span>
        <span class="pos">
          line {props.at + 1}/{props.rows.length}
        </span>
        <button type="button" class="x" onClick={props.onClose} title="Close (esc)">
          close
        </button>
      </div>

      <Show when={props.concept.where}>
        <button type="button" class="addr" onClick={() => props.onCenter(props.concept.id)} title="Center the map here">
          {props.concept.where}
          {props.concept.detail ? ` · ${props.concept.detail}` : ""}
        </button>
      </Show>

      <div class="ftm-prof-read">{props.read}</div>

      <Show when={stage()}>
        <div class="ftm-prof-op">
          <span class="g" aria-hidden="true">{stage()!.glyph}</span> {stage()!.label} — {stage()!.doing}
        </div>
      </Show>
      <Show when={props.concept.thought}>
        <div class="ftm-prof-think" title={props.concept.thought}>
          {props.concept.thought}
        </div>
      </Show>

      <div class="ftm-prof-rows">
        <For each={props.rows}>
          {(row, index) => (
            <button
              type="button"
              class={`ftm-prow${index() === props.at ? " cur" : ""}${row.contested ? " held" : ""}${row.to ? " leads" : ""}`}
              aria-current={index() === props.at ? "true" : undefined}
              onClick={() => {
                props.onStep(index())
                if (row.to) props.onFollow(row.to)
              }}
            >
              <span class="mk" aria-hidden="true">
                {row.mark ?? "·"}
              </span>
              <span class="tx">{row.text}</span>
              <Show when={row.detail}>
                <span class="dt">{row.detail}</span>
              </Show>
              <Show when={row.to}>
                <span class="go" aria-hidden="true">
                  →
                </span>
              </Show>
            </button>
          )}
        </For>
      </div>

      <div class="ftm-prof-foot">
        <button type="button" onClick={() => props.onCenter(props.concept.id)}>
          center the map here
        </button>
        <span class="ftm-mutedline">← → step the lines · ⏎ follow · esc close</span>
      </div>
    </div>
  )
}

export default function MindMapPane(props: {
  snapshot: Snapshot | undefined
  record: RecordView | undefined
  open: (path: string) => void
}) {
  const map = createMemo(() => buildMindMap(props.snapshot, props.record))
  // The POSITION the map is drawn from — turned only by an explicit `center`, never by the cursor moving over it.
  const [focus, setFocus] = createSignal<string | undefined>(undefined)
  // The CURSOR — where you are on the map. It steps (← →) and opens nothing by itself.
  const [cursor, setCursor] = createSignal<string | undefined>(undefined)
  // The PROFILE — the drill-in page a concept opens onto, with a cursor over its own lines.
  const [profileId, setProfileId] = createSignal<string | undefined>(undefined)
  const [row, setRow] = createSignal(0)
  // The map folds into holons (the holodeck's engine). `open` decides what is drawn: the level opens every holon
  // shallower than it, and clicking a ring toggles one holon on top of that (the override).
  const nest = createMemo(() => nestOf(map()))
  const maxLevel = createMemo(() => levelsOf(nest()).max)
  const [level, setLevel] = createSignal<number | null>(null)
  const [override, setOverride] = createSignal<ReadonlySet<string> | null>(null)
  const openSet = createMemo(() => override() ?? openAtLevel(nest(), level() ?? maxLevel()))
  const levelNow = createMemo(() => level() ?? maxLevel())
  const local = createMemo(() => localize(map(), focus(), { open: openSet(), level: levelNow() }))
  const byId = createMemo(() => new Map(map().concepts.map((concept) => [concept.id, concept])))
  // The cursor rides the draw: it defaults to the concept the map is drawn from, so there is always something to be on.
  const here = createMemo(() => cursor() ?? local().focus?.id)
  const where = createMemo(() => cursorPos(local(), here()))
  const profile = createMemo(() => {
    const id = profileId()
    return id ? profileOf(map(), id, props.snapshot) : undefined
  })
  const rowAt = createMemo(() => {
    const rows = profile()?.rows ?? []
    return rows.length === 0 ? -1 : Math.max(0, Math.min(row(), rows.length - 1))
  })
  const live = createMemo(() => local().nodes.find((node) => node.state === "running"))

  // The solar system's spin: each body rides its orbit at its own speed, an inner one faster (orbitAt). Centering
  // resets the spin to rest so the redraw lands still — the reset belongs to the action that changes the position.
  const [spin, setSpin] = createSignal(0)
  const center = (id: string) => {
    setSpin(0)
    setFocus(id)
    setCursor(id)
  }
  const openProfile = (id: string) => {
    setProfileId(id)
    setRow(0)
    setCursor(id)
  }
  const closeProfile = () => setProfileId(undefined)
  const stepRow = (dir: 1 | -1) => {
    const rows = profile()?.rows ?? []
    if (rows.length === 0) return
    setRow((current) => {
      const at = Math.max(0, Math.min(current, rows.length - 1))
      return (at + dir + rows.length) % rows.length
    })
  }
  const follow = () => {
    const line = profile()?.rows[rowAt()]
    if (line?.to) openProfile(line.to)
  }
  const move = (dir: 1 | -1) => setCursor(stepCursor(local(), here(), dir))
  const toggle = (id: string) =>
    setOverride(() => {
      const next = new Set(openSet())
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const upLevel = () => {
    setOverride(null)
    setLevel((current) => Math.max(0, (current ?? maxLevel()) - 1))
  }
  const downLevel = () => {
    setOverride(null)
    setLevel((current) => Math.min(maxLevel(), (current ?? maxLevel()) + 1))
  }

  // The cursor is what makes "go inside" real, so the keys belong to the pane: ← → step the cursor (or the profile's
  // lines), ⏎ opens or follows, ↑ ↓ step the holon level, esc closes. Nothing here recenters the map on its own.
  const onKey = (event: KeyboardEvent) => {
    if (profile()) {
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault()
        stepRow(1)
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault()
        stepRow(-1)
      } else if (event.key === "Enter") {
        event.preventDefault()
        follow()
      } else if (event.key === "Escape") {
        event.preventDefault()
        closeProfile()
      }
      return
    }
    if (event.key === "ArrowRight") {
      event.preventDefault()
      move(1)
    } else if (event.key === "ArrowLeft") {
      event.preventDefault()
      move(-1)
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      downLevel()
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      upLevel()
    } else if (event.key === "Enter") {
      event.preventDefault()
      const id = here()
      if (id) openProfile(id)
    } else if (event.key === "Escape") {
      event.preventDefault()
      setCursor(undefined)
    }
  }

  onMount(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
    let raf = 0
    let last = performance.now()
    const step = (now: number) => {
      const dt = (now - last) / 1000
      last = now
      setSpin((value) => value + Math.min(dt, 0.1))
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    onCleanup(() => cancelAnimationFrame(raf))
  })
  const frame = createMemo(() => orbitAt(local(), spin()))
  const at = createMemo(() => new Map(frame().nodes.map((node) => [node.id, node])))
  const posOf = (id: string) => at().get(id)

  return (
    <div class="ftm-map-pane" tabindex={0} role="group" aria-label="Concept map" onKeyDown={onKey}>
      <Show
        when={map().concepts.length > 0}
        fallback={<div class="ftm-empty ftm-mutedline">Nothing yet. The map grows as the turn works.</div>}
      >
        <div class="ftm-read" title={map().read}>{map().read}</div>

        <Show when={maxLevel() > 0}>
          <div class="ftm-levels">
            <button type="button" onClick={upLevel} disabled={levelNow() <= 0} title="Up a level: fewer, larger groups">
              ↑
            </button>
            <span>
              level {levelNow()}/{maxLevel()}
            </span>
            <button type="button" onClick={downLevel} disabled={levelNow() >= maxLevel()} title="Down a level: open the groups">
              ↓
            </button>
          </div>
        </Show>

        <Show when={live()}>
          {(node) => (
            <div class="ftm-think" title={node().thought}>
              <span class="k">thinking</span>
              <span class="who">{node().label}</span>
              <span class="words">{node().thought}</span>
            </div>
          )}
        </Show>

        <svg class="ftm-map" viewBox="0 0 100 100" role="group" aria-label="Concept map">
          <For each={local().rings}>{(radius) => <circle class="ftm-orbit" cx="50" cy="50" r={radius} />}</For>
          <For each={local().ties}>
            {(tie) => (
              <Show when={posOf(tie.a) && posOf(tie.b)}>
                <line
                  class={`ftm-tie ${TIE_CLASS[tie.relation] ?? "grow"}`}
                  x1={posOf(tie.a)!.x}
                  y1={posOf(tie.a)!.y}
                  x2={posOf(tie.b)!.x}
                  y2={posOf(tie.b)!.y}
                />
              </Show>
            )}
          </For>
          <For each={local().nodes}>
            {(node) => (
              <Mark
                node={node}
                pos={() => posOf(node.id) ?? node}
                cursor={node.id === here()}
                onOpen={openProfile}
                onToggle={toggle}
              />
            )}
          </For>
        </svg>

        <div class="ftm-legend">
          <span><i class="k grow" />{RELATION_WORD["derived-from"]}</span>
          <span><i class="k held" />anomaly — {RELATION_WORD["same-value"]}</span>
          <span>an orbit is relational distance, a stronger tie nearer; a ring holds more — click the ring to open it, ↑↓ by level</span>
          <Show when={local().beyond > 0}>
            <span>+{local().beyond} beyond this view</span>
          </Show>
        </div>

        <div class="ftm-cursorline">
          <span class="pos">{where().at < 0 ? "—" : `${where().at + 1}/${where().of}`}</span>
          <span class="on">{byId().get(here() ?? "")?.label ?? "nothing"}</span>
          <span class="hint">← → move the cursor · ⏎ open the profile · ↑ ↓ level</span>
        </div>

        <Show when={profile()}>
          {(page) => (
            <Profile
              concept={page().concept}
              rows={page().rows}
              read={page().read}
              at={rowAt()}
              onStep={setRow}
              onFollow={openProfile}
              onCenter={center}
              onClose={closeProfile}
            />
          )}
        </Show>

        <Show when={focus() && byId().get(focus()!)?.where}>
          <button type="button" class="ftm-open" onClick={() => props.open(byId().get(focus()!)!.where!)}>
            open {SHORT(byId().get(focus()!)!.where!, 46)} →
          </button>
        </Show>

        <Show when={map().gaps.length > 0}>
          <div class="ftm-gaps">
            <div class="h">unplaced</div>
            <For each={map().gaps}>{(gap) => <div class="g">{gap}</div>}</For>
          </div>
        </Show>
      </Show>
    </div>
  )
}
