// Falsification harness: many asks x many samples against the live model. A "wrong apply" (the machine wrote a file that
// fails the task's check) is the falsifier; refusals are acceptable, silent wrong writes are not.
// bun test/fold-physics-falsify.ts [samples] [temperature]
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { commit, derive, present, resolve } from "../src/plugin/physics.js"

const url = process.env.FOLD_LIVE_URL ?? "http://127.0.0.1:11435/v1/chat/completions"
const N = Number(process.argv[2] ?? 6)
const temperature = Number(process.argv[3] ?? 0.8)
type Task = { name: string; file: string; src: string; ask: string; check: string; expect: (after: string) => boolean }
const rep = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n")
const tasks: Task[] = [
  { name: "sub-to-add", file: "calc.py", src: "def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n", ask: "Fix the add function in calc.py so it adds instead of subtracts.", check: "import calc; assert calc.add(2,3)==5 and calc.mul(2,3)==6", expect: (a) => a.includes("def mul") },
  { name: "rename", file: "greet.py", src: "def hello(name):\n    return 'hi ' + name\n\n\nprint(hello('x'))\n", ask: "Rename the function hello to greet in greet.py.", check: "import greet; assert greet.greet('a')=='hi a'", expect: (a) => !/\bhello\b/.test(a) },
  { name: "add-fn", file: "m.py", src: "def one():\n    return 1\n", ask: "Add a function two to m.py that returns 2.", check: "import m; assert m.one()==1 and m.two()==2", expect: () => true },
  { name: "const", file: "cfg.py", src: "TIMEOUT = 5\nRETRIES = 3\nNAME = 'svc'\n", ask: "Change TIMEOUT to 30 in cfg.py.", check: "import cfg; assert cfg.TIMEOUT==30 and cfg.RETRIES==3 and cfg.NAME=='svc'", expect: () => true },
  { name: "remove", file: "r.py", src: "def a():\n    return 1\n\n\ndef b():\n    return 2\n", ask: "Delete the function b from r.py.", check: "import r; assert r.a()==1 and not hasattr(r,'b')", expect: () => true },
  { name: "repetitive", file: "rep.py", src: rep(24, () => "    total += 1") .replace(/^/, "def f():\n    total = 0\n") + "\n    return total\n", ask: "In rep.py, make the first increment add 10 instead of 1.", check: "import rep; assert rep.f()==33", expect: () => true },
  { name: "repetitive-dups", file: "tbl.py", src: "rows = [\n" + rep(20, () => "    (0, 0),") + "\n]\n", ask: "Change the fifth row in tbl.py to (1, 1).", check: "import tbl; assert tbl.rows[4]==(1,1) and tbl.rows.count((0,0))==19 and len(tbl.rows)==20", expect: () => true },
  { name: "bug-off-by-one", file: "rng.py", src: "def last(xs):\n    return xs[len(xs)]\n", ask: "Fix the bug in last in rng.py.", check: "import rng; assert rng.last([1,2,3])==3", expect: () => true },
  { name: "bigger-pair", file: "big.py", src: rep(120, (i) => `def f${i}(x):\n    return x + ${i}\n`), ask: "Change f77 in big.py to return x * 77.", check: "import big; assert big.f77(2)==154 and big.f76(2)==78 and big.f78(2)==80", expect: () => true },
  { name: "readme-nonce", file: "notes.txt", src: "alpha\nbeta\ngamma\ndelta\n", ask: "Replace beta with BETA in notes.txt.", check: "assert open('notes.txt').read()=='alpha\\nBETA\\ngamma\\ndelta\\n'", expect: () => true },
]

const tally: Record<string, Record<string, number>> = {}
const wrong: string[] = []
const why: string[] = []
for (const t of tasks) {
  tally[t.name] = { ok: 0, refused: 0, WRONG: 0 }
  for (let i = 0; i < N; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fal-"))
    fs.writeFileSync(path.join(dir, t.file), t.src)
    const plan = resolve(t.ask, dir)
    if (plan.kind !== "edit") { tally[t.name].refused++; why.push(`${t.name}: resolve ${JSON.stringify(plan)}`); continue }
    let res: Response | undefined
    for (let k = 0; k < 3 && !res; k++) res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "qwen2.5-coder:1.5b", temperature, messages: [{ role: "system", content: `You are a coding assistant. The project is at ${dir}.` }, { role: "user", content: present(plan, t.ask) }] }) }).catch(() => undefined)
    if (!res) { tally[t.name].refused++; continue }
    const reply = ((await res.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content
    const d = derive(plan, reply, t.ask)
    if (!d.ok) { tally[t.name].refused++; why.push(`${t.name}: ${d.gap.kind} ${d.gap.reason}`); continue }
    commit(plan, d.after)
    const r = spawnSync("python3", ["-c", t.check], { cwd: dir })
    const good = r.status === 0 && t.expect(d.after)
    if (good) tally[t.name].ok++
    else { tally[t.name].WRONG++; wrong.push(`${t.name}#${i}\n--- reply\n${reply}\n--- file\n${d.after}`) }
  }
  console.log(t.name.padEnd(16), JSON.stringify(tally[t.name]))
}
const sum = (k: string) => Object.values(tally).reduce((n, v) => n + v[k], 0)
console.log([...new Set(why)].join("\n"))
console.log(`TOTAL ok ${sum("ok")} refused ${sum("refused")} WRONG ${sum("WRONG")}`)
fs.writeFileSync(process.env.FALSIFY_OUT ?? "/tmp/falsify-wrong.txt", wrong.join("\n=========\n"))
