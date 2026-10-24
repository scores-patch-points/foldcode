import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { remoteConsent } from "../src/commands/handlers/pair"
import { linkWarning } from "../src/commands/handlers/link"
import { ServiceConfig } from "../src/services/service-config"

let root = ""
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-link-config-"))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const run = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })),
      Effect.provide(NodeFileSystem.layer),
    ),
  )

test("the open link is off until it is turned on, and turning it off forgets it", async () => {
  expect(await run(ServiceConfig.get("link"))).toBe("false")

  await run(ServiceConfig.set("link", "true"))
  expect(await run(ServiceConfig.get("link"))).toBe("true")
  expect(await run(ServiceConfig.read())).toEqual({ link: expect.any(String) })

  await run(ServiceConfig.set("link", "false"))
  expect(await run(ServiceConfig.get("link"))).toBe("false")
  expect(await run(ServiceConfig.read())).toEqual({})
})

test("unset turns the link off and leaves other settings alone", async () => {
  await run(ServiceConfig.set("port", "49555"))
  await run(ServiceConfig.set("link", "true"))
  expect(await run(ServiceConfig.read())).toEqual({ port: 49555, link: expect.any(String) })

  await run(ServiceConfig.unset("link"))
  expect(await run(ServiceConfig.read())).toEqual({ port: 49555 })
})

test("the link is a boolean and rejects anything else", async () => {
  await expect(run(ServiceConfig.set("link", "yes"))).rejects.toThrow("Link must be true or false")
  expect(await run(ServiceConfig.read())).toEqual({})
})

test("listing the settings shows the link is on without revealing the password", async () => {
  await run(ServiceConfig.password("hunter2"))
  await run(ServiceConfig.set("link", "true"))
  const run_ = (await run(ServiceConfig.read())).link
  const shown = await run(ServiceConfig.get())
  expect(JSON.parse(shown)).toEqual({ link: true })
  expect(shown).not.toContain("hunter2")
  expect(shown).not.toContain(run_!)
})

test("turning the link on again keeps its run, and turning it off and on makes a new one", async () => {
  await run(ServiceConfig.set("link", "true"))
  const first = (await run(ServiceConfig.read())).link
  expect(first).toMatch(/^[0-9a-f]{16}$/)

  await run(ServiceConfig.set("link", "true"))
  expect((await run(ServiceConfig.read())).link).toBe(first)

  await run(ServiceConfig.set("link", "false"))
  await run(ServiceConfig.set("link", "true"))
  const second = (await run(ServiceConfig.read())).link
  expect(second).toMatch(/^[0-9a-f]{16}$/)
  expect(second).not.toBe(first)
})

test("accepting remote access for the link prints the warning to stderr, so --plain keeps stdout for the link", async () => {
  const written = { stdout: "", stderr: "" }
  const stdout = process.stdout.write
  const stderr = process.stderr.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.stdout += String(chunk)
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.stderr += String(chunk)
    return true
  }) as typeof process.stderr.write
  try {
    const prompt = { interactive: () => false, confirm: async () => false }
    const accepted = await run(
      ServiceConfig.read().pipe(
        Effect.flatMap((config) => remoteConsent(config, { yes: true }, prompt, `Exposed.${"\n"}${linkWarning}`)),
      ),
    )
    expect(accepted).toBe(true)
  } finally {
    process.stdout.write = stdout
    process.stderr.write = stderr
  }
  expect(written.stdout).toBe("")
  expect(written.stderr).toContain("with no password")
})
