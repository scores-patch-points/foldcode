import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { classify, commit, deltaOp, derive, deriveOp, named, present, readOp, resolve, applyOp } from "../src/plugin/physics.js"

const edit = (before: string, form: "file" | "pair" = "file") => ({ kind: "edit" as const, file: "a.txt", abs: "/x/a.txt", before, form })
const fence = (s: string) => "```py\n" + s + "\n```"

test("the act is derived from the bytes, not a label", () => {
  expect(deriveOp("a", "")).toBe("SEG")
  expect(deriveOp("a", "a b")).toBe("INS")
  expect(deriveOp("a", "b")).toBe("SYN")
  expect(readOp("a", "a b")).toEqual({ op: "INS", find: "a", add: " b" })
  expect(readOp("a", "z a b")).toEqual({ op: "SYN", find: "a", add: "z a b" })
})

test("whole-file reply derives a unique op that reproduces the file", () => {
  const before = "def add(a, b):\n    return a - b\n\ndef sub(a, b):\n    return a - b\n"
  const after = "def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b\n"
  const d = derive(edit(before), fence(after.replace(/\n$/, "")))
  expect(d.ok).toBe(true)
  if (d.ok) {
    expect(d.after).toBe(after)
    expect(applyOp(before, d.op)).toEqual({ ok: true, code: after })
  }
})

test("exact on many realistic edits (non-repetitive source)", () => {
  let seed = 7
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), seed % n)
  let ok = 0
  for (let i = 0; i < 1000; i++) {
    const lines = Array.from({ length: 12 }, (_, k) => `const v${k}_${i} = ${rnd(1000)} + f${k}(${k})`)
    const before = lines.join("\n") + "\n"
    const next = [...lines]
    const at = rnd(12)
    const kind = rnd(3)
    if (kind === 0) next[at] = next[at].replace(/\d+ \+/, `${rnd(9999)} +`)
    else if (kind === 1) next.splice(at, 0, `const extra${i} = ${rnd(50)}`)
    else next.splice(at, 1)
    const after = next.join("\n") + "\n"
    const d = derive(edit(before), fence(after.replace(/\n$/, "")), "remove or change a line")
    if (before === after) continue
    expect(d.ok).toBe(true)
    if (d.ok && d.after === after) ok++
  }
  expect(ok).toBeGreaterThan(990)
})

test("repetitive source: an ambiguous locus is refused, never applied wrong", () => {
  const before = Array.from({ length: 20 }, () => "    x = 1").join("\n") + "\n"
  // pair form: the lines to change occur twenty times
  const pair = derive(edit(before, "pair"), fence("    x = 1") + "\n" + fence("    x = 2"))
  expect(pair.ok).toBe(false)
  if (!pair.ok) expect(pair.gap).toMatchObject({ kind: "ambiguous", count: 20 })
  // file form: the model changed one of twenty identical lines and dropped another (two places): refused
  const lines = before.trimEnd().split("\n")
  lines[3] = "    x = 2"
  lines.splice(12, 1)
  const two = derive(edit(before), fence(lines.join("\n")))
  expect(two.ok).toBe(false)
  // file form: one changed line whose bytes also occur elsewhere: refused
  const one = before.trimEnd().split("\n")
  one[3] = "    x = 2"
  const r = derive(edit(before), fence(one.join("\n")))
  expect(r.ok).toBe(false) // one of twenty identical lines: which was meant is not pinned, so refused
})

test("repetitive source: a replacement that erases a repeated line among its twins is refused", () => {
  const before = Array.from({ length: 20 }, () => "    x = 1").join("\n") + "\n"
  const gone = before.trimEnd().split("\n")
  gone.splice(5, 1)
  const d = derive(edit(before), fence(gone.join("\n")))
  expect(d.ok).toBe(false)
  if (!d.ok) expect(d.gap.kind).toBe("ambiguous")
})

