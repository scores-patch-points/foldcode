#!/usr/bin/env node
// usage: node run.mjs --adapter mock|opencode --model provider/model --arms identity,truncate6 --n 3 --seeds 1,2
// Prints, per arm: pass rate with Wilson interval, the between-run SD (noise floor), context size, and — against
// the first arm — the size ratio and the paired non-inferiority verdict. Rows are written to runs/<ts>.jsonl.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { makeTasks } from "./tasks.mjs"
import { identity, truncate, pointerDemo, handles, sealedArm, mechanicalSelector, modelSelector, resonantSelector, trailArm } from "./arms.mjs"
import { gate } from "./gary-gate.mjs"
import { ask, mock, opencode, mechanicalStack, ollama } from "./adapters.mjs"
import { summarize, nonInferior, minDetectable } from "./stats.mjs"

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const ARMS = { identity, truncate6: truncate(6), truncate3: truncate(3), pointerDemo6: pointerDemo(6), handles6: handles(6), handles3: handles(3), trail5: trailArm({ keep: 5, enabled: true }), trail3: trailArm({ keep: 3, enabled: true }) }
export async function evaluate({ adapter, arms, n, seeds, profile = "frontier", widen = [] }) {
  const tasks = seeds.flatMap((s) => makeTasks({ seed: s }))
  const rows = []
  for (const arm of arms)
    for (let rep = 1; rep <= n; rep++)
      for (const task of tasks) {
        // Gary first: an arm whose own text breaks a rule he keeps is not scored, it is reported
        const built = await arm.build(task)
        const verdict = gate({ authored: built.authored, context: built.context, probe: task.probe, profile, widen })
        const out = verdict.pass ? await ask({ adapter, arm, task, built }) : { answer: "", error: `gary: ${verdict.gating.map((f) => f.rule).join(",")}`, ctxChars: built.context.length, rounds: 0, tokens: 0, snips: 0, fabricated: 0, leaked: 0 }
        const g = out.error ? { pass: false, detail: "error" } : task.grade(out.answer)
        rows.push({ arm: arm.name, rep, task: task.id, kind: task.kind, depth: task.depth, pass: g.pass, detail: g.detail, error: out.error, answer: out.answer.slice(0, 200), ctxChars: out.ctxChars, rounds: out.rounds, tokens: out.tokens, snips: out.snips, fabricated: out.fabricated, leaked: out.leaked, sealed: out.meta, gary: verdict.findings.map((f) => `${f.severity}:${f.rule}`), garyPass: verdict.pass })
      }
  return rows
}
const sealedLine = (rs) => {
  const m = rs.map((x) => x.sealed).filter((x) => x?.sealed)
  if (!m.length) return ""
  const need = m.reduce((a, x) => a + x.needOld, 0), got = m.reduce((a, x) => a + x.gotOld, 0)
  return `selectorRecall ${need ? (100 * got / need).toFixed(0) : "-"}% (${got}/${need}) unsealed ${m.filter((x) => x.unsealed).length}/${m.length} picked/call ${(m.reduce((a, x) => a + x.picked, 0) / m.length).toFixed(1)}  `
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const which = arg("adapter", "mock")
  const adapter = which === "mock" ? mock : which === "mechanical" ? mechanicalStack : which === "ollama" ? ollama(arg("model", "gemma2:2b"), { numCtx: Number(arg("ctx", 8192)) }) : which === "ollama" ? ollama(arg("model", "gemma2:2b"), { numCtx: Number(arg("ctx", 8192)) }) : opencode(arg("model", "opencode-go/deepseek-v4.1-flash"))
  const makeSealed = () => {
    const sel = arg("selector", "mech")
    const selector = sel === "mech" ? mechanicalSelector() : sel === "resonant" ? resonantSelector() : modelSelector(ollama(sel.replace(/^ollama:/, ""), { numCtx: 2048, numPredict: 24 }), { maxCalls: Number(arg("max-local-calls", 200)), pauseMs: Number(arg("local-pause-ms", 250)) })
    return sealedArm({ selector, enabled: arg("sealed", process.env.FOLD_SEALED === "1" ? "on" : "off") === "on" })
  }
  const arms = arg("arms", "identity,truncate6").split(",").map((a) => (a === "sealed" ? makeSealed() : ARMS[a]) ?? (() => { throw new Error(`unknown arm ${a}`) })())
  const rows = await evaluate({ adapter, arms, n: Number(arg("n", 3)), seeds: arg("seeds", "1,2").split(",").map(Number), profile: arg("profile", "frontier"), widen: arg("widen", "").split(",").filter(Boolean) })
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "runs"); fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}-${adapter.name.replace(/\W+/g, "_")}.jsonl`)
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
  const base = rows.filter((r) => r.arm === arms[0].name), bs = summarize(base)
  console.log(`adapter ${adapter.name}  trials/arm ${base.length}  rows ${file}`)
  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm.name), s = summarize(rs)
    const ni = arm === arms[0] ? "" : nonInferior(base, rs)
    console.log(`${arm.name.padEnd(14)} pass ${(100 * s.p).toFixed(1)}% [${(100 * s.lo).toFixed(0)}-${(100 * s.hi).toFixed(0)}]  runSD ${(100 * s.repScoreSD).toFixed(1)}pt  ctx ${(s.ctxChars / 1024).toFixed(0)}KB (${(100 * s.ctxChars / bs.ctxChars).toFixed(0)}%)  rounds ${s.rounds.toFixed(2)}  errors ${s.errors}/${rs.length}  ${sealedLine(rs)}garyBlocked ${rs.filter((x) => x.garyPass === false).length}  snips ${rs.reduce((a, x) => a + (x.snips ?? 0), 0)} fabricated ${rs.reduce((a, x) => a + (x.fabricated ?? 0), 0)} leaked ${rs.reduce((a, x) => a + (x.leaked ?? 0), 0)}` + (ni ? `  vs ${arms[0].name}: Δ${(100 * ni.diff).toFixed(1)}pt CI[${(100 * ni.lo).toFixed(1)},${(100 * ni.hi).toFixed(1)}] ${ni.ok ? "NON-INFERIOR" : "NOT non-inferior"} (margin ${100 * ni.margin}pt)` : ""))
  }
  console.log(`noise floor: min detectable drop ≈ ${(100 * minDetectable(bs.p, bs.n)).toFixed(1)}pt at ${bs.n} trials (80% power)`)
}
