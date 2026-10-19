// Replays the replies the falsification run recorded as WRONG writes through the current guards, offline.
// bun test/fold-physics-replay.ts <wrong.txt>...   (each case must now be refused)
import fs from "node:fs"
import { derive } from "../src/plugin/physics.js"

const rep = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i)).join("\n")
const cases: Record<string, { file: string; src: string; ask: string }> = {
  "sub-to-add": { file: "calc.py", src: "def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n", ask: "Fix the add function in calc.py so it adds instead of subtracts." },
  rename: { file: "greet.py", src: "def hello(name):\n    return 'hi ' + name\n\n\nprint(hello('x'))\n", ask: "Rename the function hello to greet in greet.py." },
  "add-fn": { file: "m.py", src: "def one():\n    return 1\n", ask: "Add a function two to m.py that returns 2." },
  const: { file: "cfg.py", src: "TIMEOUT = 5\nRETRIES = 3\nNAME = 'svc'\n", ask: "Change TIMEOUT to 30 in cfg.py." },
  remove: { file: "r.py", src: "def a():\n    return 1\n\n\ndef b():\n    return 2\n", ask: "Delete the function b from r.py." },
  "repetitive-dups": { file: "tbl.py", src: "rows = [\n" + rep(20, () => "    (0, 0),") + "\n]\n", ask: "Change the fifth row in tbl.py to (1, 1)." },
  "bug-off-by-one": { file: "rng.py", src: "def last(xs):\n    return xs[len(xs)]\n", ask: "Fix the bug in last in rng.py." },
  "bigger-pair": { file: "big.py", src: rep(120, (i) => `def f${i}(x):\n    return x + ${i}\n`), ask: "Change f77 in big.py to return x * 77." },
  "readme-nonce": { file: "notes.txt", src: "alpha\nbeta\ngamma\ndelta\n", ask: "Replace beta with BETA in notes.txt." },
}

let applied = 0
let total = 0
for (const f of process.argv.slice(2)) {
  for (const block of fs.readFileSync(f, "utf8").split("\n=========\n")) {
    const name = block.split("\n")[0].replace(/#\d+$/, "")
    const t = cases[name]
    if (!t || !block.includes("--- reply\n")) continue
    const reply = block.split("--- reply\n")[1].split("\n--- file\n")[0]
    for (const form of ["file", "pair"] as const) {
      const plan = { kind: "edit" as const, file: t.file, abs: `/x/${t.file}`, before: t.src, form }
      if (form === "pair" && name !== "bigger-pair") continue
      if (form === "file" && name === "bigger-pair") continue
      total++
      const d = derive(plan, reply, t.ask)
      if (d.ok) {
        applied++
        console.log(`STILL APPLIED ${block.split("\n")[0]}`)
      }
    }
  }
}
console.log(`replayed ${total} recorded wrong writes; still applied ${applied}`)
