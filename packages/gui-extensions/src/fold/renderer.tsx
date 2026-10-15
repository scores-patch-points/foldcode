import { lazy, onCleanup, Suspense } from "solid-js"
import { createKeyed, Panel, onIdle, Style, type PanelTab, type Setup } from "../sdk"
import css from "./panel.css?inline"
import type Fold from "./index"

const setup: Setup<typeof Fold> = (ctx) => {
  const SessionFoldPanel = lazy(() => import("./panel"))
  const SessionHolodeckPanel = lazy(() => import("./archive"))
  // Compile the panels while the app idles, so the first open renders at once.
  onCleanup(onIdle(() => void SessionFoldPanel.preload()))
  onCleanup(onIdle(() => void SessionHolodeckPanel.preload()))

  ctx.add(Style, css)

  // The optional browser pane, handed to the panels so they can open the REAL fold/holodeck pages.
  const browser = ctx.uses.browser

  // Pinned: always a trigger in the side strip. first + fallback: the region's default content.
  const tab: PanelTab = {
    id: "main",
    get title() {
      return ctx.t("tab.title")
    },
    pinned: true,
    first: true,
    fallback: true,
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

  // Hijack the side region for the fold's way of prompting: every routed session brings the audit up, selected,
  // and opens the region, so what the frontier was prompted with is always one glance away.
  createKeyed(
    () => ctx.sessions.current()?.key,
    () => {
      const session = ctx.sessions.current()

      if (session) ctx.layout.open(`${ctx.id}:main`, session, { tab: "select" })
    },
  )
}

export default setup
