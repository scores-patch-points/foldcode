// remember-model.ts — pure shaping for the Remember window. The door serves the
// operator's three standing stores at GET/POST /v1/hooks/opencode/{memory,refs,
// system} (khora/opencode-remember.mjs); this turns a store read into the lists
// the tab renders. No DOM, no fetch, so it is testable alone (like plans-model.ts).
//
// The three stores, and why they exist:
//   memory  facts about the operator, folded from history — writable here.
//   refs    addresses the system may read on demand (with snip/read); the bytes
//           are never carried into a prompt, only the address and its description.
//   system  prompt text attached to asks like this one, injected only by need.
// None of it is loaded into a prompt wholesale: the door injects an entry only
// when an ask's own words bear on it.

export type RecallEntry = {
  claim: string
  tag: string
  status?: string
  falsifying?: string
  provenance?: string
  supersedes?: string
}

export type PromptEntry = {
  id?: string
  name: string
  when?: string
  text: string
  added?: string
  supersedes?: string
}

export type StoreRead<E> = {
  schema?: string
  kind: string
  at?: string
  entries: ReadonlyArray<E>
  total?: number
  gap?: string
}

/** A system-prompt entry is the one that carries text; a recall entry is a claim. */
export function isPrompt(entry: RecallEntry | PromptEntry): entry is PromptEntry {
  return "text" in entry
}

/** Recall entries grouped under their tag, the section header the store keeps them under, in first-seen order. */
export function groupByTag(entries: ReadonlyArray<RecallEntry>): { tag: string; entries: RecallEntry[] }[] {
  const groups = new Map<string, RecallEntry[]>()

  for (const entry of entries) {
    const group = groups.get(entry.tag)

    if (group) group.push(entry)
    else groups.set(entry.tag, [entry])
  }

  return [...groups].map(([tag, list]) => ({ tag, entries: list }))
}

/** A system prompt's match label: its when-terms, else matched by its own name and text. */
export function whenLabel(entry: PromptEntry): string {
  const when = (entry.when ?? "").trim()

  return when ? `when: ${when}` : "by name and text"
}

/** Why a store shows nothing: the door's own typed gap, disclosed, never a blank. */
export function emptyReason(gap: string | undefined): string {
  if (gap === "unknown-kind") return "The door does not know this store."

  if (gap === "no-store") return "Nothing here yet. Writes land in the store file the door reads."

  return "Nothing here yet."
}
