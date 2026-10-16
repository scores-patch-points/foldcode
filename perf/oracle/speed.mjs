#!/usr/bin/env node
// speed.mjs — the falsifier for "the fold is faster than normal opencode with frontier models".
//
// The claim under test, stated so it can fail:
//   For a real frontier model, an arm that shows LESS context than `identity` (what native opencode
//   would send) reaches the same answer (non-inferior) using FEWER model tokens and LESS wall-clock.
//
// `identity` is the full transcript; `handles`/`sealed` are what the fold shows instead. The model is
// the real `opencode run` path (OPENCODE_BIN picks native vs the fold fork; OPENCODE_STANDALONE=1
// avoids the managed service). FOLD_OFF=1 isolates the CONTEXT variable from the doorway's own cost.
//
// Verdicts, each a way to falsify:
//   FALSIFIED(tokens)  a reduced arm did not lower model tokens
//   FALSIFIED(speed)   wall-clock did not drop (95% CI of the paired ratio includes 1.0)
//   FALSIFIED(quality) answers got worse (non-inferiority at the declared margin fails)
//   UNDECIDED          the effect is inside the noise floor at this n
//
// usage: OPENCODE_STANDALONE=1 FOLD_OFF=1 node speed.mjs --model <provider/model> [--arms identity,handles6] [--seeds 1] [--n 1] [--min-depth 0] [--kinds needle,prose] [--max-rounds 2]
import { makeTasks } from "./tasks.mjs"
import { identity, handles, truncate, pointerDemo } from "./arms.mjs"
import { gate } from "./gary-gate.mjs"
import { ask, opencode, mock } from "./adapters.mjs"
import { wilson, nonInferior, minDetectable } from "./stats.mjs"

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const ARMS = { identity, handles6: handles(6), handles3: handles(3), pointerDemo6: pointerDemo(6), truncate6: truncate(6) }
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

// Paired bootstrap of the median ratio cand/base over the shared tasks (seed fixed → reproducible).
function ratioCI(base, cand, { boot = 4000, seed = 11 } = {}) {
  const byId = (rows) => { const m = new Map(); for (const r of rows) (m.get(r.task) ?? m.set(r.task, []).get(r.task)).push(r); return m }
  const b = byId(base), c = byId(cand)
  const ratios = []
  for (const [id, rs] of b) { const cr = c.get(id); if (!cr) continue; const bm = median(rs.map((r) => r.metric)), cm = median(cr.map((r) => r.metric)); if (bm > 0) ratios.push(cm / bm) }
  if (!ratios.length) return { ok: false, reason: "no shared tasks" }
  let s = seed >>> 0
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const meds = Array.from({ length: boot }, () => median(Array.from({ length: ratios.length }, () => ratios[Math.floor(rnd() * ratios.length)]))).sort((x, y) => x - y)
  const obs = median(ratios)
  return { ok: true, obs, lo: meds[Math.floor(0.025 * boot)], hi: meds[Math.floor(0.975 * boot)], faster: meds[Math.floor(0.975 * boot)] < 1 }
}

