import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { accept, derive, taught, teach } from "../src/plugin/physics.js"
import * as Learn from "../src/plugin/physics-learn.js"
import * as Void from "../src/plugin/physics-void.js"

const edit = (file: string, before: string) => ({ kind: "edit" as const, file, abs: `/x/${file}`, before, form: "file" as const })
const fence = (s: string) => "```\n" + s + "\n```"

test("the void an ask names is derived from the ask", () => {
  expect(Void.derive("Change TIMEOUT to 30 in cfg.py.")).toMatchObject([{ kind: "set", name: "TIMEOUT", value: "30" }])
  expect(Void.derive("Rename the function hello to greet.")).toMatchObject([{ kind: "renamed", from: "hello", to: "greet" }])
  expect(Void.derive("Delete the function b from r.py.")).toMatchObject([{ kind: "gone", name: "b" }])
  expect(Void.derive("Add a function two to m.py that returns 2.")).toMatchObject([{ kind: "defined", name: "two" }])
  expect(Void.derive("make it cleaner")).toEqual([])
  // falsified live: "the add function in calc.py" is not a request to add a function named "in"
  expect(Void.derive("Fix the add function in calc.py so it adds instead of subtracts.")).toEqual([])
})

test("an answer that leaves the void open is refused, one that fills it passes", () => {
  const before = "TIMEOUT = 5\nRETRIES = 3\n"
  const wrong = derive(edit("cfg.py", before), fence("TIMEOUT = 50\nRETRIES = 3"), "Change TIMEOUT to 30 in cfg.py.")
  expect(wrong.ok).toBe(false)
  const right = derive(edit("cfg.py", before), fence("TIMEOUT = 30\nRETRIES = 3"), "Change TIMEOUT to 30 in cfg.py.")
  expect(right).toMatchObject({ ok: true, checked: 1 })
  const hello = "def hello(name):\n    return name\n\n\nprint(hello('x'))\n"
  const half = derive(edit("g.py", hello), fence("def greet(name):\n    return name\n\n\nprint(hello('x'))"), "Rename hello to greet.")
  expect(half).toMatchObject({ ok: false, gap: { kind: "void" } })
})

test("teaching: an edit made elsewhere becomes a recipe the machine then applies alone", () => {
  const before = "TIMEOUT = 5\nRETRIES = 3\nNAME = 'svc'\n"
  const after = "TIMEOUT = 30\nRETRIES = 3\nNAME = 'svc'\n"
  const recipe = teach(edit("cfg.py", before), "Change TIMEOUT to 30 in cfg.py.", after, "frontier")!
  expect(recipe).toMatchObject({ kind: "line", skeleton: "Change {0} to {1} in {file}" })
  // a different file, name and value
  const other = "PORT = 80\nHOST = 'x'\nDEBUG = 0\n"
  const got = taught(edit("srv.py", other), "Change PORT to 8080 in srv.py.", [recipe])
  expect(got?.derived).toMatchObject({ ok: true, after: "PORT = 8080\nHOST = 'x'\nDEBUG = 0\n" })
  // a recipe whose result does not fill the new ask's void is not used
  expect(taught(edit("srv.py", other), "Change MISSING to 1 in srv.py.", [recipe])).toBeUndefined()
  // and one that matches no line exactly once is not used
  expect(taught(edit("srv.py", "PORT = 1\nPORT = 2\n"), "Change PORT to 9 in srv.py.", [recipe])).toBeUndefined()
})

test("falsified live: 80 -> 8080 does not bake the shared leading 8 into the recipe", () => {
  const r = teach(edit("srv.py", "PORT = 80\nHOST = 'x'\n"), "Change PORT to 8080 in srv.py.", "PORT = 8080\nHOST = 'x'\n", "local")!
  expect(r.prefix).toBe("{0} = ")
  const got = taught(edit("web.py", "PORT = 1\nHOST = 'y'\n"), "Change PORT to 9 in web.py.", [r])
  expect(got?.derived).toMatchObject({ ok: true, after: "PORT = 9\nHOST = 'y'\n" })
})

test("teaching: an ask with nothing to test teaches nothing the machine will trust", () => {
  const before = "a = 1\nb = 2\nc = 3\n"
  const r = teach(edit("t.py", before), "Make b bigger.", "a = 1\nb = 20\nc = 3\n", "frontier")
  if (r) expect(taught(edit("t.py", before), "Make b bigger.", [r])).toBeUndefined()
})

test("recipes persist and count wins", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "rec-")), "r.jsonl")
  const r = teach(edit("cfg.py", "TIMEOUT = 5\nX = 1\n"), "Change TIMEOUT to 30 in cfg.py.", "TIMEOUT = 30\nX = 1\n", "frontier")!
  expect(Learn.keep(file, r)).toBe(true)
  expect(Learn.keep(file, r)).toBe(false)
  expect(Learn.load(file)).toHaveLength(1)
  expect(Learn.load(file)[0].wins).toBe(1)
  expect(accept(edit("cfg.py", "TIMEOUT = 5\nX = 1\n"), "TIMEOUT = 30\nX = 1\n", "Change TIMEOUT to 30 in cfg.py.", true).ok).toBe(true)
})
