// An adapter is `ask(prompt, {context}) -> {text, tokens?}`. The protocol is plain text so any model can play:
// the model answers `ANSWER: ...`, or asks for a pointer's bytes with `SNIP <ref>` (at most `maxRounds` times).
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const INSTRUCTION =
  "The transcript below is the whole record of an earlier working session, and no tools are available here. " +
  "Where it holds a pointer like `SNIP r123`, replying with exactly `SNIP r123` returns the bytes behind it. " +
  "Reply `ANSWER: <your answer>`, or `ANSWER: UNKNOWN` when the transcript does not hold it."

export async function ask({ adapter, arm, task, maxRounds = 3, built }) {
  const { context, resolve, authored = "", index, meta } = built ?? (await arm.build(task))
  let transcript = context
  let rounds = 0, snips = 0, fabricated = 0, ms = 0
  const seen = new Set()
  let tokens = 0
  const issued = index ? [...index.keys()] : []
  for (;;) {
    const prompt = `${INSTRUCTION}\n\n=== TRANSCRIPT ===\n${transcript}\n\n=== QUESTION ===\n${task.probe}\n`
    const out = await adapter.ask(prompt, { task, index })
    tokens += out.tokens ?? 0
    ms += out.ms ?? 0
    if (out.error) return { answer: "", error: out.error, ctxChars: context.length, rounds, tokens, ms, snips, fabricated, leaked: 0, authored, meta }
    const snip = /^\s*SNIP\s+(\S+)/m.exec(out.text)
    if (snip && resolve && rounds < maxRounds && !seen.has(snip[1])) {
      seen.add(snip[1])
      snips++
      const bytes = resolve(snip[1])
      if (bytes === undefined) fabricated++ // a handle that was never issued: the model wrote an address
      rounds++
      transcript += `\n\n[SNIP ${snip[1]} →]\n${bytes ?? "(no such ref)"}`
      continue
    }
    const m = /ANSWER:\s*([\s\S]*)/i.exec(out.text)
    const answer = (m ? m[1] : out.text).trim()
    const leaked = issued.filter((h) => new RegExp(`\\b${h}\\b`).test(answer)).length // a handle written into the answer
    return { answer, ctxChars: context.length, rounds, tokens, ms, snips, fabricated, leaked, authored, meta }
  }
}

