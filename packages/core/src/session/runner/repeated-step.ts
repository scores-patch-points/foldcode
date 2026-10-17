export * as SessionRunnerRepeatedStep from "./repeated-step.js"

// A weak or sloppy model can wedge a turn by issuing the same tool call again and
// again without acting on the result it already holds (measured 2026-10-17: a
// supervising model re-ran `node openfold.test.js` ~16 times, only cosmetic
// changes to the output plumbing, while the failing assertions sat in its own
// prior tool result). Tools then stay on and the step allowance never trips, so
// nothing in the runner ends the turn. This module names the loop so the runner
// can force one text-only step and let the turn close.

const limit = () => Number(process.env.SESSION_REPEATED_STEP_LIMIT ?? 3)

// The command reduced to what it actually does: drop the output plumbing (pipes,
// redirections, and the `;`-chained tail) so `cmd > /tmp/x; grep …` and
// `cmd 2>&1 | grep …` share one signature while genuinely different commands stay
// apart. `&&` is kept — it names a real second command.
const normalizeCommand = (command: string) =>
  command
    .replace(/\|.*/g, "")
    .replace(/;.*/g, "")
    .replace(/[0-9]?>>?\s*\S+/g, "")
    .replace(/[0-9]?>&[0-9]?/g, "")
    .replace(/\s+/g, " ")
    .trim()

type ToolCallLike = { readonly name?: string; readonly state?: { readonly input?: unknown } }
type MessageLike = {
  readonly type: string
  readonly content?: ReadonlyArray<{ readonly type: string } & ToolCallLike>
}

const signatureOf = (call: ToolCallLike) => {
  const input = call.state?.input
  if (typeof input === "string") return input
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>
    const target = record.filePath ?? record.file_path ?? record.path ?? record.file ?? record.pattern ?? record.url
    if (typeof target === "string") return target
    if (typeof record.command === "string") return normalizeCommand(record.command)
    return JSON.stringify(record)
  }
  return ""
}

// True when the last `SESSION_REPEATED_STEP_LIMIT` steps each called the same
// target(s), counting back from the most recent input (user/synthetic/system) so a
// fresh steer clears the count. An intervening step that touches something else
// breaks the run, so a test→edit→test rhythm never trips.
export const repeatedStep = (messages: ReadonlyArray<MessageLike>) => {
  const max = limit()
  if (!(max > 0)) return false
  const signatures: Array<string> = []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message) continue
    if (message.type === "user" || message.type === "synthetic" || message.type === "system") break
    if (message.type !== "assistant") continue
    const calls = (message.content ?? []).filter((part) => part.type === "tool")
    if (calls.length === 0) continue
    signatures.push(
      calls
        .map((call) => `${call.name ?? "?"} ${signatureOf(call)}`)
        .sort()
        .join(" + "),
    )
    if (signatures.length >= max) break
  }
  if (signatures.length < max) return false
  return signatures.every((signature) => signature === signatures[0])
}

export const REPEATED_STEP_PROMPT = `CRITICAL - REPEATED ACTION DETECTED

You have issued the same tool call with the same target ${limit()} steps in a row without making progress. This is a loop. Tools are disabled for this step so it cannot continue.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls.
2. State plainly what the repeated action was and what its result already told you.
3. State the single concrete next action, and what specifically would be different about it.
4. If you are blocked, say what blocks you instead of repeating the action.

Respond with text only.`
