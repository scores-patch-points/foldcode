export * as RelayTunnel from "./relay-tunnel"

import { spawn } from "node:child_process"
import { Cause, Effect, Schedule } from "effect"

// A relay is a machine you already run on the internet (a VM with a domain and a web server in front of it). The service
// holds one ssh connection to it that forwards a loopback port there back to this server, so the relay's web server can
// publish the server at its own address with no DNS change and no third-party tunnel.

export type Relay = {
  /** The ssh destination: a host alias from ssh_config, or user@host. */
  readonly ssh: string
  /** The origin the relay's web server publishes, such as https://bcc.example.com. */
  readonly origin: string
  /** The loopback port on the relay that its web server forwards to. */
  readonly port: number
}

// "ssh,origin,port", for `opencode service set relay`.
export function parse(value: string): Relay {
  const parts = value.split(",").map((part) => part.trim())
  if (parts.length !== 3) throw new Error("Usage: opencode service set relay <ssh-destination>,<https-origin>,<port>")
  const [ssh, origin, port] = parts
  // A destination that starts with "-" would be read by ssh as an option, which can run a command.
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]*$/.test(ssh)) throw new Error("The ssh destination must be a host alias or user@host")
  const url = URL.parse(origin)
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("The relay origin must be an HTTPS origin without a path, credentials, query, or fragment")
  const number = Number(port)
  if (!Number.isInteger(number) || number < 1024 || number > 65_535)
    throw new Error("The relay port must be between 1024 and 65535")
  return { ssh, origin: url.origin, port: number }
}

export function format(relay: Relay) {
  return `${relay.ssh},${relay.origin},${relay.port}`
}

// The ssh arguments for one connection. BatchMode keeps it from ever waiting on a prompt, ExitOnForwardFailure turns a
// port the relay cannot give into an exit instead of a connection that forwards nothing, and the keepalives make a
// dead network end the connection so it is made again.
export function args(relay: Relay, target: string) {
  return [
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ClearAllForwardings=no",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-R",
    `127.0.0.1:${relay.port}:${target}`,
    "--",
    relay.ssh,
  ]
}

// A connection that stays up this long counts as healthy: the next attempt after it starts the backoff over.
const STABLE_MS = 30_000
// The forward is made as soon as ssh authenticates, which a healthy relay does well inside this.
const SETTLE_MS = 3_000

// Holds the connection for the life of the service, made again with a growing pause whenever it ends.
export const run = Effect.fnUntraced(function* (input: {
  readonly relay: Relay
  readonly target: string
  readonly onURL: (url: string | undefined) => void
}) {
  let pause = 1_000
  while (true) {
    const started = Date.now()
    const stderr = yield* Effect.promise((signal) => connect(input, signal))
    yield* Effect.logWarning("relay connection ended; retrying", {
      relay: input.relay.origin,
      stderr: stderr.trim().slice(-400),
    })
    pause = Date.now() - started >= STABLE_MS ? 1_000 : Math.min(pause * 2, 30_000)
    yield* Effect.sleep(pause)
  }
}, (effect) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logError("relay stopped; run `opencode service restart` to retry", { cause }),
    ),
  ),
)

// Waits until the relay's address reaches this server: the relay's web server must forward the pairing path, and the
// forward must be up. Only this server answers that path with an UnauthorizedError, so anything else means not yet.
export const ready = Effect.fnUntraced(function* (relay: Relay) {
  let last = "no answer"
  const probe = Effect.tryPromise(async () => {
    const response = await fetch(new URL("/auth/connect/probe", relay.origin), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    }).catch((error: unknown) => {
      last = error instanceof Error ? error.message : String(error)
      throw error
    })
    const body = await response.text()
    if (response.status === 401 && body.includes("UnauthorizedError")) return
    last = `HTTP ${response.status}`
    throw new Error(last)
  })
  yield* probe.pipe(
    Effect.retry({ schedule: Schedule.spaced("1 second") }),
    Effect.timeoutOrElse({
      duration: "90 seconds",
      orElse: () =>
        Effect.fail(
          new Error(
            `${relay.origin} does not reach this server (${last}). Check that \`ssh ${relay.ssh}\` connects without a prompt and that the relay forwards port ${relay.port}.`,
          ),
        ),
    }),
  )
})

// Resolves with what ssh said once it ends. Aborting ends the connection.
function connect(
  input: { readonly relay: Relay; readonly target: string; readonly onURL: (url: string | undefined) => void },
  signal: AbortSignal,
) {
  return new Promise<string>((resolve) => {
    const child = spawn("/usr/bin/ssh", args(input.relay, input.target), { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    const settled = setTimeout(() => input.onURL(input.relay.origin), SETTLE_MS)
    const stop = () => child.kill("SIGTERM")
    signal.addEventListener("abort", stop, { once: true })
    const end = (message: string) => {
      clearTimeout(settled)
      signal.removeEventListener("abort", stop)
      input.onURL(undefined)
      resolve(stderr || message)
    }
    child.on("error", (error) => end(error.message))
    child.on("exit", (code, exitSignal) => end(`ssh exited with ${exitSignal ?? code}`))
  })
}
