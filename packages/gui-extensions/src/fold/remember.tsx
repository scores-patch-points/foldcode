import { createSignal, For, type JSX, onMount, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { ScrollView } from "@opencode/ui/scroll-view"
import { useExtension, type MountedSession } from "../sdk"
import { FOLD_URL } from "./panel"
import { emptyReason, groupByTag, whenLabel, type PromptEntry, type RecallEntry, type StoreRead } from "./remember-model"

// The Remember window: what the system knows, and what it may read. Three
// standing stores, all writable here and all read back from the door:
//
//   Facts     — the operator's own facts, folded from history (~/.config/opencode/user-memory.md)
//   Access    — addresses the system may read on demand (user-refs.md); the bytes ride only on a snip
//   Prompts   — system prompts attached to asks like one (system-prompts.json)
//
// Nothing here is loaded into a prompt wholesale. The door (Gary's door,
// khora/opencode-remember.mjs) injects an entry only when an ask's own words
// bear on it — the prompt sees the residue, this window sees the store. Appends
// are append-only; naming an earlier claim in `supersedes:` retires it, never
// edits it.

type Kind = "memory" | "refs" | "system"

async function readStore<E>(kind: Kind, signal?: AbortSignal): Promise<StoreRead<E>> {
  const response = await fetch(`${FOLD_URL}/v1/hooks/opencode/${kind}`, { signal })

  if (!response.ok) throw new Error(`${kind} ${response.status}`)

  // SAFETY: the door's Remember@1 route answers exactly this shape ({ kind, at?, entries, total?, gap? }); E is chosen by the caller per store.
  return (await response.json()) as StoreRead<E>
}

async function appendStore(kind: Kind, entry: Record<string, string>): Promise<void> {
  const response = await fetch(`${FOLD_URL}/v1/hooks/opencode/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(entry),
  })

  if (!response.ok) throw new Error(`${kind} ${response.status}`)
}

function Row(props: { title: string; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-2 border-b border-v2-border-border-base px-5 py-4">
      <div class="text-12-regular text-text-weak">{props.title}</div>
      {props.children}
    </section>
  )
}

function Input(props: { value: string; placeholder: string; onInput: (value: string) => void; grow?: boolean }) {
  return (
    <input
      type="text"
      value={props.value}
      placeholder={props.placeholder}
      onChange={(event) => props.onInput(event.currentTarget.value)}
      class="min-w-0 rounded-md border border-v2-border-border-base bg-transparent px-2 py-1 text-13-regular text-text-base"
      classList={{ "flex-1": props.grow === true }}
    />
  )
}

export default function SessionRememberPanel(props: { session: MountedSession }) {
  void props
  const ctx = useExtension()
  const [memory, setMemory] = createSignal<StoreRead<RecallEntry>>()
  const [refs, setRefs] = createSignal<StoreRead<RecallEntry>>()
  const [system, setSystem] = createSignal<StoreRead<PromptEntry>>()
  const [error, setError] = createSignal<string>()
  const [saved, setSaved] = createSignal<string>()

  const [factClaim, setFactClaim] = createSignal("")
  const [factTag, setFactTag] = createSignal("about:user:notes")
  const [refAddress, setRefAddress] = createSignal("")
  const [refNote, setRefNote] = createSignal("")
  const [promptName, setPromptName] = createSignal("")
  const [promptWhen, setPromptWhen] = createSignal("")
  const [promptText, setPromptText] = createSignal("")

  const load = async (signal?: AbortSignal) => {
    const [nextMemory, nextRefs, nextSystem] = await Promise.all([
      readStore<RecallEntry>("memory", signal),
      readStore<RecallEntry>("refs", signal),
      readStore<PromptEntry>("system", signal),
    ])

    setMemory(nextMemory)
    setRefs(nextRefs)
    setSystem(nextSystem)
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

  const append = (kind: Kind, entry: Record<string, string>, done: () => void) => {
    setSaved(undefined)
    setError(undefined)
    appendStore(kind, entry)
      .then(() => {
        done()
        setSaved(kind)

        return load()
      })
      .catch((cause) => setError(String(cause)))
  }

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="session-remember-panel">
      <div class="flex shrink-0 items-start justify-between gap-3 border-b border-v2-border-border-base px-5 py-4">
        <div class="flex min-w-0 flex-col gap-0.5">
          <div class="flex min-w-0 items-center gap-2">
            <span class="size-1.5 shrink-0 rounded-full bg-v2-icon-icon-accent" aria-hidden="true" />
            <div class="min-w-0 truncate text-13-regular text-text-base">{ctx.t("remember.title")}</div>
          </div>
          <div class="min-w-0 truncate text-12-regular text-text-weak">{ctx.t("remember.subtitle")}</div>
        </div>
        <Button size="small" variant="outline" onClick={refresh}>
          {ctx.t("panel.refresh")}
        </Button>
      </div>

      <ScrollView class="min-h-0 flex-1">
        <Show when={error()}>
          <div class="border-b border-v2-border-border-base px-5 py-3 text-12-regular text-text-weak">
            {error()} — {ctx.t("remember.offline")}
          </div>
        </Show>

        <Row title={ctx.t("remember.facts")}>
          <Show
            when={memory()?.entries.length}
            fallback={<div class="text-12-regular text-text-weak">{emptyReason(memory()?.gap)}</div>}
          >
            <For each={groupByTag(memory()?.entries ?? [])}>
              {(group) => (
                <div class="flex flex-col gap-1">
                  <div class="text-12-regular uppercase tracking-wide text-text-weak">{group.tag}</div>
                  <For each={group.entries}>
                    {(entry) => (
                      <div class="text-13-regular text-text-base">
                        · {entry.claim}
                        <Show when={entry.falsifying}>
                          <span class="text-12-regular text-text-weak"> (falsified by: {entry.falsifying})</span>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </Show>
          <div class="flex flex-col gap-1.5 pt-1">
            <Input value={factClaim()} placeholder={ctx.t("remember.factPlaceholder")} onInput={setFactClaim} />
            <div class="flex items-center gap-2">
              <Input value={factTag()} placeholder="about:user:tags" onInput={setFactTag} />
              <Button
                size="small"
                variant="outline"
                disabled={factClaim().trim().length === 0}
                onClick={() => append("memory", { claim: factClaim(), tag: factTag() }, () => setFactClaim(""))}
              >
                {ctx.t("remember.add")}
              </Button>
              <Show when={saved() === "memory"}>
                <span class="text-12-regular text-text-weak">{ctx.t("remember.saved")}</span>
              </Show>
            </div>
          </div>
        </Row>

        <Row title={ctx.t("remember.access")}>
          <Show
            when={refs()?.entries.length}
            fallback={<div class="text-12-regular text-text-weak">{emptyReason(refs()?.gap)}</div>}
          >
            <For each={refs()?.entries ?? []}>
              {(entry) => <div class="text-13-regular text-text-base">· {entry.claim}</div>}
            </For>
          </Show>
          <div class="flex flex-col gap-1.5 pt-1">
            <Input value={refAddress()} placeholder={ctx.t("remember.accessAddress")} onInput={setRefAddress} />
            <div class="flex items-center gap-2">
              <Input value={refNote()} placeholder={ctx.t("remember.accessNote")} onInput={setRefNote} grow />
              <Button
                size="small"
                variant="outline"
                disabled={refAddress().trim().length === 0}
                onClick={() =>
                  append("refs", { claim: `${refAddress().trim()} — ${refNote().trim()}` }, () => {
                    setRefAddress("")
                    setRefNote("")
                  })
                }
              >
                {ctx.t("remember.add")}
              </Button>
              <Show when={saved() === "refs"}>
                <span class="text-12-regular text-text-weak">{ctx.t("remember.saved")}</span>
              </Show>
            </div>
          </div>
        </Row>

        <Row title={ctx.t("remember.prompts")}>
          <Show
            when={system()?.entries.length}
            fallback={<div class="text-12-regular text-text-weak">{emptyReason(system()?.gap)}</div>}
          >
            <For each={system()?.entries ?? []}>
              {(entry) => (
                <div class="flex flex-col gap-0.5">
                  <div class="text-13-regular text-text-base">
                    {entry.name} <span class="text-12-regular text-text-weak">({whenLabel(entry)})</span>
                  </div>
                  <div class="whitespace-pre-wrap text-12-regular text-text-weak">{entry.text}</div>
                </div>
              )}
            </For>
          </Show>
          <div class="flex flex-col gap-1.5 pt-1">
            <div class="flex items-center gap-2">
              <Input value={promptName()} placeholder={ctx.t("remember.promptName")} onInput={setPromptName} />
              <Input value={promptWhen()} placeholder={ctx.t("remember.promptWhen")} onInput={setPromptWhen} grow />
            </div>
            <textarea
              value={promptText()}
              placeholder={ctx.t("remember.promptText")}
              onChange={(event) => setPromptText(event.currentTarget.value)}
              rows={3}
              class="w-full resize-y rounded-md border border-v2-border-border-base bg-transparent px-2 py-1 text-13-regular text-text-base"
            />
            <div class="flex items-center gap-2">
              <Button
                size="small"
                variant="outline"
                disabled={promptText().trim().length === 0}
                onClick={() =>
                  append(
                    "system",
                    { name: promptName(), when: promptWhen(), text: promptText() },
                    () => {
                      setPromptName("")
                      setPromptWhen("")
                      setPromptText("")
                    },
                  )
                }
              >
                {ctx.t("remember.add")}
              </Button>
              <Show when={saved() === "system"}>
                <span class="text-12-regular text-text-weak">{ctx.t("remember.saved")}</span>
              </Show>
            </div>
          </div>
        </Row>

        <div class="px-5 py-4 text-12-regular text-text-weak">{ctx.t("remember.footnote")}</div>
      </ScrollView>
    </div>
  )
}
