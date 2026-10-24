import { EOL } from "os"
import { Effect } from "effect"
import { Service } from "@opencode/client/effect/service"
import { OpenCode } from "@opencode/client/promise"
import { ServerAuth } from "@opencode/server/auth"
import { renderUnicodeCompact } from "uqr"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { RelayTunnel } from "../../services/relay-tunnel"
import { ServiceConfig } from "../../services/service-config"
import { remoteConsent, remoteURL } from "./pair"

export const linkWarning = [
  "Anyone who opens this link gets full control of this machine's coding session, with no password.",
  "Share it only with people and devices you trust. Run `opencode link --off` to turn it off.",
].join(EOL)

// The first time, remote access is explained with the link's own terms: there is no password to fall back on.
const remoteLinkWarning = ["This will expose your OpenCode server to the internet.", linkWarning].join(EOL)

export default Runtime.handler(
  Commands.commands.link,
  Effect.fn("cli.link")(function* (input: Runtime.Input<typeof Commands.commands.link>) {
    const config = yield* ServiceConfig.read()
    if (input.off) {
      if (config.link !== undefined) yield* ServiceConfig.set("link", "false")
      process.stdout.write("The open link is off." + EOL)
      return
    }
    if (config.disabled === true)
      return yield* Effect.fail(
        new Error("The link requires the background service; run `opencode service unset disabled` first"),
      )
    if (config.relay !== undefined) {
      // Your own machine publishes the link, so there is no OpenTunnel to set up; it is still the internet.
      if (!(yield* remoteConsent(config, input, undefined, remoteLinkWarning))) return
    } else if (config.remote === undefined) {
      if (!(yield* remoteConsent(config, input, undefined, remoteLinkWarning))) return
      // Changing the setting restarts the service, and the ensure below starts it again with the tunnel.
      yield* ServiceConfig.set("remote", "true")
    }
    // Each change restarts the service, so a link that is already on is left alone.
    if (config.link === undefined) yield* ServiceConfig.set("link", "true")
    const endpoint = yield* Service.ensure(yield* ServiceConfig.options())
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const origin =
      config.relay === undefined
        ? yield* remoteURL(client)
        : yield* RelayTunnel.ready(config.relay).pipe(Effect.as(config.relay.origin))
    // The service stores its password the first time it starts, so both are read once it is running.
    const run = (yield* ServiceConfig.read()).link
    if (run === undefined) return yield* Effect.fail(new Error("The open link was turned off while it was starting"))
    const link = new URL(`/auth/connect/${ServerAuth.openLinkCode(yield* ServiceConfig.password(), run)}`, origin).href
    if (input.plain) {
      process.stdout.write(link + EOL)
      return
    }
    process.stdout.write(
      [
        "",
        "  Open this link in any browser to code on this machine.",
        "",
        `  ${link}`,
        "",
        // uqr separates rows with "\n" on every platform, so splitting on EOL ("\r\n" on Windows) indents only the first row.
        renderUnicodeCompact(link, { border: 2 })
          .split("\n")
          .map((line) => "  " + line)
          .join(EOL),
        "",
      ].join(EOL) + EOL,
    )
    process.stderr.write(
      linkWarning
        .split(EOL)
        .map((line) => "  " + line)
        .join(EOL) +
        EOL +
        EOL,
    )
  }),
)
