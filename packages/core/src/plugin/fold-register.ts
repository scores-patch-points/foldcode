// THE REGISTER SEAM in the plugin: the pure parts of how foldcode uses the door's register (khora/opencode-register.mjs), kept
// out of fold.ts so they are testable without the Effect runtime (test/fold-register.test.ts).
//
// What the register is for (foldcode-poc/FAILURES.md): at the 32k cap native compaction wrote a model summary that lost "mascot
// service is called Orbit" (F1); a recall question about the conversation was routed to the web (F5); and the one configuration
// that answered recall correctly, in one request a turn with no tool calls and the fewest tokens, was the register door (config E).
// The door writes each stated binding once as a `fact` mark in the task's EOT log and projects them as a `<fold-register>` block;
// this plugin (1) asks the door whether the conversation itself answers a new ask BEFORE route and gather, so such an ask is
// never gathered, (2) pins the block in `event.system`, which native compaction never summarises (compaction.ts skips `system`),
// and (3) tells compaction that a register is present, so the mechanical record compaction is the default for that session.

/** One sentence, a fact stated, never a prohibition: the small-mouth safety gate trips on imperative negations. */
export const REGISTER_LEGEND =
  "The <fold-register> block lists facts you stated earlier in this conversation, each with the turn it was said; you may rely on them and quote them."

export type RegisterDoor = {
  ok?: boolean
  answer?: unknown
  note?: unknown
  legend?: unknown
  facts?: unknown
  wrote?: unknown
}

const isRecord = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x)

/** The door answered the ask from the register: a value, a contradiction or a provenance, never a gap. */
export const registerHit = (door: unknown): door is RegisterDoor & { answer: Record<string, unknown> } => {
  if (!isRecord(door) || door.ok !== true || !isRecord(door.answer)) return false
  const a = door.answer
  if (typeof a.gap === "string") return false
  return a.value !== undefined || isRecord(a.contradiction) || Array.isArray(a.turns)
}

/** The `<fold-register>` block the door projected, or undefined when it has nothing to say. */
export const registerBlock = (door: unknown): string | undefined => {
  if (!isRecord(door)) return undefined
  const note = door.register ?? door.note
  return typeof note === "string" && note.startsWith("<fold-register>") ? note : undefined
}

// Sessions with a register this process has seen: compaction reads it to choose record mode by default.
const registered = new Set<string>()
export const markRegistered = (sessionID: string, present: boolean) => {
  if (present) registered.add(sessionID)
  else registered.delete(sessionID)
}
export const hasRegister = (sessionID: string) => registered.has(sessionID)

/** Which compaction runs: `FOLD_COMPACT` decides when set; unset, the mechanical record is the default for a session whose
 *  stated facts are pinned in the register (a model summary can no longer lose them, and it is the summariser that crashed in F7). */
export const compactMode = (env: string | undefined, present: boolean): "record" | "model" =>
  env === "record" || (env === undefined && present) ? "record" : "model"

/** Trailing assistant-role messages that are the fold's own person-facing notices are not part of the ask: a request that ends on
 *  one ends on an assistant message, which a provider without prefill rejects (F5). Returns how many were dropped. */
// a part is read for its text only when it is a text part: the constraint names what every message part has (a type),
// not a `text` every part would have to carry, so the provider's own Message type satisfies it without a cast
export const dropTrailingNotices = <M extends { role: string; content: ReadonlyArray<{ type: string }> }>(
  messages: M[],
  isNotice: (text: string) => boolean,
) => {
  let dropped = 0
  while (messages.length > 0) {
    const last = messages[messages.length - 1]
    if (last.role !== "assistant") break
    const text = last.content.flatMap((part) => (part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : [])).join("\n")
    if (!isNotice(text)) break
    messages.pop()
    dropped += 1
  }
  return dropped
}

/** The measured fixed overhead (+5 tools on every request, ~10% before any history): the fold's own tools a turn cannot use are not
 *  sent. `swarm` and `cube` are research and analysis tools, kept only on a research ask; `perceive` and `transcribe` read media, kept
 *  only when the ask names a file, an image or a URL. `snip` and `fold` always ride. Returns the names removed. */
export const MEDIA_REF = /https?:\/\/|[\w~./-]+\.(?:png|jpe?g|gif|webp|heic|pdf|mp3|wav|m4a|ogg|flac|mp4|mov|mkv|webm)\b/i
export const gateTools = (tools: Record<string, unknown>, ask: string, { research }: { research: boolean }) => {
  const removed: string[] = []
  const media = MEDIA_REF.test(ask)
  for (const name of Object.keys(tools)) {
    const leaf = name.split(/[_:./-]/).pop() ?? name
    if (!research && (leaf === "swarm" || leaf === "cube")) removed.push(name)
    else if (!media && (leaf === "perceive" || leaf === "transcribe")) removed.push(name)
  }
  for (const name of removed) delete tools[name]
  return removed
}

/** The fold's own tools, by leaf name: the six this plugin registers. */
export const FOLD_TOOL_LEAVES = new Set(["fold", "snip", "swarm", "cube", "perceive", "transcribe"])

/** What the plugin adds to a compaction summary request: nothing but its tool definitions, and those are removed here. The summary
 *  prompt ends "Do not continue the task or call tools", the `context` hook never runs for a compaction request (its register, legends
 *  and notes ride only on primary requests, where the register is re-pinned after every compaction, A3), so the fold's tools are the
 *  one thing of the fold's a compaction request carried. Measured on the hard chat at a 16k cap (F7/F12): the compaction request's
 *  fixed prefix was 18,055 tokens against a 14,400-token ceiling, every turn compacted. Returns the names removed. */
export const compactionTools = (tools: Record<string, unknown>) => {
  const removed: string[] = []
  for (const name of Object.keys(tools)) {
    const leaf = name.split(/[_:./-]/).pop() ?? name
    if (FOLD_TOOL_LEAVES.has(leaf)) removed.push(name)
  }
  for (const name of removed) delete tools[name]
  return removed
}
