#!/usr/bin/env node
// fold-live-check.mjs [--from N] [usage.jsonl] — did the fold stop compacting and hold its tool set? Reads the usage tap's wire log only.
// Exit 0 iff there are no compaction rows after N. Tool-size drift is reported as a WARNING only: the usage log has no turn id, so a
// session that asks different questions (a mechanical turn sends 2 tools, a normal turn ~16k chars) legitimately changes tool size between
// asks. Read the warning against one single-ask session; the bug it looks for is the set changing between step 1 and step 2 of ONE ask.
import fs from "node:fs"
import os from "node:os"
const a = process.argv.slice(2), fi = a.indexOf("--from"), from = fi >= 0 ? Number(a.splice(fi, 2)[1]) : 0
const file = a[0] ?? os.homedir() + "/.local/share/foldcode/usage.jsonl"
const rows = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(from).map((l) => JSON.parse(l))
const comp = rows.filter((r) => r.kind === "compaction")
const by = new Map()
for (const r of rows) if (r.kind === "primary" && r.window) (by.get(r.sid) ?? by.set(r.sid, []).get(r.sid)).push(r)
let multi = 0, drift = 0, cw1 = [], cw2 = []
for (const rs of by.values()) {
  if (rs.length < 3) continue
  multi++
  if (rs.some((r) => r.window.tools !== rs[1].window.tools && r !== rs[0])) drift++   // step 1 may differ (gate decided there); 2.. must agree
  if (rs[1].usage) cw2.push(rs[1].usage.cacheWrite)
}
const tot = rows.reduce((n, r) => n + (r.usage?.prompt ?? 0), 0), out = rows.reduce((n, r) => n + (r.usage?.output ?? 0), 0)
console.log(`rows ${rows.length} (from line ${from})  prompt ${(tot / 1e6).toFixed(2)}M  output ${(out / 1e6).toFixed(2)}M`)
console.log(`compaction rows: ${comp.length}  ${comp.length ? "FAIL" : "ok"}`)
console.log(`multi-step sessions: ${multi}  with a tool-size change after step 2: ${drift}  ${drift ? "WARN (expected if a session mixes asks; see header)" : "ok"}`)
if (cw2.length) console.log(`avg step-2 cache write: ${Math.round(cw2.reduce((a, b) => a + b, 0) / cw2.length)} tokens (before the fix: 3249 same-tools, 9796 changed)`)
process.exit(comp.length ? 1 : 0)
