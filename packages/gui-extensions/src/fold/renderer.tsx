import { lazy, onCleanup, Suspense } from "solid-js"
import { createKeyed, Panel, onIdle, Slot, Style, type PanelTab, type Setup } from "../sdk"
import css from "./panel.css?inline"
import type Fold from "./index"

const setup: Setup<typeof Fold> = (ctx) => {
  const SessionFoldPanel = lazy(() => import("./panel"))
  const SessionHolodeckPanel = lazy(() => import("./archive"))
  const SessionPerceivePanel = lazy(() => import("./perceive"))
  const SessionWorktreePanel = lazy(() => import("./worktree"))
  const SessionMindTree = lazy(() => import("./mind-tree"))
  const SessionWorkPlans = lazy(() => import("./plans"))
  const SessionRememberPanel = lazy(() => import("./remember"))
  // Compile the panels while the app idles, so the first open renders at once.
  onCleanup(onIdle(() => void SessionFoldPanel.preload()))
  onCleanup(onIdle(() => void SessionHolodeckPanel.preload()))
  onCleanup(onIdle(() => void SessionPerceivePanel.preload()))
  onCleanup(onIdle(() => void SessionRememberPanel.preload()))
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

  // The work tree tab: what the turn touched, how far each thing walked the nine operators, what grew from what.
  const mindTree: PanelTab = { id: "tree", title: "Work tree", closable: "compact" }

  ctx.add(Panel, {
    id: "tree",
    region: "side",
    list: () => [mindTree],
    render: (props) => (
      <Suspense>
        <SessionMindTree session={props.session} />
      </Suspense>
    ),
  })

  // The work plans tab: the stigmergic marks and settled turns each task left behind.
  const plansTab: PanelTab = { id: "plans", title: "Work plans", closable: "compact" }

  ctx.add(Panel, {
    id: "plans",
    region: "side",
    list: () => [plansTab],
    render: (props) => (
      <Suspense>
        <SessionWorkPlans session={props.session} />
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

  // The app asks for the work tree (the mind line in the timeline is a button): open it, selected, beside the feed.
  // The Remember tab: what the system knows about you, what it may read, and the
  // system prompts attached to asks. All three stores are read back from the
  // door and appended to here; the door injects an entry only when an ask's own
  // words bear on it, so none of it is loaded into a prompt wholesale.
  const remember: PanelTab = {
    id: "remember",
    get title() {
      return ctx.t("tab.remember")
    },
    closable: "compact",
  }

  ctx.add(Panel, {
    id: "remember",
    region: "side",
    list: () => [remember],
    render: (props) => (
      <Suspense>
        <SessionRememberPanel session={props.session} />
      </Suspense>
    ),
  })

  const openTree = () => {
    const session = ctx.sessions.current()
    if (session) ctx.layout.open(`${ctx.id}:tree`, session, { tab: "select" })
  }
  window.addEventListener("fold:open-tree", openTree)
  onCleanup(() => window.removeEventListener("fold:open-tree", openTree))

  // Every routed session lists the worktree tab, but quietly: it is added to the side region
  // without selecting it or opening the region, so the panel stays however you left it.
  createKeyed(
    () => ctx.sessions.current()?.key,
    () => {
      const session = ctx.sessions.current()

      if (session) ctx.layout.open(`${ctx.id}:worktree`, session, { tab: "append" })
    },
  )
}

export default setup
