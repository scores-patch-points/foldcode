// Live: qwen2.5-coder:1.5b on ollama (:11435, OLLAMA_CONTEXT_LENGTH=8192) completes a real edit with NO tool definitions in
// the request. Skipped unless FOLD_LIVE=1 (needs the model). The request is exactly what fold.ts sends on a derived turn.
import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { commit, derive, present, resolve } from "../src/plugin/physics.js"

const live = process.env.FOLD_LIVE === "1"
const url = process.env.FOLD_LIVE_URL ?? "http://127.0.0.1:11435/v1/chat/completions"

test.skipIf(!live)("qwen2.5-coder:1.5b edits a file end to end with no tool definitions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phys-live-"))
  const file = path.join(dir, "calc.py")
  fs.writeFileSync(file, "def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n")
  const ask = "Fix the add function in calc.py so it adds instead of subtracts."
  const plan = resolve(ask, dir)
  expect(plan.kind).toBe("edit")
  if (plan.kind !== "edit") return
  const body = {
    model: "qwen2.5-coder:1.5b",
    temperature: 0,
    messages: [
      { role: "system", content: `You are a coding assistant. The project is at ${dir}.` },
      { role: "user", content: present(plan, ask) },
    ],
  }
  expect(JSON.stringify(body)).not.toContain('"tools"')
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const json = (await res.json()) as { choices: { message: { content: string } }[]; usage: { prompt_tokens: number } }
  const reply = json.choices[0].message.content
  console.log("prompt tokens", json.usage.prompt_tokens, "\n", reply)
  const d = derive(plan, reply, ask)
  expect(d.ok).toBe(true)
  if (!d.ok) return
  expect(commit(plan, d.after)).toEqual({ ok: true })
  expect(fs.readFileSync(file, "utf8")).toBe("def add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n")
}, 120_000)