test("damage guards: unrequested loss and no-ops are refused", () => {
  const before = Array.from({ length: 30 }, (_, i) => `line number ${i} of the file`).join("\n") + "\n"
  const cut = before.split("\n").slice(0, 10).join("\n")
  const d = derive(edit(before), fence(cut), "fix the typo")
  expect(d.ok).toBe(false)
  if (!d.ok) expect(["loss", "unrelated"]).toContain(d.gap.kind)
  expect(derive(edit(before), fence(before.trimEnd()), "fix").ok).toBe(false)
  expect(derive(edit(before), "I cannot do that", "fix").ok).toBe(false)
})

test("pair form: unique anchor applies, missing anchor refuses", () => {
  const before = "alpha\nbeta\ngamma\n"
  const ok = derive(edit(before, "pair"), fence("beta") + "\nthen\n" + fence("beta\nbeta2"))
  expect(ok.ok && ok.after).toBe("alpha\nbeta\nbeta2\ngamma\n")
  const miss = derive(edit(before, "pair"), fence("delta") + "\n" + fence("x"))
  expect(miss.ok).toBe(false)
  if (!miss.ok) expect(miss.gap.kind).toBe("unlocated")
})

test("classify and name", () => {
  expect(classify("change the sum in calc.py to add")).toBe("edit")
  expect(classify("what does calc.py do")).toBe("read")
  expect(classify("run npm test")).toBe("shell")
  expect(classify("hello")).toBe("other")
  expect(named("fix the bug in src/calc.py, please")).toEqual(["src/calc.py"])
})

test("resolve: reads the named file, declines with a reason otherwise, stays inside the workspace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phys-"))
  fs.writeFileSync(path.join(dir, "calc.py"), "def add(a, b):\n    return a - b\n")
  fs.writeFileSync(path.join(os.tmpdir(), "phys-outside.txt"), "secret")
  fs.symlinkSync(path.join(os.tmpdir(), "phys-outside.txt"), path.join(dir, "link.txt"))
  const e = resolve("fix add in calc.py", dir)
  expect(e).toMatchObject({ kind: "edit", file: "calc.py", form: "file" })
  expect(resolve("what does calc.py do", dir)).toMatchObject({ kind: "read" })
  expect(resolve("fix add in nothing.py", dir)).toMatchObject({ kind: "decline" })
  expect(resolve("fix link.txt", dir)).toMatchObject({ kind: "decline" })
  expect(resolve("run the tests in calc.py", dir)).toMatchObject({ kind: "decline" })
  if (e.kind === "edit") {
    const text = present(e, "fix add in calc.py")
    expect(text).not.toMatch(/tool|EOT|<fold/i)
    const d = derive(e, fence("def add(a, b):\n    return a + b"), "fix add")
    expect(d.ok).toBe(true)
    if (d.ok) {
      expect(commit(e, d.after)).toEqual({ ok: true })
      expect(fs.readFileSync(path.join(dir, "calc.py"), "utf8")).toBe("def add(a, b):\n    return a + b\n")
      expect(commit(e, d.after)).toMatchObject({ ok: false, gap: { kind: "stale" } })
    }
  }
})

test("a small file rewritten into something else is refused", () => {
  const before = "def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n"
  const after = "class Calculator:\n    def add(self, a, b):\n        return a + b\n\n    def mul(self, a, b):\n        return a * b"
  const d = derive(edit(before), fence(after), "Fix the add function so it adds instead of subtracts.")
  expect(d.ok).toBe(false)
  if (!d.ok) expect(["rewrite", "unrelated", "restructured", "scatter", "novel"]).toContain(d.gap.kind)
})

test("an unrequested second change beside the fix is refused; a broad ask allows several", () => {
  const before = "def add(a, b):\n    return a - b\n\n\ndef mul(a, b):\n    return a * b\n"
  const after = "import operator\n\n\ndef add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b"
  const one = derive(edit(before), fence(after), "Fix the add function so it adds.")
  expect(one.ok).toBe(false)
  if (!one.ok) expect(one.gap.kind).toBe("scatter")
  expect(derive(edit(before), fence(after), "Fix every function and add an import.").ok).toBe(true)
})

