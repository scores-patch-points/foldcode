import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileOf, literal, markText, resolve, roots, taskKey, verify } from "../src/plugin/physics-mech.js"

let root: string
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mech-"))
  fs.mkdirSync(path.join(root, "src"))
  fs.writeFileSync(
    path.join(root, "src/a.ts"),
    [
      "export const DEFAULT_TIMEOUT_MS = 300_000",
      "export const DEFAULT_CHUNK_TIMEOUT_MS = 15 * 60_000 // chunks",
      "const MAX_BYTES = 10 * 1024 * 1024",
      "export const DYNAMIC_LIMIT = compute()",
      "export function alpha() {}",
      "export async function beta() {}",
      "export class Gamma {}",
      "export const delta = 1",
      "export type Eps = string",
      "export * as Zeta from './z.js'",
    ].join("\n"),
  )
  fs.writeFileSync(path.join(root, "src/b.ts"), "const SHELL_TIMEOUT = 120_000\n")
  fs.writeFileSync(path.join(root, "src/c.ts"), "const A_TIMEOUT = 1\nconst B_TIMEOUT = 2\nconst X_DUP = 1\nconst X_DUP = 2\n")
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

test("literal: numbers and products of numbers only", () => {
  expect(literal("300_000")).toBe("300000")
  expect(literal("15 * 60_000")).toBe("900000")
  expect(literal("10 * 1024 * 1024")).toBe("10485760")
  expect(literal("compute()")).toBeUndefined()
  expect(literal("1 + 2")).toBeUndefined()
  expect(literal("process.env.X ?? 5")).toBeUndefined()
})

test("a named constant resolves to its literal with an address", () => {
  const a = resolve("In src/a.ts, what is DEFAULT_TIMEOUT_MS? Number only.", root)
  expect(a).toMatchObject({ ok: true, text: "DEFAULT_TIMEOUT_MS = 300000", at: "src/a.ts#L1" })
  expect(resolve("What is DEFAULT_CHUNK_TIMEOUT_MS in src/a.ts?", root)).toMatchObject({ ok: true, text: "DEFAULT_CHUNK_TIMEOUT_MS = 900000", at: "src/a.ts#L2" })
  expect(resolve("What is MAX_BYTES in src/a.ts?", root)).toMatchObject({ ok: true, text: "MAX_BYTES = 10485760" })
})

test("no symbol named: the file's only matching constant answers; several or none is a gap", () => {
  expect(resolve("What is the default timeout (ms) in src/b.ts?", root)).toMatchObject({ ok: true, text: "SHELL_TIMEOUT = 120000", at: "src/b.ts#L1" })
  expect(resolve("What is the default timeout in src/c.ts?", root)).toMatchObject({ ok: false, gap: "several-candidates" })
  expect(resolve("What is the default timeout in src/a.ts?", root)).toMatchObject({ ok: false, gap: "several-candidates" })
})

test("gaps are typed and never guessed", () => {
  expect(resolve("What is DYNAMIC_LIMIT in src/a.ts?", root)).toMatchObject({ ok: false, gap: "not-a-literal" })
  expect(resolve("What is X_DUP in src/c.ts?", root)).toMatchObject({ ok: false, gap: "ambiguous" })
  expect(resolve("What is MISSING_THING in src/a.ts?", root)).toMatchObject({ ok: false, gap: "no-definition" })
  expect(resolve("What is DEFAULT_TIMEOUT_MS?", root)).toMatchObject({ ok: false, gap: "no-file" })
  expect(resolve("What is X in src/nope.ts?", root)).toMatchObject({ ok: false, gap: "unreadable" })
  expect(resolve("tell me a story about src/a.ts", root)).toMatchObject({ ok: false, gap: "not-a-lookup" })
})

test("a path outside the workspace is never read", () => {
  expect(resolve("What is X in ../../etc/hosts.conf?", root)).toMatchObject({ ok: false, gap: "outside-workspace" })
  expect(resolve("What is X in /etc/passwd.txt?", root).ok).toBe(false)
})

test("exports: the file's own export lines, filtered to what was asked", () => {
  const r = resolve("Read src/a.ts in full and list the names of its exported functions and classes.", root)
  expect(r.ok && r.text).toBe("src/a.ts — exported functions and classes, all of them:\n- alpha · L5\n- beta · L6\n- Gamma · L7")
  const all = resolve("List the exports of src/a.ts", root)
  expect(all.ok && all.text).toContain("- delta (const) · L8")
  expect(all.ok && all.text).toContain("- Zeta (namespace) · L10")
})

