import { Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { ScrollView } from "@opencode/ui/scroll-view"
import { useExtension, type MountedSession, type SessionScreen } from "../sdk"
import type Fold from "./index"

// The workspace worktree: this session's own files as a traditional file tree, drawn by the file
// extension's virtualized tree. It is the fold panel's default content, so the workspace you are
// working on is one glance away — no tab to open, no button to press. Clicking a file opens it.
export default function SessionWorktreePanel(props: { session: MountedSession; screen: SessionScreen }) {
  const ctx = useExtension<typeof Fold>()

  // The file extension draws the tree; while it is unavailable the panel says so instead of going blank.
  const tree = () => {
    const live = ctx.uses.tree()

    return live.status === "active" ? live.value : undefined
  }

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-fold-worktree">
      <div class="flex shrink-0 flex-col gap-0.5 border-b border-v2-border-border-base px-5 py-4">
        <div class="min-w-0 truncate text-13-regular text-text-base">{ctx.t("worktree.title")}</div>
        <div class="min-w-0 truncate text-12-regular text-text-weak">{ctx.t("worktree.subtitle")}</div>
      </div>
      <Show
        when={tree()}
        fallback={<div class="px-5 py-4 text-12-regular text-text-weak">{ctx.t("worktree.unavailable")}</div>}
      >
        {(views) => (
          <ScrollView class="group/file-tree-v2 min-h-0 flex-1" orientation="both" thumbVisibility="scroll">
            <div class="px-3 pb-4 pt-3">
              <Dynamic
                component={views().Tree}
                screen={props.screen}
                session={props.session}
                onFileClick={(path: string) => {
                  ctx.links.open({ href: path, origin: "file", exact: true, session: props.session })
                }}
              />
            </div>
          </ScrollView>
        )}
      </Show>
    </div>
  )
}
