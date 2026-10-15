import { type Accessor } from "solid-js"
import { Button } from "@opencode/ui/button"
import { useExtension, type Live, type MountedSession } from "../sdk"
import type { Browser } from "../browser/contract"

// The real holodeck page (the scores-patch-points holodeck app), opened in the app's native browser embed for
// THIS session's workspace. Nothing here is a mock-up: the tab opens the actual surface.
const HOLODECK_URL = "http://127.0.0.1:8788/index.html"

export default function SessionHolodeckPanel(props: { session: MountedSession; browser: Accessor<Live<Browser>> }) {
  const ctx = useExtension()

  const open = () => {
    const live = props.browser()

    if (live.status === "active") live.value.open(props.session, HOLODECK_URL)
  }

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-holodeck-panel">
      <div class="foldlive flex shrink-0 flex-col gap-2 border-b border-v2-border-border-base px-5 py-4">
        <div class="flex flex-col gap-0.5">
          <div class="text-13-regular text-text-base">{ctx.t("holodeck.title")}</div>
          <div class="text-12-regular text-text-weak">{ctx.t("holodeck.subtitle")}</div>
        </div>
        <Button size="small" variant="outline" onClick={open}>
          {ctx.t("holodeck.openReal")}
        </Button>
      </div>
      <div class="flex min-h-0 flex-1 items-center justify-center px-8 text-center text-13-regular text-text-weak">
        {ctx.t("holodeck.hint")}
      </div>
    </div>
  )
}
