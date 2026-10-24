import { execFile } from "node:child_process"
import { powerSaveBlocker } from "electron"
import type { MainSetup } from "../sdk/main"
import { Pairing } from "./contract"
import type definition from "./index"

/** The display sleep blocker this instance holds, if any. */
type Blocker = { id?: number }

/** The last `opencode service` command; the next one starts after it settles. */
type Queue = { tail: Promise<unknown> }

const setup: MainSetup<typeof definition> = (ctx) => {
  const stored = ctx.stores.keepScreenActive
  const cli = ctx.cli
  const log = ctx.log
  const blocker: Blocker = {}
  const queue: Queue = { tail: Promise.resolve() }

  const release = () => {
    if (blocker.id === undefined) return
    powerSaveBlocker.stop(blocker.id)
    blocker.id = undefined
  }

  const keepScreenActive = (enabled: boolean) => {
    if (enabled && blocker.id === undefined) blocker.id = powerSaveBlocker.start("prevent-display-sleep")

    if (!enabled) release()
    stored.set(enabled)
  }

  // Remote access is a setting of the background service, so it changes through the CLI the app runs, as with
  // `opencode pair --remote`. A change restarts the service, so commands run one at a time.
  const command = (args: readonly string[], signal: AbortSignal) => {
    const run = queue.tail.then(
      () =>
        new Promise<string>((resolve, reject) => {
          execFile(
            cli.command[0] ?? "opencode",
            [...cli.command.slice(1), ...args],
            { signal, windowsHide: true },
            (error, stdout, stderr) => {
              if (!error) return resolve(stdout.trim())
              // The arguments are logged, never the output: the open link's output is its secret.
              log.write("error", "pairing command failed", { args, error: error.message, stderr })
              reject(error)
            },
          )
        }),
    )

    queue.tail = run.catch(() => undefined)

    return run
  }

  const service = (args: readonly string[], signal: AbortSignal) => command(["service", ...args], signal)

  if (stored.value) keepScreenActive(true)
  ctx.scope.addFinalizer(release)

  ctx.provide(Pairing, {
    remote: async (_, caller) => (await service(["get", "remote"], caller.signal)) === "true",
    // Changing the setting stops the service. Starting it here brings it back, with the tunnel when remote access is
    // on. A window that closes meanwhile does not cancel the change.
    setRemote: async (enabled) => {
      await service(["set", "remote", String(enabled)], ctx.scope.signal)
      await service(["start"], ctx.scope.signal)
    },
    link: async (_, caller) => (await service(["get", "link"], caller.signal)) === "true",
    // `opencode link` turns on remote access and the link together and waits for the tunnel; the app's click is the
    // consent it would otherwise ask for. Turning it off stops the service, which starts again here.
    setLink: async (enabled) => {
      if (enabled) await command(["link", "--plain", "--yes"], ctx.scope.signal)
      else {
        await command(["link", "--off"], ctx.scope.signal)
        await service(["start"], ctx.scope.signal)
      }
    },
    // Already on, the command changes nothing: it waits for the tunnel's address and prints the link.
    linkURL: (_, caller) => command(["link", "--plain", "--yes"], caller.signal),
    screenActive: () => blocker.id !== undefined && powerSaveBlocker.isStarted(blocker.id),
    setScreenActive: (enabled) => keepScreenActive(enabled),
  })
}

export default setup
