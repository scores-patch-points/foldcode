// Numbers a verdict may rest on. Pass rates carry a Wilson interval; a comparison is paired by task; the noise
// floor is how far the SAME arm moves between identical runs, which sets the smallest effect worth believing.
export const wilson = (k, n, z = 1.96) => {
  if (!n) return { p: NaN, lo: NaN, hi: NaN }
  const p = k / n, d = 1 + (z * z) / n
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) }
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
const sd = (a) => (a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - mean(a)) ** 2, 0) / (a.length - 1)))

// rows: {arm, rep, task, pass, ctxChars, rounds, tokens}
export const summarize = (all) => {
  const rows = all.filter((r) => !r.error) // an errored call is not a wrong answer; it is reported, not scored
  const reps = [...new Set(rows.map((r) => r.rep))]
  const perRep = reps.map((rep) => mean(rows.filter((r) => r.rep === rep).map((r) => (r.pass ? 1 : 0))))
  const k = rows.filter((r) => r.pass).length
  return {
    n: rows.length, errors: all.length - rows.length, ...wilson(k, rows.length),
    repScoreSD: sd(perRep), // the noise floor, in score units
    ctxChars: mean(rows.map((r) => r.ctxChars)), rounds: mean(rows.map((r) => r.rounds)), tokens: mean(rows.map((r) => r.tokens || 0)),
  }
}

// smallest drop in pass rate distinguishable from nothing with 80% power at alpha .05, for N paired-ish trials
export const minDetectable = (p, n) => 2.8 * Math.sqrt((2 * p * (1 - p)) / n)

// Non-inferiority, paired by task: bootstrap the per-task mean difference (cand - base). Non-inferior only if the
// lower bound of its 95% interval stays above -margin. `seed` makes the verdict reproducible.
export const nonInferior = (base, cand, { margin = 0.05, boot = 4000, seed = 7 } = {}) => {
  const by = (rows) => {
    const m = new Map()
    for (const r of rows.filter((x) => !x.error)) // an errored call is not a wrong answer: it is excluded, never paired as a tie (m.get(r.task) ?? m.set(r.task, []).get(r.task)).push(r.pass ? 1 : 0)
    return new Map([...m].map(([k, v]) => [k, mean(v)]))
  }
  const b = by(base), c = by(cand)
  const diffs = [...b.keys()].filter((k) => c.has(k)).map((k) => c.get(k) - b.get(k))
  if (!diffs.length) return { ok: false, diff: NaN, lo: NaN, hi: NaN, margin, tasks: 0, reason: "no shared tasks" }
  let s = seed >>> 0
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
  const means = Array.from({ length: boot }, () => mean(Array.from({ length: diffs.length }, () => diffs[Math.floor(rnd() * diffs.length)]))).sort((x, y) => x - y)
  const lo = means[Math.floor(0.025 * boot)], hi = means[Math.floor(0.975 * boot)]
  return { ok: lo > -margin, diff: mean(diffs), lo, hi, margin, tasks: diffs.length }
}
