import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

let root = ""
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-link-command-"))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const cli = async (args: string[]) => {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../src/index.ts"), ...args], {
    env: isolatedEnv(root),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { output: stdout + stderr, exitCode }
}

test("link without a terminal says the link has no password and enables nothing", async () => {
  const link = await cli(["link"])

  expect(link.exitCode).toBe(1)
  expect(link.output).toContain("This will expose your OpenCode server to the internet.")
  expect(link.output).toContain("with no password")
  expect(link.output).toContain("opencode link --off")
  expect(link.output).toContain("Run interactively or pass --yes to continue.")
  expect(await Array.fromAsync(new Bun.Glob("**/service*.json").scan({ cwd: root, dot: true }))).toEqual([])
}, 180_000)

test("help documents the link and its flags", async () => {
  const help = await cli(["link", "--help"])

  expect(help.exitCode).toBe(0)
  expect(help.output).toContain("--off")
  expect(help.output).toContain("--plain")
  expect(help.output).toContain("--yes")
}, 180_000)

test("turning the link off when it was never on changes nothing", async () => {
  const off = await cli(["link", "--off"])

  expect(off.exitCode).toBe(0)
  expect(off.output).toContain("The open link is off.")
  expect(await Array.fromAsync(new Bun.Glob("**/service*.json").scan({ cwd: root, dot: true }))).toEqual([])
}, 180_000)