async function main() {
  const model = arg("model", "opencode-go/deepseek-v4.1-flash")
  const armNames = arg("arms", "identity,handles6").split(",")
  const seeds = arg("seeds", "1").split(",").map(Number)
  const n = Number(arg("n", 1))
  const minDepth = Number(arg("min-depth", 0))
  const kinds = arg("kinds", "").split(",").filter(Boolean)
  const maxRounds = Number(arg("max-rounds", 2))
  const profile = arg("profile", "frontier")

  const adapter = arg("adapter", "opencode") === "mock" ? mock : opencode(model)
  const tasks = seeds.flatMap((s) => makeTasks({ seed: s }))
    .filter((t) => t.depth >= minDepth && (!kinds.length || kinds.includes(t.kind)))

  console.log(`adapter ${adapter.name}  bin ${process.env.OPENCODE_BIN ?? "opencode"}  standalone ${process.env.OPENCODE_STANDALONE === "1"}  FOLD_OFF ${process.env.FOLD_OFF ?? "0"}`)
  console.log(`model=${model}  tasks=${tasks.length} (${tasks.map((t) => `${t.kind}@${t.depth}`).join(", ")})  arms=${armNames.join(",")}  n=${n}\n`)

  const rows = []
  for (const name of armNames) {
    const arm = ARMS[name]
    if (!arm) { console.error(`unknown arm ${name}`); process.exit(2) }
    for (let rep = 1; rep <= n; rep++) {
      for (const task of tasks) {
        const built = await arm.build(task)
        const verdict = gate({ authored: built.authored, context: built.context, probe: task.probe, profile })
        const out = verdict.pass ? await ask({ adapter, arm, task, built, maxRounds }) : { error: `gary:${verdict.gating.map((f) => f.rule).join(",")}`, ctxChars: built.context.length, tokens: 0, ms: 0, rounds: 0 }
        const pass = out.error ? false : task.grade(out.answer).pass
        rows.push({ arm: name, rep, task: task.id, kind: task.kind, depth: task.depth, pass, error: out.error, tokens: out.tokens ?? 0, ms: out.ms ?? 0, ctxChars: out.ctxChars, rounds: out.rounds })
        process.stderr.write(`  ${name} ${task.id.padEnd(16)} pass=${pass ? "Y" : "n"} tok=${String(out.tokens ?? 0).padStart(6)} ms=${String(out.ms ?? 0).padStart(6)} ${out.error ?? ""}\n`)
      }
    }
  }

  const base = rows.filter((r) => r.arm === armNames[0] && !r.error)
  const bs = { n: base.length, ...wilson(base.filter((r) => r.pass).length, base.length), tokens: mean(base.map((r) => r.tokens)), ms: mean(base.map((r) => r.ms)), ctx: mean(base.map((r) => r.ctxChars)) }
  console.log(`\n${armNames[0].padEnd(14)} pass ${(100 * bs.p).toFixed(1)}% [${(100 * bs.lo).toFixed(0)}-${(100 * bs.hi).toFixed(0)}]  tok ${bs.tokens.toFixed(0)}  ms ${bs.ms.toFixed(0)}  ctx ${(bs.ctx / 1024).toFixed(0)}KB`)

  for (const name of armNames.slice(1)) {
    const rs = rows.filter((r) => r.arm === name && !r.error)
    if (!rs.length) { console.log(`${name.padEnd(14)} (no scored trials)`); continue }
    const s = { n: rs.length, ...wilson(rs.filter((r) => r.pass).length, rs.length), tokens: mean(rs.map((r) => r.tokens)), ms: mean(rs.map((r) => r.ms)), ctx: mean(rs.map((r) => r.ctxChars)) }
    const tr = ratioCI(base.map((r) => ({ ...r, metric: r.tokens })), rs.map((r) => ({ ...r, metric: r.tokens })))
    const sr = ratioCI(base.map((r) => ({ ...r, metric: r.ms })), rs.map((r) => ({ ...r, metric: r.ms })))
    const q = nonInferior(base, rs, { margin: 0.05 })
    const ctxRatio = bs.ctx > 0 ? s.ctx / bs.ctx : NaN // deterministic: bytes sent. A token win is impossible without this.
    const verdicts = []
    if (tr.ok) { if (tr.obs >= 1) verdicts.push("FALSIFIED(tokens: not lower)") }
    else verdicts.push("UNDECIDED(tokens: provider reported none — bytes-sent shown instead)")
    if (ctxRatio >= 1) verdicts.push("FALSIFIED(bytes: not smaller)")
    if (sr.ok && !sr.faster) verdicts.push(`FALSIFIED(speed: ratio ${sr.obs.toFixed(2)} CI[${sr.lo.toFixed(2)},${sr.hi.toFixed(2)}] includes 1.0)`)
    if (q.ok !== true || q.diff < -0.05) verdicts.push(`FALSIFIED(quality: Δ${(100 * q.diff).toFixed(1)}pt)`)
    const clean = tr.ok && tr.obs < 1 && ctxRatio < 1 && sr.ok && sr.faster && q.ok === true
    const pct = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : "-")
    console.log(`${name.padEnd(14)} pass ${(100 * s.p).toFixed(1)}% [${(100 * s.lo).toFixed(0)}-${(100 * s.hi).toFixed(0)}]  tok ${s.tokens.toFixed(0)} (${pct(bs.tokens ? s.tokens / bs.tokens : NaN)})  ms ${s.ms.toFixed(0)} (${pct(bs.ms ? s.ms / bs.ms : NaN)})  ctx ${(s.ctx / 1024).toFixed(0)}KB (${pct(ctxRatio)})  ${clean ? "MATCH (fewer tokens, faster, non-inferior)" : verdicts.join("  ")}`)
  }
  console.log(`\nnoise floor: a ${(100 * minDetectable(bs.p, bs.n)).toFixed(0)}pt pass difference is detectable at ${bs.n} trials (80% power)`)
}

main()