test("the same file is the one the conversation last named", () => {
  expect(fileOf("And DEFAULT_CHUNK_TIMEOUT_MS in the same file? Number only.", ["What is X in src/b.ts?", "What is Y in src/a.ts?"])).toBe("src/a.ts")
  expect(fileOf("And Z in the same file?", [])).toBeUndefined()
  expect(fileOf("What is Z?", ["in src/a.ts"])).toBeUndefined() // no "same file": nothing is carried over
  expect(resolve("And DEFAULT_CHUNK_TIMEOUT_MS in the same file? Number only.", root, ["What is DEFAULT_TIMEOUT_MS in src/a.ts?"])).toMatchObject({ ok: true, text: "DEFAULT_CHUNK_TIMEOUT_MS = 900000" })
})

test("a session opened in a subdirectory still resolves files named from the repository root", () => {
  fs.mkdirSync(path.join(root, ".git"))
  fs.mkdirSync(path.join(root, "pkg/deep"), { recursive: true })
  fs.writeFileSync(path.join(root, "pkg/deep/own.ts"), "const OWN_TIMEOUT = 7\n")
  const sub = path.join(root, "pkg/deep")
  expect(roots(sub)).toEqual([sub, path.join(root, "pkg"), root])
  expect(resolve("What is DEFAULT_TIMEOUT_MS in src/a.ts?", sub)).toMatchObject({ ok: true, text: "DEFAULT_TIMEOUT_MS = 300000", at: "src/a.ts#L1" })
  // the nearest directory wins when both have the path
  expect(resolve("What is the default timeout in own.ts?", sub)).toMatchObject({ ok: false }) // a bare name carries no directory: not a path
  // a path that escapes the repository root is still refused
  expect(resolve("What is X in ../../../../etc/hosts.conf?", sub)).toMatchObject({ ok: false })
})

test("no repository: only the workspace itself is searched", () => {
  const lone = fs.mkdtempSync(path.join(os.tmpdir(), "mech-lone-"))
  try {
    expect(roots(lone)).toEqual([lone])
  } finally {
    fs.rmSync(lone, { recursive: true, force: true })
  }
})

const hit = (ask: string) => {
  const r = resolve(ask, root)
  if (!r.ok) throw new Error(`expected a hit, got ${r.gap}`)
  return r
}

test("a finding carries its witness: one fact line and the sha256 of the bytes it was read from", () => {
  const r = hit("In src/a.ts, what is DEFAULT_TIMEOUT_MS?")
  expect(r.fact).toBe("DEFAULT_TIMEOUT_MS = 300000")
  expect(r.sha).toBe(require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(root, "src/a.ts"), "utf8")).digest("hex"))
  expect(markText(r)).toBe(`DEFAULT_TIMEOUT_MS = 300000 [mech-const · src/a.ts#L1 · sha256:${r.sha.slice(0, 16)}]`)
  expect(markText(r)).not.toContain("\n")
  const e = hit("List the exported functions and classes of src/a.ts")
  expect(e.fact).toBe("src/a.ts exported functions and classes: alpha, beta, Gamma")
  expect(markText(e)).not.toContain("\n")
})

test("verify: a constant's value must be stated, whatever the digit grouping", () => {
  const r = hit("In src/a.ts, what is DEFAULT_TIMEOUT_MS?")
  for (const ok of ["300000", "It is 300000.", "300,000 ms", "300_000", "300 000 milliseconds"]) expect(verify(r, ok)).toEqual({ ok: true })
  for (const bad of ["30000", "3000000", "300000.5", "I could not find it", "about three hundred thousand"]) expect(verify(r, bad)).toEqual({ ok: false, missing: ["300000"] })
})

test("verify: every exported name must be stated as a whole word", () => {
  const e = hit("List the exported functions and classes of src/a.ts")
  expect(verify(e, "alpha, beta and Gamma")).toEqual({ ok: true })
  expect(verify(e, "alpha and beta")).toEqual({ ok: false, missing: ["Gamma"] })
  expect(verify(e, "alphabet betamax GammaRay")).toEqual({ ok: false, missing: ["alpha", "beta", "Gamma"] })
})

test("taskKey mirrors the door's projectKey", async () => {
  expect(taskKey("relative/path")).toBeUndefined()
  expect(taskKey(os.homedir())).toBeUndefined() // a home directory is not a project
  expect(taskKey(root)).toMatch(/^proj-mech-[\w.-]+-[0-9a-f]{6}$/)
  const door = path.join(os.homedir(), ".khora/opencode-worknotes.mjs")
  if (!fs.existsSync(door)) return // the door's checkout is not on this machine: nothing to compare against
  const { projectKey } = (await import(door)) as { projectKey: (w: string) => string | null }
  for (const w of [root, path.join(root, "src"), path.join(root, "pkg/deep"), process.cwd(), os.tmpdir(), os.homedir()]) expect(taskKey(w) ?? null).toBe(projectKey(w))
})
