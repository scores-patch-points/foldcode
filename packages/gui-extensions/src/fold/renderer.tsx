import { lazy, onCleanup, Suspense } from "solid-js"
import { createKeyed, Panel, onIdle, type PanelTab, type Setup } from "../sdk"
import type Fold from "./index"

const setup: Setup<typeof Fold> = (ctx) => {
  const SessionFoldPanel = lazy(() => import("./panel"))
  // Compile the panel while the app idles, so the first open renders at once.
  onCleanup(onIdle(() => void SessionFoldPanel.preload()))

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
        <SessionFoldPanel session={props.session} />
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
