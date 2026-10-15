import { lazy, onCleanup, Suspense } from "solid-js"
import { Panel, onIdle, type PanelTab, type Setup } from "../sdk"
import type Fold from "./index"

const setup: Setup<typeof Fold> = (ctx) => {
  const SessionFoldPanel = lazy(() => import("./panel"))
  // Compile the panel while the app idles, so the first open renders at once.
  onCleanup(onIdle(() => void SessionFoldPanel.preload()))

  // One tab object for every session, so a session switch does not rebuild its trigger.
  const tab: PanelTab = {
    id: "main",
    get title() {
      return ctx.t("tab.title")
    },
    closable: "compact",
  }

  ctx.add(Panel, {
    id: "main",
    region: "side",
    list: (input) => (input.open.includes("main") ? [tab] : []),
    render: (props) => (
      <Suspense>
        <SessionFoldPanel session={props.session} />
      </Suspense>
    ),
  })
}

export default setup
