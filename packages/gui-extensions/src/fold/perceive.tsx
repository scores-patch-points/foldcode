import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { Button } from "@opencode/ui/button"
import { ScrollView } from "@opencode/ui/scroll-view"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { useExtension, type MountedSession } from "../sdk"
import { FOLD_URL } from "./panel"

// The Perceive tab: which eyes and ears attached files get, before the
// frontier is sent them. Defaults are local-first — the khora on the box
// (tesseract, ffmpeg, poppler, whisper.cpp when installed) — so vision and
// transcription cost no frontier call. The door holds the config; this tab
// reads and writes it, and the doorway plugin enforces it per attachment.
type Vision = "khora-local" | "frontier"
type Transcription = "local" | "off"
type Pdf = "layer-then-ocr" | "layer-only"

type Config = {
  vision: Vision
  transcription: Transcription
  pdf: Pdf
  ocrLang: string
  replaceMedia: boolean
}

type Backends = Record<"ffmpeg" | "tesseract" | "pdftotext" | "pdftoppm" | "whisper", boolean>

const CONFIG_URL = `${FOLD_URL}/v1/hooks/opencode/perceive-config`

function Segment<T extends string>(props: { options: { value: T; label: string; hint?: string }[]; value: T; onPick: (value: T) => void }) {
  return (
    <div class="flex flex-col gap-1.5">
      <For each={props.options}>
        {(option) => (
          <button
            type="button"
            onClick={() => props.onPick(option.value)}
            aria-pressed={props.value === option.value}
            class="flex cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2 text-left"
            classList={{
              "border-v2-icon-icon-accent": props.value === option.value,
              "border-v2-border-border-base": props.value !== option.value,
            }}
          >
            <span class="text-13-regular text-text-base">
              {props.value === option.value ? "● " : "○ "}
              {option.label}
            </span>
            <Show when={option.hint}>
              <span class="text-12-regular text-text-weak">{option.hint}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  )
}

function Row(props: { title: string; children: unknown }) {
  return (
    <div class="flex flex-col gap-2 border-b border-v2-border-border-base px-5 py-4">
      <div class="text-12-regular text-text-weak">{props.title}</div>
      {props.children as never}
    </div>
  )
}

export default function SessionPerceivePanel(props: { session: MountedSession }) {
  void props
  const ctx = useExtension()
  const [config, setConfig] = createSignal<Config | undefined>(undefined)
  const [defaults, setDefaults] = createSignal<Config | undefined>(undefined)
  const [backends, setBackends] = createSignal<Backends | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [saved, setSaved] = createSignal(false)
  const [nonce, setNonce] = createSignal(0)

  const load = async (signal?: AbortSignal) => {
    const response = await fetch(CONFIG_URL, { signal })
    if (!response.ok) throw new Error(`${response.status}`)
    const doc = (await response.json()) as { config: Config; defaults: Config; backends?: Backends }
    setConfig(doc.config)
    setDefaults(doc.defaults)
    setBackends(doc.backends)
  }

  onMount(() => {
    const controller = new AbortController()
    load(controller.signal).catch((cause) => setError(String(cause)))
    return () => controller.abort()
  })

  const save = async (patch: Partial<Config>) => {
    setSaved(false)
    setError(undefined)
    const next = { ...(config() ?? {}), ...patch }
    setConfig(next as Config)
    try {
      const response = await fetch(CONFIG_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      })
      if (!response.ok) throw new Error(`${response.status}`)
      const doc = (await response.json()) as { config: Config }
      setConfig(doc.config)
      setSaved(true)
    } catch (cause) {
      setError(String(cause))
    }
  }

  const refresh = () => {
    setError(undefined)
    load().catch((cause) => setError(String(cause)))
    setNonce((value) => value + 1)
  }
  void nonce

  const missing = createMemo(() => {
    const have = backends()
    if (!have) return []
    const need: { key: keyof Backends; label: string }[] = [
      { key: "tesseract", label: "tesseract (image OCR, scanned PDFs)" },
      { key: "pdftotext", label: "pdftotext (PDF text layers)" },
      { key: "ffmpeg", label: "ffmpeg (image descriptors, audio probe)" },
      { key: "whisper", label: "whisper (local audio transcription)" },
    ]
    return need.filter((item) => !have[item.key]).map((item) => item.label)
  })

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-perceive-panel">
      <div class="flex shrink-0 items-start justify-between gap-3 border-b border-v2-border-border-base px-5 py-4">
        <div class="flex min-w-0 flex-col gap-0.5">
          <div class="flex min-w-0 items-center gap-2">
            <span class="size-1.5 shrink-0 rounded-full bg-v2-icon-icon-accent" aria-hidden="true" />
            <div class="min-w-0 truncate text-13-regular text-text-base">{ctx.t("perceive.title")}</div>
          </div>
          <div class="min-w-0 truncate text-12-regular text-text-weak">{ctx.t("perceive.subtitle")}</div>
        </div>
        <Button size="small" variant="outline" onClick={refresh}>
          {ctx.t("panel.refresh")}
        </Button>
      </div>

      <div class="relative min-h-0 flex-1">
        <Switch>
          <Match when={error() !== undefined && config() === undefined}>
            <div class="flex h-full flex-col items-center justify-center gap-3 px-8 pb-24 text-center">
              <div class="text-13-regular text-text-weak">{ctx.t("perceive.offline")}</div>
              <Button size="small" variant="outline" onClick={refresh}>
                {ctx.t("panel.retry")}
              </Button>
            </div>
          </Match>
          <Match when={config() === undefined}>
            <div
              data-component="session-working"
              role="status"
              class="flex h-9 items-center px-5 pt-3 text-[13px] font-[530] leading-text-compact"
            >
              <TextShimmer text={ctx.t("panel.loading")} active />
            </div>
          </Match>
          <Match when={config()}>
            {(value) => (
              <ScrollView class="absolute inset-0">
                <Show when={missing().length > 0}>
                  <div class="border-b border-v2-border-border-base px-5 py-4">
                    <div class="text-13-regular text-text-base">{ctx.t("perceive.missingTitle")}</div>
                    <For each={missing()}>
                      {(label) => <div class="text-12-regular text-text-weak">· {label} — {ctx.t("perceive.missingNote")}</div>}
                    </For>
                  </div>
                </Show>

                <Row title={ctx.t("perceive.vision")}>
                  <Segment<Vision>
                    value={value().vision}
                    onPick={(vision) => void save({ vision })}
                    options={[
                      { value: "khora-local", label: ctx.t("perceive.visionLocal"), hint: ctx.t("perceive.visionLocalHint") },
                      { value: "frontier", label: ctx.t("perceive.visionFrontier"), hint: ctx.t("perceive.visionFrontierHint") },
                    ]}
                  />
                </Row>

                <Row title={ctx.t("perceive.transcription")}>
                  <Segment<Transcription>
                    value={value().transcription}
                    onPick={(transcription) => void save({ transcription })}
                    options={[
                      { value: "local", label: ctx.t("perceive.transcriptionLocal"), hint: ctx.t("perceive.transcriptionLocalHint") },
                      { value: "off", label: ctx.t("perceive.transcriptionOff"), hint: ctx.t("perceive.transcriptionOffHint") },
                    ]}
                  />
                </Row>

                <Row title={ctx.t("perceive.pdf")}>
                  <Segment<Pdf>
                    value={value().pdf}
                    onPick={(pdf) => void save({ pdf })}
                    options={[
                      { value: "layer-then-ocr", label: ctx.t("perceive.pdfFull"), hint: ctx.t("perceive.pdfFullHint") },
                      { value: "layer-only", label: ctx.t("perceive.pdfLayer"), hint: ctx.t("perceive.pdfLayerHint") },
                    ]}
                  />
                </Row>

                <div class="flex flex-col gap-2 border-b border-v2-border-border-base px-5 py-4">
                  <div class="text-12-regular text-text-weak">{ctx.t("perceive.ocrLang")}</div>
                  <input
                    type="text"
                    value={value().ocrLang}
                    onChange={(event) => void save({ ocrLang: event.currentTarget.value.trim() || "eng" })}
                    class="w-32 rounded-md border border-v2-border-border-base bg-transparent px-2 py-1 text-13-regular text-text-base"
                    aria-label={ctx.t("perceive.ocrLang")}
                  />
                  <label class="flex cursor-pointer items-center gap-2 text-13-regular text-text-base">
                    <input
                      type="checkbox"
                      checked={value().replaceMedia}
                      onChange={(event) => void save({ replaceMedia: event.currentTarget.checked })}
                    />
                    {ctx.t("perceive.replace")}
                  </label>
                  <div class="text-12-regular text-text-weak">{ctx.t("perceive.replaceHint")}</div>
                </div>

                <div class="flex items-center gap-3 px-5 py-4">
                  <Button
                    size="small"
                    variant="outline"
                    onClick={() => {
                      const base = defaults()
                      if (base) void save({ ...base })
                    }}
                  >
                    {ctx.t("perceive.reset")}
                  </Button>
                  <Show when={saved()}>
                    <span class="text-12-regular text-text-weak">{ctx.t("perceive.saved")}</span>
                  </Show>
                  <Show when={error()}>
                    <span class="text-12-regular text-text-weak">{error()}</span>
                  </Show>
                </div>
              </ScrollView>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  )
}