test("a file name closing a sentence is still named", () => {
  expect(named("Rename hello to greet in greet.py.")).toEqual(["greet.py"])
  expect(named("Change TIMEOUT to 30 in cfg.py.")).toEqual(["cfg.py"])
  expect(named("See v1.2. Then fix calc.py")).toContain("calc.py")
})

test("falsified: overlapping repeats no longer land on the wrong position", () => {
  expect(applyOp("aaaa", { op: "SYN", find: "aaa", add: "b" })).toMatchObject({ ok: false, gap: { kind: "ambiguous", count: 2 } })
  const before = "aaaa\n"
  const d = deltaOp(before, "aaaab\n")
  expect(d && applyOp(before, readOp(d.find, d.add)!)).toMatchObject({ ok: true, code: "aaaab\n" })
})

test("falsified: an unrelated file, a script, or a bash line in place of a tiny file is refused", () => {
  const before = "TIMEOUT = 5\nRETRIES = 3\n"
  for (const reply of ["CFG = '/x'\nwith open(CFG, 'w') as f:\n    f.write('TIMEOUT = 30')", "sed -i 's/5/30/' cfg.py", "print('done')"]) {
    const d = derive(edit(before), fence(reply), "Change TIMEOUT to 30 in cfg.py.")
    expect(d.ok).toBe(false)
  }
  expect(derive(edit(before), fence("TIMEOUT = 30\nRETRIES = 3"), "Change TIMEOUT to 30 in cfg.py.").ok).toBe(true)
})

test("falsified: the change must be near what the ask names (f7 is not f77)", () => {
  const before = Array.from({ length: 120 }, (_, i) => `def f${i}(x):\n    return x + ${i}\n`).join("\n")
  const wrong = before.replace("def f7(x):\n    return x + 7\n", "def f7(x):\n    return x * 77\n")
  const right = before.replace("def f77(x):\n    return x + 77\n", "def f77(x):\n    return x * 77\n")
  const plan = { ...edit(before, "pair") }
  const pairOf = (a: string, b: string) => fence(a) + "\n" + fence(b)
  expect(derive(plan, pairOf(before, wrong), "Change f77 in big.py to return x * 77.")).toMatchObject({ ok: false, gap: { kind: "locus" } })
  expect(derive(plan, pairOf("def f77(x):\n    return x + 77", "def f77(x):\n    return x * 77"), "Change f77 in big.py to return x * 77.").ok).toBe(true)
  expect(right).not.toBe(before)
})

test("falsified: a removal that invents, a comment nobody asked for, f76 for f77", () => {
  const rm = "def a():\n    return 1\n\n\ndef b():\n    return 2\n"
  expect(derive(edit(rm), fence("def a():\n    return 1\n\n# Delete function b\ndel b"), "Delete the function b.").ok).toBe(false)
  expect(derive(edit(rm), fence("def a():\n    return 1"), "Delete the function b.").ok).toBe(true)
  const big = Array.from({ length: 120 }, (_, i) => `def f${i}(x):\n    return x + ${i}\n`).join("\n")
  const off = derive(edit(big, "pair"), fence("    return x + 76") + "\n" + fence("    return x * 77"), "Change f77 in big.py to return x * 77.")
  expect(off).toMatchObject({ ok: false, gap: { kind: "locus" } })
  const cfg = "TIMEOUT = 5\nRETRIES = 3\n"
  expect(derive(edit(cfg), fence("# raised\nTIMEOUT = 30\nRETRIES = 3"), "Change TIMEOUT to 30.").ok).toBe(false)
})

test("a rename across a tiny file is allowed", () => {
  const before = "def hello(name):\n    return 'hi ' + name\n\n\nprint(hello('x'))\n"
  const after = "def greet(name):\n    return 'hi ' + name\n\n\nprint(greet('x'))"
  expect(derive(edit(before), fence(after), "Rename the function hello to greet in greet.py.").ok).toBe(true)
})
