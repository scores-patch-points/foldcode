// Gary as a gate on every arm. Gary (khora/native/organs/gary.js) keeps the rules about what a prompt may carry; here he
// reads only what WE author (the instruction and the arm's pointer stubs and notes) — the dialogue and tool output are the
// user's own words and the world's bytes, which he is not asked to edit. The window is read over the whole prompt.
// Profiles: `small` is Gary as designed (any finding gates). `frontier` gates on strike/refuse only, and a rule is
// widened beyond that ONLY by naming it in `widen`, which the caller must back with an ablation (see WIDENING.md).
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { INSTRUCTION } from "./adapters.mjs"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ORGANS = process.env.FOLD_KHORA_ORGANS ?? path.resolve(HERE, "../../../khora/native/organs")
const load = (f) => import(pathToFileURL(path.join(ORGANS, f)).href)
const [{ makeGary, SEVERITY }, fw] = await Promise.all([load("gary.js"), load("firewall.js")])

export const PROFILES = {
  small: { window: 8192, gates: [SEVERITY.STRIKE, SEVERITY.REFUSE, SEVERITY.FLAG] },
  frontier: { window: 200_000, gates: [SEVERITY.STRIKE, SEVERITY.REFUSE] },
}
const gary = (window) => makeGary({ strikeAddresses: fw.strikeAddresses, apparatusMentions: fw.apparatusMentions, windowOf: () => window })
const tokens = (t) => Math.ceil(String(t).length / 4)

export function gate({ authored = "", context = "", probe = "", profile = "frontier", widen = [] } = {}) {
  const p = PROFILES[profile] ?? PROFILES.frontier
  const g = gary(p.window)
  const sys = [INSTRUCTION, authored].filter(Boolean).join("\n")
  const mine = g.check([{ role: "system", content: sys }, { role: "user", content: probe }], { model: "oracle", options: { num_ctx: p.window }, material: 1 })
  const findings = mine.findings.filter((f) => f.rule !== "fits-the-window")
  const norm = (s) => s.replace(/\s+/g, " ").trim() // the strike also tidies whitespace; only a removed address counts
  const addressStruck = norm(fw.strikeAddresses(sys)) !== norm(sys) // an address in our own text would be struck at the door
  if (addressStruck) findings.push({ rule: "no-address", severity: SEVERITY.STRIKE, detail: "authored text carries an address" })
  const total = tokens(sys) + tokens(context) + tokens(probe)
  if (total > p.window) findings.push({ rule: "fits-the-window", severity: SEVERITY.FLAG, detail: `${total} tokens over a ${p.window} window` })
  const gating = findings.filter((f) => p.gates.includes(f.severity) && !widen.includes(f.rule))
  return { pass: gating.length === 0, findings, gating, tokens: total, profile, widen }
}
