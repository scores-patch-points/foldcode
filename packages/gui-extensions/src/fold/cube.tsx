import { createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { Button } from "@opencode/ui/button"
import { ScrollView } from "@opencode/ui/scroll-view"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { useExtension, type MountedSession } from "../sdk"
import { FOLD_URL } from "./panel"

// The Cube tab: the 27-cell tool registry as the door sees it — which tools
// are present in the locked venv, which domains are provisioned, per-cell
// coverage, and each tool's last recorded agreement. Calls run IN SHADOW
// (recorded, never gating); this tab reads the map, it writes nothing.
type ToolRow = {
  package: string
  source: string
  role: string
  family: string
  env: string | null
  present: boolean | null
  lastAgreement: number | null
}

type CellRow = {
  cell: string
  organs: string[]
  move: string
  coverage: string
  registrable: boolean
  check: boolean
  tools: ToolRow[]
}

type GroupRow = { have: number; need: number; missing: string[] }

type CubeDoc = {
  schema: string
  counts: { cells: number; tools: number; present: number | null }
  sidecar: { found: boolean; python: string | null; why: string; probe: { python?: string; gap?: string; why?: string | null } }
  groups: Record<string, GroupRow>
  cells: CellRow[]
}

const CUBE_URL = `${FOLD_URL}/v1/hooks/opencode/cube`

const presence = (value: boolean | null) => {
  if (value === true) return "present"

  if (value === false) return "absent"

  return "unprobed"
}

function Row(props: { title: string; children: unknown }) {
  // SAFETY: the caller passes rendered JSX; the SDK models children as unknown
  // and this is a passthrough — the node renders as-is, no data is read.
  const children = props.children as never

  return (
    <div class="flex flex-col gap-2 border-b border-v2-border-border-base px-5 py-4">
      <div class="text-12-regular text-text-weak">{props.title}</div>
      {children}
    </div>
  )
}

export default function SessionCubePanel(props: { session: MountedSession }) {
  void props
  const ctx = useExtension()
  const [doc, setDoc] = createSignal<CubeDoc | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)

  const load = async (signal?: AbortSignal) => {
    const response = await fetch(CUBE_URL, { signal })

    if (!response.ok) throw new Error(`${response.status}`)

    // SAFETY: the door's cube route answers CubeMap@1 by contract; every field
    // read below is guarded (Show/fallback), so no shape is trusted blind.
    setDoc((await response.json()) as CubeDoc)
  }

  onMount(() => {
    const controller = new AbortController()
    load(controller.signal).catch((cause) => setError(String(cause)))

    return () => controller.abort()
  })

  const refresh = () => {
    setError(undefined)
    load().catch((cause) => setError(String(cause)))
  }

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-cube-panel">
      <div class="flex shrink-0 items-start justify-between gap-3 border-b border-v2-border-border-base px-5 py-4">
        <div class="flex min-w-0 flex-col gap-0.5">
          <div class="flex min-w-0 items-center gap-2">
            <span class="size-1.5 shrink-0 rounded-full bg-v2-icon-icon-accent" aria-hidden="true" />
            <div class="min-w-0 truncate text-13-regular text-text-base">{ctx.t("cube.title")}</div>
          </div>
          <div class="min-w-0 truncate text-12-regular text-text-weak">{ctx.t("cube.subtitle")}</div>
        </div>
        <Button size="small" variant="outline" onClick={refresh}>
          {ctx.t("panel.refresh")}
        </Button>
      </div>

      <div class="relative min-h-0 flex-1">
        <Switch>
          <Match when={error() !== undefined && doc() === undefined}>
            <div class="flex h-full flex-col items-center justify-center gap-3 px-8 pb-24 text-center">
              <div class="text-13-regular text-text-weak">{ctx.t("cube.offline")}</div>
              <Button size="small" variant="outline" onClick={refresh}>
                {ctx.t("panel.retry")}
              </Button>
            </div>
          </Match>
          <Match when={doc() === undefined}>
            <div
              data-component="session-working"
              role="status"
              class="flex h-9 items-center px-5 pt-3 text-[13px] font-[530] leading-text-compact"
            >
              <TextShimmer text={ctx.t("panel.loading")} active />
            </div>
          </Match>
          <Match when={doc()}>
            {(value) => (
              <ScrollView class="absolute inset-0">
                <Row title={ctx.t("cube.sidecar")}>
                  <Show
                    when={value().sidecar.found}
                    fallback={
                      <div class="flex flex-col gap-0.5">
                        <span class="text-13-regular text-text-base">{ctx.t("cube.sidecarAbsent")}</span>
                        <span class="text-12-regular text-text-weak">{String(value().sidecar.why ?? "")}</span>
                      </div>
                    }
                  >
                    <div class="flex flex-col gap-0.5">
                      <span class="text-13-regular text-text-base">
                        {ctx.t("cube.sidecarFound")}
                        {value().sidecar.probe.python ? ` · python ${value().sidecar.probe.python}` : ""}
                      </span>
                      <Show when={value().sidecar.probe.gap}>
                        <span class="text-12-regular text-text-weak">
                          probe {value().sidecar.probe.gap}
                          {value().sidecar.probe.why ? ` — ${String(value().sidecar.probe.why)}` : ""}
                        </span>
                      </Show>
                    </div>
                  </Show>
                </Row>

                <Row title={ctx.t("cube.groups")}>
                  <div class="flex flex-col gap-1">
                    <For each={Object.entries(value().groups)}>
                      {([name, group]) => (
                        <div class="flex min-w-0 flex-col gap-0.5">
                          <span class="text-13-regular text-text-base">
                            {name} — {group.have}/{group.need} {ctx.t("cube.present")}
                          </span>
                          <Show when={group.missing.length > 0}>
                            <span class="text-12-regular text-text-weak">
                              {ctx.t("cube.absent")}: {group.missing.slice(0, 8).join(", ")}
                              {group.missing.length > 8 ? ` +${group.missing.length - 8}` : ""}
                            </span>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Row>

                <div class="flex flex-col gap-1 border-b border-v2-border-border-base px-5 py-4">
                  <div class="text-12-regular text-text-weak">
                    {ctx.t("cube.cells")} — {value().counts.cells} · {ctx.t("cube.shadow")}
                  </div>
                  <For each={value().cells}>
                    {(cell) => (
                      <div class="flex min-w-0 flex-col gap-0.5 py-1">
                        <div class="flex items-center gap-2">
                          <span class="text-13-regular text-text-base">{cell.cell}</span>
                          <span class="text-12-regular text-text-weak">
                            {cell.coverage}
                            {cell.check ? "" : " · no null/witness"}
                          </span>
                        </div>
                        <span class="min-w-0 truncate text-12-regular text-text-weak">
                          {cell.organs.join(", ")} — {cell.move}
                        </span>
                        <For each={cell.tools}>
                          {(tool) => (
                            <span class="min-w-0 truncate text-12-regular text-text-weak">
                              {tool.package} · {tool.role}/{tool.family} · {presence(tool.present)}
                              {tool.lastAgreement === null ? "" : ` · ${ctx.t("cube.agreement")} ${Number(tool.lastAgreement).toFixed(2)}`}
                            </span>
                          )}
                        </For>
                      </div>
                    )}
                  </For>
                </div>
              </ScrollView>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  )
}
