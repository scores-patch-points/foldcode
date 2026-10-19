// usage-tap — the provider's own token count, read off the wire. Measurement only: it reads a clone of the
// exact HTTP response the frontier sent back, keeps the provider's usage objects verbatim, and appends one
// hash-chained line per request to FOLD_USAGE_FILE. It changes nothing and estimates nothing.
//
// Why the wire: every other number in the fold (chars/4, segment chars, the session's step tokens) is
// derived. The usage block in the response body is what the provider bills, so it is the ground the other
// numbers are checked against (see fold-tokens.ts).
//
// Normalized fields, one convention across providers:
//   prompt     every input token the provider counted, cached or not (= input + cacheRead + cacheWrite)
//   cacheRead  the part of prompt served from cache
//   cacheWrite the part of prompt written to cache
//   output     every generated token, reasoning included
//   reasoning  the part of output spent thinking (0 where the provider does not split it out)
//   total      the provider's own total when it reports one, else null; checked against prompt + output
// `raw` keeps every usage object exactly as received, so the normalization can be re-derived and audited.
// `complete` is true only when the stream reached its terminal event and a usage block was found.
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

export type Usage = { prompt: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number; total: number | null }
export type Parsed = { protocol: string; usage: Usage | null; raw: unknown[]; complete: boolean }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const sha = (s: string) => createHash("sha256").update(s).digest("hex")

// An SSE body is a list of `data:` payloads; a plain JSON body (stream: false) is one payload. Gemini's
// non-SSE stream is a JSON array of payloads.
const payloads = (body: string): unknown[] => {
  const trimmed = body.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const doc = JSON.parse(trimmed)
      return Array.isArray(doc) ? doc : [doc]
    } catch {}
  }
  const out: unknown[] = []
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n")
    if (!data) continue
    if (data === "[DONE]") {
      out.push("[DONE]")
      continue
    }
    try {
      out.push(JSON.parse(data))
    } catch {}
  }
  return out
}

// Anthropic messages: message_start carries the input side, message_delta carries the final (cumulative)
// output and may restate the input side. Later fields win. input_tokens EXCLUDES cache.
const anthropic = (docs: unknown[]): Parsed | undefined => {
  const raw: unknown[] = []
  const u: Obj = {}
  let seen = false
  let complete = false
  for (const d of docs) {
    if (!isObj(d)) continue
    if (d.type === "message_start" && isObj(d.message) && isObj(d.message.usage)) (seen = true), raw.push(d.message.usage), Object.assign(u, d.message.usage)
    else if (d.type === "message_delta" && isObj(d.usage)) (seen = true), raw.push(d.usage), Object.assign(u, d.usage)
    else if (d.type === "message_stop") complete = true
    else if (d.type === "message" && isObj(d.usage)) (seen = true), (complete = true), raw.push(d.usage), Object.assign(u, d.usage)
  }
  if (!seen) return undefined
  const cacheRead = n(u.cache_read_input_tokens)
  const cacheWrite = n(u.cache_creation_input_tokens)
  return {
    protocol: "anthropic-messages",
    usage: { prompt: n(u.input_tokens) + cacheRead + cacheWrite, cacheRead, cacheWrite, output: n(u.output_tokens), reasoning: 0, total: null },
    raw,
    complete,
  }
}

// OpenAI responses: the terminal event (completed / incomplete / failed) carries response.usage.
// input_tokens INCLUDES cached; output_tokens INCLUDES reasoning.
const responses = (docs: unknown[]): Parsed | undefined => {
  let last: Obj | undefined
  let complete = false
  let seen = false
  for (const d of docs) {
    if (!isObj(d)) continue
    const terminal = d.type === "response.completed" || d.type === "response.incomplete" || d.type === "response.failed"
    const r = terminal && isObj(d.response) ? d.response : d.object === "response" ? d : undefined
    if (typeof d.type === "string" && d.type.startsWith("response.")) seen = true
    if (r && isObj(r.usage)) last = r.usage
    if (terminal || d.object === "response") complete = true
  }
  if (!seen && !last) return undefined
  if (!last) return { protocol: "openai-responses", usage: null, raw: [], complete: false }
  const inD = isObj(last.input_tokens_details) ? last.input_tokens_details : {}
  const outD = isObj(last.output_tokens_details) ? last.output_tokens_details : {}
  return {
    protocol: "openai-responses",
    usage: {
      prompt: n(last.input_tokens),
      cacheRead: n(inD.cached_tokens),
      cacheWrite: n(inD.cache_write_tokens),
      output: n(last.output_tokens),
      reasoning: n(outD.reasoning_tokens),
      total: typeof last.total_tokens === "number" ? last.total_tokens : null,
    },
    raw: [last],
    complete,
  }
}

// OpenAI chat (and every chat-compatible gateway): the usage chunk arrives last, before [DONE], only when
// stream_options.include_usage was sent. prompt_tokens INCLUDES cached; completion_tokens INCLUDES reasoning.
const chat = (docs: unknown[]): Parsed | undefined => {
  let last: Obj | undefined
  let seen = false
  let complete = false
  for (const d of docs) {
    if (d === "[DONE]") complete = true
    if (!isObj(d)) continue
    if (d.object === "chat.completion.chunk" || d.object === "chat.completion" || Array.isArray(d.choices)) seen = true
    if (d.object === "chat.completion") complete = true
    if (isObj(d.usage)) last = d.usage
  }
  if (!seen) return undefined
  if (!last) return { protocol: "openai-chat", usage: null, raw: [], complete: false }
  const inD = isObj(last.prompt_tokens_details) ? last.prompt_tokens_details : {}
  const outD = isObj(last.completion_tokens_details) ? last.completion_tokens_details : {}
  return {
    protocol: "openai-chat",
    usage: {
      prompt: n(last.prompt_tokens),
      cacheRead: n(inD.cached_tokens),
      cacheWrite: n(inD.cache_write_tokens),
      output: n(last.completion_tokens),
      reasoning: n(outD.reasoning_tokens),
      total: typeof last.total_tokens === "number" ? last.total_tokens : null,
    },
    raw: [last],
    complete,
  }
}

