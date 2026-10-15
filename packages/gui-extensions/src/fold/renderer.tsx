import { lazy, onCleanup, Suspense } from "solid-js"
import { createKeyed, Panel, onIdle, Slot, Style, type PanelTab, type Setup } from "../sdk"
import css from "./panel.css?inline"
import type Fold from "./index"

const setup: Setup<typeof Fold> = (ctx) => {
  const SessionFoldPanel = lazy(() => import("./panel"))
  const SessionHolodeckPanel = lazy(() => import("./archive"))
  const SessionPerceivePanel = lazy(() => import("./perceive"))
  const SessionWorktreePanel = lazy(() => import("./worktree"))
  // Compile the panels while the app idles, so the first open renders at once.
  onCleanup(onIdle(() => void SessionFoldPanel.preload()))
  onCleanup(onIdle(() => void SessionHolodeckPanel.preload()))
  onCleanup(onIdle(() => void SessionPerceivePanel.preload()))
  onCleanup(onIdle(() => void SessionWorktreePanel.preload()))

  ctx.add(Style, css)

  // The savings tally in the titlebar's right corner: the tokens and money the
  // fold kept out of the frontier, resettable and hideable from the corner itself.
  const Tally = lazy(() => import("./tally"))
  onCleanup(onIdle(() => void Tally.preload()))

  ctx.add(Slot, {
    at: "titlebar.end",
    render: () => (
      <Suspense>
        <Tally />
      </Suspense>
    ),
  })

  // The optional browser pane, handed to the panels so they can open the REAL fold/holodeck pages.
  const browser = ctx.uses.browser

  // The worktree: the workspace itself as a file tree, opened with the session as the region's
  // default content. It is how the left panel shows what you are working on — no tab, no button.
  const worktree: PanelTab = {
    id: "worktree",
    get title() {
      return ctx.t("tab.worktree")
    },
    pinned: true,
    first: true,
    fallback: true,
  }

  ctx.add(Panel, {
    id: "worktree",
    region: "side",
    list: () => [worktree],
    render: (props) => (
      <Suspense>
        <SessionWorktreePanel session={props.session} screen={props.screen} />
      </Suspense>
    ),
  })

  // Pinned: always a trigger in the side strip. first + fallback: the region's default content.
  const tab: PanelTab = {
    id: "main",
    get title() {
      return ctx.t("tab.title")
    },
    pinned: true,
  }

  ctx.add(Panel, {
    id: "main",
    region: "side",
    list: () => [tab],
    render: (props) => (
      <Suspense>
        <SessionFoldPanel session={props.session} browser={browser} />
      </Suspense>
    ),
  })

  // The Holodeck tab: every past turn in full, scrollable and explorable — the archive, separate from the live feed.
  const holodeck: PanelTab = {
    id: "holodeck",
    get title() {
      return ctx.t("tab.holodeck")
    },
    closable: "compact",
  }

  ctx.add(Panel, {
    id: "holodeck",
    region: "side",
    list: (input) => (input.open.includes("holodeck") ? [holodeck] : []),
    render: (props) => (
      <Suspense>
        <SessionHolodeckPanel session={props.session} browser={browser} />
      </Suspense>
    ),
  })

  // The Perceive tab: which eyes and ears attached files get, before the
  // frontier is sent them. Local-first by default; the tab reads and writes
  // the door's perceive config, and the doorway plugin enforces it.
  const perceive: PanelTab = {
    id: "perceive",
    get title() {
      return ctx.t("tab.perceive")
    },
    closable: "compact",
  }

  ctx.add(Panel, {
    id: "perceive",
    region: "side",
    list: () => [perceive],
    render: (props) => (
      <Suspense>
        <SessionPerceivePanel session={props.session} />
      </Suspense>
    ),
  })

  // Hijack the side region for the fold's way of prompting: every routed session brings the
  // worktree up, selected, and opens the region, so the workspace you are working on is always
  // one glance away.
  createKeyed(
    () => ctx.sessions.current()?.key,
    () => {
      const session = ctx.sessions.current()

      if (session) ctx.layout.open(`${ctx.id}:worktree`, session, { tab: "select" })
    },
  )
}

export default setup
