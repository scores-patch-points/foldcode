// fold-ruler — layer 0 of the context-reduction ladder. Measurement only: it reads the EXACT request body the
// frontier is about to receive and says where the bytes are. It changes nothing and carries no fold logic.
//
// Segments (chars of the JSON-encoded leaf, so they are substrings of the body):
//   system | tools | user.text | assistant.text | assistant.thinking | assistant.tool_call | result.<tool> | media
// `overhead` is everything the segmentation did not claim (JSON braces, role keys, sampling params). A ruler
// whose overhead is a large share of the body is not measuring the prompt, so tests hold it small.
// `staleResult` is the part of result.* that sits before the last user text: the bytes layer 3 may point at.
// Shapes handled: Anthropic messages, OpenAI chat, OpenAI responses, Gemini contents.
import fs from "node:fs"
import path from "node:path"

export type Seg = Record<string, { chars: number; n: number }>
export type Ruler = { total: number; segments: Seg; overhead: number; staleResult: number; messages: number }

type Json = unknown
const isObj = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v)
const len = (v: Json) => (typeof v === "undefined" ? 0 : (JSON.stringify(v)?.length ?? 0))

export const measure = (body: string): Ruler => {
  const segments: Seg = {}
  const add = (key: string, v: Json) => {
    const s = (segments[key] ??= { chars: 0, n: 0 })
    s.chars += len(v)
    s.n += 1
  }
  let doc: Json
  try {
    doc = JSON.parse(body)
  } catch {
    return { total: body.length, segments: { unparsed: { chars: body.length, n: 1 } }, overhead: 0, staleResult: 0, messages: 0 }
  }
  if (!isObj(doc)) return { total: body.length, segments: { unparsed: { chars: body.length, n: 1 } }, overhead: 0, staleResult: 0, messages: 0 }

  for (const k of ["system", "instructions", "systemInstruction", "system_instruction"]) if (doc[k] !== undefined) add("system", doc[k])
  if (Array.isArray(doc.tools)) for (const t of doc.tools) add("tools", t)

  const items = [doc.messages, doc.input, doc.contents].find(Array.isArray) as Json[] | undefined
  const names = new Map<string, string>() // tool call id -> tool name, so a result is billed to the tool that made it
  const list = items ?? []
  const isUserText = (m: Json) => {
    if (!isObj(m) || (m.role !== "user" && m.type !== "message")) return false
    if (m.role !== "user") return false
    const c = m.content ?? m.parts
    if (typeof c === "string") return true
    return Array.isArray(c) && c.some((b) => isObj(b) && (b.type === "text" || b.type === "input_text" || typeof b.text === "string"))
  }
  let lastUser = -1
  list.forEach((m, i) => {
    if (isUserText(m)) lastUser = i
  })

  let staleResult = 0
  const result = (index: number, id: Json, v: Json, fallback: string) => {
    const name = (typeof id === "string" ? names.get(id) : undefined) ?? fallback
    add(`result.${name}`, v)
    if (index < lastUser) staleResult += len(v)
  }

  list.forEach((m, index) => {
    if (!isObj(m)) return
    const role = typeof m.role === "string" ? (m.role === "model" ? "assistant" : m.role) : "assistant"
    // OpenAI responses items
    if (m.type === "function_call") {
      if (typeof m.call_id === "string" && typeof m.name === "string") names.set(m.call_id, m.name)
      add("assistant.tool_call", m)
      return
    }
    if (m.type === "function_call_output") return result(index, m.call_id, m.output, "unknown")
    if (m.type === "reasoning") return add("assistant.thinking", m)
    // OpenAI chat
    if (role === "tool") return result(index, m.tool_call_id, m.content, "unknown")
    if (Array.isArray(m.tool_calls))
      for (const c of m.tool_calls) {
        if (isObj(c) && typeof c.id === "string" && isObj(c.function) && typeof c.function.name === "string") names.set(c.id, c.function.name)
        add("assistant.tool_call", c)
      }
    // chat-style reasoning rides beside content (deepseek reasoning_content, openrouter reasoning/reasoning_details)
    for (const k of ["reasoning_content", "reasoning", "reasoning_details"]) if (m[k] !== undefined && m[k] !== null) add("assistant.thinking", m[k])
    const kind = role === "assistant" ? "assistant" : role === "system" || role === "developer" ? "system" : "user"
    const content = m.content ?? m.parts
    if (typeof content === "string") return add(kind === "system" ? "system" : `${kind}.text`, content)
    if (!Array.isArray(content)) return
    for (const b of content) {
      if (!isObj(b)) continue
      const t = b.type
      if (t === "tool_use") {
        if (typeof b.id === "string" && typeof b.name === "string") names.set(b.id, b.name)
        add("assistant.tool_call", b)
      } else if (t === "tool_result") result(index, b.tool_use_id, b.content, "unknown")
      else if (t === "thinking" || t === "redacted_thinking" || t === "reasoning") add("assistant.thinking", b)
      else if (t === "image" || t === "input_image" || t === "document" || b.inlineData !== undefined) add("media", b)
      else if (b.functionCall !== undefined) add("assistant.tool_call", b)
      else if (b.functionResponse !== undefined) {
        const r = b.functionResponse
        result(index, undefined, b, isObj(r) && typeof r.name === "string" ? r.name : "unknown")
      } else if (typeof b.text === "string") add(kind === "system" ? "system" : `${kind}.text`, b)
    }
  })

  const claimed = Object.values(segments).reduce((a, s) => a + s.chars, 0)
  return { total: body.length, segments, overhead: Math.max(0, body.length - claimed), staleResult, messages: list.length }
}

// One JSON line per primary request, appended to FOLD_RULER_FILE. `seq` is per session so the n-th line
// joins the n-th assistant message of that session in the DB (see perf/ruler-join.py).
const seqs = new Map<string, number>()
export const record = (file: string, meta: { sessionID?: string; model?: unknown }, body: string) => {
  const sid = meta.sessionID ?? "?"
  const seq = (seqs.get(sid) ?? 0) + 1
  seqs.set(sid, seq)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), sid, seq, model: meta.model, ...measure(body) }) + "\n")
  } catch {
    // measurement must never touch the request
  }
}

// The provider's own count for the step that just ended, beside the request lines, so the ruler can be checked
// against the bill: sum(segment chars) must track input + cache.read + cache.write within a stable chars/token.
export const recordTokens = (file: string, sessionID: string | undefined, tokens: unknown) => {
  try {
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), sid: sessionID ?? "?", tokens }) + "\n")
  } catch {}
}
