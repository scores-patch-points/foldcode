import fs from "node:fs"
import { economySVD, matmul, transpose, dmd } from "/Users/mlacy/Downloads/workspace/khora/native/kernel/dmd.js"
const sessions = JSON.parse(fs.readFileSync("reads.json", "utf8"))
const K = [1, 3, 5], W = 40, TOP = 60, MAXPTS = 40
const toks = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]{3,}/g) ?? []
// steps = one user ask; consecutive assistant messages with the same ask merge
const stepsOf = (turns) => { const out = []; for (const t of turns) { const last = out.at(-1); if (last && last.ask === t.ask) last.reads.push(...t.reads); else out.push({ ask: t.ask, reads: [...t.reads] }) } return out }

const predictors = {
  recency: (H) => [...H.paths].sort((a, b) => H.last.get(b) - H.last.get(a)),
  frequency: (H) => [...H.paths].sort((a, b) => H.count.get(b) - H.count.get(a) || H.last.get(b) - H.last.get(a)),
  trail: (H, _s, gamma = 0.7) => { const sc = new Map(); for (const p of H.paths) sc.set(p, H.reads.get(p).reduce((a, s) => a + gamma ** (H.now - s), 0)); return [...H.paths].sort((a, b) => sc.get(b) - sc.get(a)) },
  names: (H, step) => { const q = new Set(toks(step.ask)); const df = new Map(); for (const p of H.paths) for (const w of new Set(toks(p))) df.set(w, (df.get(w) ?? 0) + 1); const n = H.paths.size; const sc = new Map(); for (const p of H.paths) sc.set(p, [...new Set(toks(p))].reduce((a, w) => a + (q.has(w) ? Math.log(1 + n / df.get(w)) : 0), 0)); return [...H.paths].sort((a, b) => sc.get(b) - sc.get(a) || H.last.get(b) - H.last.get(a)) },
  dmd: (H, _s, rank = 6) => {
    const paths = predictors.trail(H, _s).slice(0, TOP) // the state space: the paths in play
    const lo = Math.max(0, H.now - W), cols = []
    for (let s = lo; s <= H.now; s++) cols.push(paths.map((p) => (H.reads.get(p).includes(s) ? 1 : 0)))
    if (cols.length < 6) return null
    const X = paths.map((_, i) => cols.slice(0, -1).map((c) => c[i])), Xp = paths.map((_, i) => cols.slice(1).map((c) => c[i]))
    const { U, s, V, rank: r } = economySVD(X, { rank: Math.min(rank, cols.length - 2) })
    if (!r) return null
    // x+ = Xp V S^-1 U^T x   (the full one-step predictor the reduced operator stands for)
    const XpV = matmul(Xp, V), x = cols.at(-1)
    const Utx = transpose(U).map((row) => row.reduce((a, u, i) => a + u * x[i], 0))
    const pred = XpV.map((row) => row.reduce((a, v, j) => a + v * Utx[j] / s[j], 0))
    const sc = new Map(paths.map((p, i) => [p, pred[i]]))
    return [...paths].sort((a, b) => sc.get(b) - sc.get(a)).concat([...H.paths].filter((p) => !sc.has(p)))
  },
}
predictors.hybrid = (H, st) => { const t = predictors.trail(H, st), n = predictors.names(H, st); const rt = new Map(t.map((p, i) => [p, 1 / (1 + i)])), rn = new Map(n.map((p, i) => [p, 1 / (1 + i)])); const q = new Set(toks(st.ask)); const hasName = n.length && [...H.paths].some((p) => toks(p).some((w) => q.has(w))); return [...H.paths].sort((a, b) => (rt.get(b) + (hasName ? rn.get(b) : 0)) - (rt.get(a) + (hasName ? rn.get(a) : 0))) }
const rand = Object.fromEntries(K.map((k) => [k, 0])); let poolSum = 0
const res = Object.fromEntries(Object.keys(predictors).map((k) => [k, Object.fromEntries(K.map((k2) => [k2, 0]))])); let targets = 0, points = 0, skipped = 0
let growthNote = []
for (const sess of sessions) {
  const steps = stepsOf(sess.turns); const H = { paths: new Set(), last: new Map(), count: new Map(), reads: new Map(), now: -1 }
  const cand = []
  steps.forEach((st, t) => { const re = [...new Set(st.reads)].filter((p) => H.paths.has(p)); if (t >= 8 && re.length && H.paths.size >= 4) cand.push({ t, re }); for (const p of new Set(st.reads)) { H.paths.add(p); H.last.set(p, t); H.count.set(p, (H.count.get(p) ?? 0) + 1); (H.reads.get(p) ?? H.reads.set(p, []).get(p)).push(t) } })
  // replay with the predictors, at a sample of the candidate steps
  const pick = cand.length > MAXPTS ? cand.filter((_, i) => i % Math.ceil(cand.length / MAXPTS) === 0) : cand
  const want = new Set(pick.map((c) => c.t))
  const G = { paths: new Set(), last: new Map(), count: new Map(), reads: new Map(), now: -1 }
  steps.forEach((st, t) => {
    if (want.has(t)) {
      G.now = t - 1; const re = [...new Set(st.reads)].filter((p) => G.paths.has(p)); const ranked = {}
      let ok = true
      for (const [name, fn] of Object.entries(predictors)) { try { ranked[name] = fn(G, st) } catch { ranked[name] = null } if (!ranked[name]) ok = false }
      if (!ok) skipped++
      else { points++; targets += re.length; poolSum += G.paths.size; for (const k of K) rand[k] += re.length * Math.min(1, k / G.paths.size); for (const [name, list] of Object.entries(ranked)) for (const k of K) res[name][k] += re.filter((p) => list.slice(0, k).includes(p)).length }
    }
    for (const p of new Set(st.reads)) { G.paths.add(p); G.last.set(p, t); G.count.set(p, (G.count.get(p) ?? 0) + 1); (G.reads.get(p) ?? G.reads.set(p, []).get(p)).push(t) }
  })
}
console.log(`sessions ${sessions.length}  eval points ${points} (skipped ${skipped})  re-read targets ${targets}`)
console.log("hit@k = share of re-read files that the predictor had in its top k (random baseline depends on the pool size)")
console.log("random".padEnd(10), K.map((k) => `@${k} ${(100 * rand[k] / targets).toFixed(1)}%`).join("  "), `  (mean pool ${(poolSum / points).toFixed(1)} files)`)
for (const [name, r] of Object.entries(res)) console.log(name.padEnd(10), K.map((k) => `@${k} ${(100 * r[k] / targets).toFixed(1)}%`).join("  "))