// Gemini: every chunk may carry usageMetadata; the last one is final. promptTokenCount INCLUDES cached;
// candidatesTokenCount EXCLUDES thoughts, so output = candidates + thoughts. Tool-use prompt tokens are input.
const gemini = (docs: unknown[]): Parsed | undefined => {
  let last: Obj | undefined
  let complete = false
  for (const d of docs) {
    if (!isObj(d)) continue
    if (isObj(d.usageMetadata)) last = d.usageMetadata
    if (Array.isArray(d.candidates) && d.candidates.some((c) => isObj(c) && typeof c.finishReason === "string")) complete = true
  }
  if (!last) return undefined
  const thoughts = n(last.thoughtsTokenCount)
  return {
    protocol: "gemini",
    usage: {
      prompt: n(last.promptTokenCount) + n(last.toolUsePromptTokenCount),
      cacheRead: n(last.cachedContentTokenCount),
      cacheWrite: 0,
      output: n(last.candidatesTokenCount) + thoughts,
      reasoning: thoughts,
      total: typeof last.totalTokenCount === "number" ? last.totalTokenCount : null,
    },
    raw: [last],
    complete,
  }
}

export const parse = (body: string): Parsed => {
  const docs = payloads(body)
  return anthropic(docs) ?? responses(docs) ?? gemini(docs) ?? chat(docs) ?? { protocol: "unknown", usage: null, raw: [], complete: false }
}

// The provider's total, where it gives one, must equal prompt + output. A mismatch means the normalization
// misread a field, and the line says so rather than the reader finding out later.
export const consistent = (u: Usage) => u.total === null || u.total === u.prompt + u.output

// Append-only, hash-chained. Each line carries `prev` (the previous line's hash) and `hash` =
// sha256(prev + the line without `hash`), so a deleted, reordered or edited line breaks the chain.
// The head is read from the file's last line on EVERY append, never cached: the app loads one plugin instance
// per workspace, each with its own module state, and a cached head forked the chain the first time two
// sessions wrote within the same second (measured: two lines claiming the same parent). The read and the
// append are both synchronous, so instances in one process cannot interleave between them.
const TAIL = 64 * 1024
const head = (file: string) => {
  try {
    const fd = fs.openSync(file, "r")
    try {
      const size = fs.fstatSync(fd).size
      if (size === 0) return "genesis"
      const len = Math.min(size, TAIL)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      const last = buf.toString("utf8").trimEnd().split("\n").at(-1)
      return (last && JSON.parse(last).hash) || "genesis"
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return "genesis"
  }
}

export const append = (file: string, entry: Obj) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const prev = head(file)
  const line = { v: 1, ...entry, prev }
  const hash = sha(prev + JSON.stringify(line))
  fs.appendFileSync(file, JSON.stringify({ ...line, hash }) + "\n")
}

const seqs = new Map<string, number>()
// `window`: the fold's own before/after size of the messages + system it was handed, in the same char measure
// (contextChars + systemChars), and what the tool definitions weigh in that measure. The ledger (fold-tokens.ts)
// turns before - after into tokens with the session's own measured chars-per-token.
export type WindowSize = { before: number; after: number; tools: number; withheld?: number }
export type Meta = { sessionID?: string; kind?: string; model?: unknown; request: Request; response: Response; window?: WindowSize }

// Reads a clone of the response to its end (the provider's stream is never touched) and records it.
// `requestSha` is the sha256 of the request body, the join key to the ruler's line for the same request.
export const tap = async (file: string, meta: Meta) => {
  const started = Date.now()
  const sid = meta.sessionID ?? "?"
  const seq = (seqs.get(sid) ?? 0) + 1
  seqs.set(sid, seq)
  const [reqBody, body] = await Promise.all([
    meta.request.clone().text().catch(() => ""),
    meta.response.clone().text().catch((e: unknown) => `\u0000tap-read-failed: ${String(e)}`),
  ])
  const parsed = parse(body)
  const url = new URL(meta.request.url)
  const h = meta.response.headers
  try {
    append(file, {
      ts: started,
      ms: Date.now() - started,
      sid,
      seq,
      kind: meta.kind ?? "?",
      model: meta.model,
      host: url.host,
      path: url.pathname,
      status: meta.response.status,
      requestId: h.get("request-id") ?? h.get("x-request-id") ?? h.get("x-goog-request-id") ?? h.get("cf-ray") ?? null,
      requestSha: sha(reqBody),
      requestChars: reqBody.length,
      window: meta.window ?? null,
      responseSha: sha(body),
      responseBytes: body.length,
      protocol: parsed.protocol,
      complete: parsed.complete,
      usage: parsed.usage,
      consistent: parsed.usage ? consistent(parsed.usage) : null,
      raw: parsed.raw,
    })
  } catch {
    // measurement must never touch the request
  }
}
