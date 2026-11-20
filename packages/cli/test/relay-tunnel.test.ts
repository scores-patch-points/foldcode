import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect, FileSystem } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RelayTunnel } from "../src/services/relay-tunnel"
import { ServiceConfig } from "../src/services/service-config"

const relay = { ssh: "hyphae-link", origin: "https://bcc.hyphae.social", port: 49700 }

test("a relay is an ssh destination, an https origin and a port", () => {
  expect(RelayTunnel.parse("hyphae-link,https://bcc.hyphae.social,49700")).toEqual(relay)
  expect(RelayTunnel.parse(" oclink@203.0.113.7 , https://bcc.hyphae.social/ , 49700 ")).toEqual({
    ssh: "oclink@203.0.113.7",
    origin: "https://bcc.hyphae.social",
    port: 49700,
  })
  expect(RelayTunnel.format(relay)).toBe("hyphae-link,https://bcc.hyphae.social,49700")
})

test("a relay that could run a command, leak a credential or be reached in the clear is refused", () => {
  // ssh would read these as options, and -oProxyCommand runs a command.
  expect(() => RelayTunnel.parse("-oProxyCommand=id,https://bcc.hyphae.social,49700")).toThrow("host alias")
  expect(() => RelayTunnel.parse("host name,https://bcc.hyphae.social,49700")).toThrow("host alias")
  expect(() => RelayTunnel.parse("hyphae-link,http://bcc.hyphae.social,49700")).toThrow("HTTPS origin")
  expect(() => RelayTunnel.parse("hyphae-link,https://user:pw@bcc.hyphae.social,49700")).toThrow("HTTPS origin")
  expect(() => RelayTunnel.parse("hyphae-link,https://bcc.hyphae.social/path,49700")).toThrow("HTTPS origin")
  expect(() => RelayTunnel.parse("hyphae-link,https://bcc.hyphae.social,80")).toThrow("between 1024 and 65535")
  expect(() => RelayTunnel.parse("hyphae-link,https://bcc.hyphae.social,abc")).toThrow("between 1024 and 65535")
  expect(() => RelayTunnel.parse("hyphae-link,https://bcc.hyphae.social")).toThrow("Usage")
})

test("the connection forwards a loopback port on the relay and never waits for a prompt", () => {
  const given = RelayTunnel.args(relay, "127.0.0.1:49374")
  expect(given).toContain("BatchMode=yes")
  expect(given).toContain("ExitOnForwardFailure=yes")
  expect(given.slice(given.indexOf("-R"), given.indexOf("-R") + 2)).toEqual(["-R", "127.0.0.1:49700:127.0.0.1:49374"])
  // The destination comes last and after --, so it can never be read as an option.
  expect(given.slice(-2)).toEqual(["--", "hyphae-link"])
  expect(given).toContain("-N")
})

let root = ""
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-relay-config-"))
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

test("the relay is a service setting that can be set, read back and removed", async () => {
  expect(await run(ServiceConfig.get("relay"))).toBe("")

  await run(ServiceConfig.set("relay", "hyphae-link,https://bcc.hyphae.social,49700"))
  expect(await run(ServiceConfig.get("relay"))).toBe("hyphae-link,https://bcc.hyphae.social,49700")
  expect(await run(ServiceConfig.read())).toEqual({ relay })

  await run(ServiceConfig.unset("relay"))
  expect(await run(ServiceConfig.get("relay"))).toBe("")
  expect(await run(ServiceConfig.read())).toEqual({})
})

test("a bad relay changes nothing", async () => {
  await expect(run(ServiceConfig.set("relay", "-oProxyCommand=id,https://x.example,49700"))).rejects.toThrow()
  expect(await run(ServiceConfig.read())).toEqual({})
})