const mockAsk = (fabricate) => async (prompt, { task, index }) => {
  const shown = prompt.slice(prompt.indexOf("=== TRANSCRIPT ==="), prompt.indexOf("=== QUESTION ==="))
  const consts = (shown.match(/export const [A-Z_]+ = \d{3,4}\b/g) ?? []).length
  const sawProse = shown.includes(`at ${task.expect}.`)
  const visible = task.kind === "prose" ? sawProse : task.kind === "twohop" ? consts >= 2 : shown.includes(`= ${task.expect}`)
  if (visible) return { text: `ANSWER: ${task.expect}` }
  if (fabricate && /(?:SNIP |^)r\d{3}\b/m.test(shown) && !shown.includes("SNIP r999 →")) return { text: "SNIP r999" }
  for (const m of shown.matchAll(/(?:SNIP |^)(r\d{3})\b/gm)) {
    if (shown.includes(`[SNIP ${m[1]} →]`)) continue
    const e = index?.get(m[1]); if (e?.planted || (e?.ref && /= \d{3,4}\b|\bat \d{3,4}\.|is \d{3,4} for now/.test(e.ref.bytes))) return { text: `SNIP ${m[1]}` }
  }
  for (const m of shown.matchAll(/SNIP (turn(\d+)#\S+?)\]/g)) {
    if (shown.includes(`[SNIP ${m[1]} →]`)) continue
    if (task.turns[Number(m[2]) - 1]?.calls[0]?.planted) return { text: `SNIP ${m[1]}` }
  }
  return { text: "ANSWER: UNKNOWN" }
}
// Plumbing doubles, not models: `mock` reads what it is shown and asks for exactly the pointer that hides the planted
// line (it knows which; a real model must guess); `mockFabricating` first asks for a handle that was never issued.
export const mock = { name: "mock", ask: mockAsk(false) }
export const mockFabricating = { name: "mock-fab", ask: mockAsk(true) }

// The real thing: `opencode run`, context as an attached file so argv stays small. Sessions it creates are
// ordinary opencode sessions in the user's DB. stdin must be /dev/null or `opencode run` hangs.
// A call that errors (quota, timeout, empty reply, tool use) returns {error}; the runner reports it and never scores
// it as a wrong answer. Quota and rate errors are retried with backoff.
// OPENCODE_BIN / OPENCODE_STANDALONE let a host run a specific binary (native vs the fold fork) and
// skip the managed background service when its port is taken. `ms` is the wall-clock of one call —
// the number a "the fold is faster than native" claim has to move.
const BIN = process.env.OPENCODE_BIN ?? "opencode"
const STANDALONE = process.env.OPENCODE_STANDALONE === "1"
const once = (model, prompt, timeoutMs) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-"))
  const file = path.join(dir, "prompt.txt")
  fs.writeFileSync(file, prompt)
  // THE MOUTH IS TEXT: no tools, ever (the fold's own second-mouth rule). Without this the model, given a reduced
  // arm, reaches for read/bash to get the hidden bytes instead of following the SNIP protocol, and the measurement
  // is contaminated — measured on deepseek-v4.1-flash: handles6 needle@10 -> "model used 9 tools", 161k tokens,
  // wrong. A deny-all permission rule disables every tool at the door (verified: provoked a tool, got 0).
  fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", permission: "deny" }))
  const args = ["run", ...(STANDALONE ? ["--standalone"] : []), "-m", model, "--format", "json", "-f", file, "Follow the instructions in the attached file."]
  const started = Date.now()
  try {
    const r = spawnSync(BIN, args, {
      cwd: dir, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
    })
    let text = "", tokens = 0, toolCalls = 0, provider
    for (const line of (r.stdout ?? "").split("\n")) {
      let j
      try { j = JSON.parse(line) } catch { continue }
      const part = j.part ?? j
      if (part.type === "text" && typeof part.text === "string") text += part.text
      if (j.type === "error") provider = `${j.error?.type ?? "provider error"}: ${String(j.error?.message ?? "").slice(0, 160)}`
      if (part.type === "tool") toolCalls++
      // usage rides a `step-finish` part (cli/run/noninteractive.ts:496) whose emission races the execution
      // boundary, so read every shape it can arrive in and never count a silent 0 as a real measurement.
      const t = part.tokens ?? j.tokens ?? j.usage
      if (t) tokens += (t.input ?? t.promptTokens ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    }
    if (process.env.ORACLE_DUMP) { try { fs.writeFileSync(process.env.ORACLE_DUMP, r.stdout ?? "") } catch { /* debug only */ } }
    const error = provider ?? (r.error ? String(r.error.message ?? r.error) : r.status !== 0 ? `exit ${r.status}: ${(r.stderr ?? "").slice(0, 300)}` : !text.trim() ? "empty reply" : toolCalls ? `model used ${toolCalls} tools` : undefined)
    return { text, tokens, error, ms: Date.now() - started }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
export const opencode = (model, { timeoutMs = 180_000, waits = [20_000, 60_000, 120_000] } = {}) => ({
  name: `opencode:${model}`,
  ask: async (prompt) => {
    let ms = 0
    for (let i = 0; ; i++) {
      const out = once(model, prompt, timeoutMs)
      ms += out.ms ?? 0
      if (!out.error || !/quota|rate|429|overload/i.test(out.error) || i >= waits.length) return { ...out, ms }
      await new Promise((res) => setTimeout(res, waits[i]))
    }
  },
})

// The stack's own mechanical eye, no model: the task's agent turns are written as turns.md, recorded into a weft store
// (khora/opencode-weft-record.mjs: INS beings, CON relations at a byte), then the probe is asked of the store
// (opencode-weft-find.mjs) and the hit is expanded to its verbatim sentence. It reads the STORE, never the prompt, so
// it is independent of the arm. The weft indexes what agents SAID; it does not index tool output, so a fact that lives
// only in a tool result is a gap here, and the report says so.
const KHORA = process.env.FOLD_KHORA ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../khora")
export const mechanicalStack = {
  name: "mechanical-stack",
  ask: async (_prompt, { task }) => {
    const rec = await import(path.join(KHORA, "opencode-weft-record.mjs"))
    const find = await import(path.join(KHORA, "opencode-weft-find.mjs"))
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mech-"))
    const dir = path.join(root, "weft")
    const prev = { w: process.env.FOLD_WEFT_DIR, off: process.env.FOLD_WEFT }
    process.env.FOLD_WEFT_DIR = dir
    delete process.env.FOLD_WEFT
    try {
      fs.mkdirSync(path.join(root, "t"), { recursive: true })
      const file = path.join(root, "t", "a.turns.md")
      fs.writeFileSync(file, task.turns.map((t, i) => `## turn ${i + 1}\n${t.ask}\n\n${t.answer}\n\n`).join(""))
      const r = rec.recordTurnsToWeft({ task: "t", agent: "a", turns: task.turns.map((t, i) => ({ n: i + 1, ask: t.ask, answer: t.answer })), file, dir })
      if (r.gap || r.skipped) return { text: `ANSWER: UNKNOWN (${JSON.stringify(r.gap ?? r.skipped)})` }
      const { hits } = find.findInWeft({ ask: task.probe, dir, max: 3 })
      const sentences = hits.map((h) => find.expandHit(h, { root })?.text ?? "")
      const nums = sentences.map((s) => (/\b\d{3,5}\b/.exec(s) ?? [])[0]).filter(Boolean)
      if (!nums.length) return { text: "ANSWER: UNKNOWN" }
      return { text: `ANSWER: ${task.kind === "twohop" && nums.length >= 2 ? Number(nums[0]) + Number(nums[1]) : nums[0]}` }
    } finally {
      process.env.FOLD_WEFT_DIR = prev.w
      if (prev.w === undefined) delete process.env.FOLD_WEFT_DIR
      fs.rmSync(root, { recursive: true, force: true })
    }
  },
}

// A local model straight through ollama's HTTP API (localhost only, no credentials). No tool definitions are sent, so
// models without tool support work, and num_ctx is set explicitly: ollama's default window is small and it truncates
// silently, which is exactly what Gary's fits-the-window rule exists to catch.
export const ollama = (model, { numCtx = 8192, numPredict, host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434", timeoutMs = 300_000 } = {}) => ({
  name: `ollama:${model}`,
  ask: async (prompt) => {
    try {
      const r = await fetch(`${host}/api/chat`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ model, stream: false, options: { num_ctx: numCtx, temperature: 0, ...(numPredict ? { num_predict: numPredict } : {}) }, messages: [{ role: "user", content: prompt }] }),
      })
      const j = await r.json()
      if (!r.ok || j.error) return { text: "", error: `ollama: ${String(j.error ?? r.status).slice(0, 160)}` }
      const text = j.message?.content ?? ""
      return { text, tokens: (j.prompt_eval_count ?? 0) + (j.eval_count ?? 0), error: text.trim() ? undefined : "empty reply", promptTokens: j.prompt_eval_count }
    } catch (e) {
      return { text: "", error: `ollama: ${String(e.message ?? e).slice(0, 160)}` }
    }
  },
})
