export * as ServerAuth from "./auth"

import { Context, Layer, Option, Redacted } from "effect"
import { createHmac, timingSafeEqual } from "node:crypto"

export type DecodedCredentials = {
  readonly username: string
  readonly password: Redacted.Redacted
}

export type Info = {
  readonly password: Option.Option<string>
  readonly username: string
  // Present while the open link is on: it names this run of the link, and the link's code and sessions are made from
  // it. Turning the link off and on again names a new run, so the old link stops and so does every browser that came
  // in through it.
  readonly openLink?: string
}

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60

export class Config extends Context.Service<Config, Info>()("@opencode/ServerAuthConfig") {
  static configLayer(input: Pick<Info, "password" | "openLink">) {
    return Layer.succeed(this, this.of({ ...input, username: "opencode" }))
  }

  static get layer() {
    return this.configLayer({ password: Option.none() })
  }
}

export function required(config: Info) {
  return Option.isSome(config.password) && config.password.value !== ""
}

// Session tokens issued by pairing links are accepted anywhere the password is.
export function authorized(credentials: DecodedCredentials, config: Info) {
  if (Option.isNone(config.password) || credentials.username !== config.username) return false
  const password = Redacted.value(credentials.password)
  return password === config.password.value || verifySession(password, config)
}

// Sessions are signed with a key derived from the server password, so rotating the password revokes every session.
// A session that came in through the open link ends its expiry with LINK_MARK and is signed with a key that also holds
// the link's run, so it stops working the moment the link is off.
const LINK_MARK = "l"

export function issueSession(config: Info, now = Date.now(), via?: "link") {
  if (Option.isNone(config.password)) return
  const secret = via === "link" ? linkSecret(config) : config.password.value
  if (secret === undefined) return
  const expires = `${Math.floor(now / 1000) + SESSION_TTL_SECONDS}${via === "link" ? LINK_MARK : ""}`
  return `${expires}.${sign(secret, expires)}`
}

export function verifySession(token: string, config: Info, now = Date.now()) {
  if (Option.isNone(config.password)) return false
  const parts = token.split(".")
  if (parts.length !== 2) return false
  const viaLink = parts[0].endsWith(LINK_MARK)
  const secret = viaLink ? linkSecret(config) : config.password.value
  if (secret === undefined) return false
  const expires = Number(viaLink ? parts[0].slice(0, -LINK_MARK.length) : parts[0])
  if (!Number.isSafeInteger(expires) || expires * 1000 <= now) return false
  const expected = Buffer.from(sign(secret, parts[0]))
  const actual = Buffer.from(parts[1])
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

// The open link's code is made from the password and the link's run, so it survives restarts with nothing more to
// store, and changing the password revokes it along with every session. Each derivation is separate from the session
// key, so none reveals another.
export function openLinkCode(password: string, run: string) {
  return createHmac("sha256", password).update(`opencode-open-link-v1:${run}`).digest("base64url")
}

export function openLinkAuthorized(code: string, config: Info) {
  if (!config.openLink || Option.isNone(config.password)) return false
  const expected = Buffer.from(openLinkCode(config.password.value, config.openLink))
  const actual = Buffer.from(code)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function linkSecret(config: Info) {
  if (!config.openLink || Option.isNone(config.password)) return
  return createHmac("sha256", config.password.value)
    .update(`opencode-open-link-session-v1:${config.openLink}`)
    .digest("base64url")
}

// Browsers share cookies across ports on the same host, so the name carries the port to keep local servers apart.
export function sessionCookieName(host: string | undefined) {
  const port = URL.parse(`http://${host ?? ""}`)?.port
  return port ? `opencode_session_${port}` : "opencode_session"
}

function sign(password: string, payload: string) {
  const key = createHmac("sha256", password).update("opencode-session-v1").digest()
  return createHmac("sha256", key).update(payload).digest("base64url")
}
