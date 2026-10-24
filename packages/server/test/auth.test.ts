import { expect, test } from "bun:test"
import { ServerAuth } from "@opencode/server/auth"
import { Option, Redacted } from "effect"

test("accepts only the fixed opencode username", () => {
  const config = { password: Option.some("secret"), username: "opencode" }
  expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, config)).toBe(true)
  expect(ServerAuth.authorized({ username: "custom", password: Redacted.make("secret") }, config)).toBe(false)
})

test("session tokens expire, resist tampering, and are revoked by changing the password", () => {
  const config = { password: Option.some("secret"), username: "opencode" }
  const now = Date.now()
  const token = ServerAuth.issueSession(config, now)
  if (!token) throw new Error("Expected a session token")
  expect(ServerAuth.verifySession(token, config, now)).toBe(true)
  expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make(token) }, config)).toBe(true)
  expect(ServerAuth.verifySession(token, config, now + ServerAuth.SESSION_TTL_SECONDS * 1000)).toBe(false)
  expect(ServerAuth.verifySession(`${token}x`, config, now)).toBe(false)
  const parts = token.split(".")
  expect(ServerAuth.verifySession(`${Number(parts[0]) + 1}.${parts[1]}`, config, now)).toBe(false)
  expect(ServerAuth.verifySession(token, { ...config, password: Option.some("rotated") }, now)).toBe(false)
  expect(ServerAuth.issueSession({ ...config, password: Option.none() })).toBeUndefined()
})

test("the open link works only while it is on, for the current password and run", () => {
  const config = { password: Option.some("secret"), username: "opencode", openLink: "run1" }
  const code = ServerAuth.openLinkCode("secret", "run1")
  expect(ServerAuth.openLinkAuthorized(code, config)).toBe(true)
  // Reusable: opening it again signs in again.
  expect(ServerAuth.openLinkAuthorized(code, config)).toBe(true)
  expect(ServerAuth.openLinkAuthorized(code, { ...config, openLink: undefined })).toBe(false)
  expect(ServerAuth.openLinkAuthorized(code, { ...config, openLink: "" })).toBe(false)
  // Turned off and on again, the link is a new one and the old one is dead.
  expect(ServerAuth.openLinkAuthorized(code, { ...config, openLink: "run2" })).toBe(false)
  expect(ServerAuth.openLinkAuthorized(ServerAuth.openLinkCode("secret", "run2"), { ...config, openLink: "run2" })).toBe(true)
  expect(ServerAuth.openLinkAuthorized(`${code}x`, config)).toBe(false)
  expect(ServerAuth.openLinkAuthorized(code.slice(1), config)).toBe(false)
  expect(ServerAuth.openLinkAuthorized("", config)).toBe(false)
  expect(ServerAuth.openLinkAuthorized(code, { ...config, password: Option.some("rotated") })).toBe(false)
  expect(ServerAuth.openLinkAuthorized(code, { ...config, password: Option.none() })).toBe(false)
})

test("the open link code is not the password or the session key", () => {
  const code = ServerAuth.openLinkCode("secret", "run1")
  expect(code).not.toContain("secret")
  expect(ServerAuth.openLinkCode("secret", "run1")).toBe(code)
  expect(ServerAuth.openLinkCode("other", "run1")).not.toBe(code)
  const config = { password: Option.some("secret"), username: "opencode" }
  const token = ServerAuth.issueSession(config)
  expect(token?.split(".")[1]).not.toBe(code)
})

test("a session that came in through the open link ends with the link", () => {
  const config = { password: Option.some("secret"), username: "opencode", openLink: "run1" }
  const now = Date.now()
  const token = ServerAuth.issueSession(config, now, "link")
  if (!token) throw new Error("Expected a session token")
  expect(ServerAuth.verifySession(token, config, now)).toBe(true)
  expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make(token) }, config)).toBe(true)
  expect(ServerAuth.verifySession(token, config, now + ServerAuth.SESSION_TTL_SECONDS * 1000)).toBe(false)
  expect(ServerAuth.verifySession(`${token}x`, config, now)).toBe(false)
  // Off, or replaced by a new run, or the password changed: the browser is signed out.
  expect(ServerAuth.verifySession(token, { ...config, openLink: undefined }, now)).toBe(false)
  expect(ServerAuth.verifySession(token, { ...config, openLink: "run2" }, now)).toBe(false)
  expect(ServerAuth.verifySession(token, { ...config, password: Option.some("rotated") }, now)).toBe(false)
  // It cannot be passed off as an ordinary session by dropping its mark, and cannot be issued without a link.
  const [stamp, signature] = token.split(".")
  expect(ServerAuth.verifySession(`${stamp.slice(0, -1)}.${signature}`, config, now)).toBe(false)
  expect(ServerAuth.issueSession({ ...config, openLink: undefined }, now, "link")).toBeUndefined()
})

test("other sessions are not touched by the open link", () => {
  const config = { password: Option.some("secret"), username: "opencode" }
  const now = Date.now()
  const token = ServerAuth.issueSession(config, now)
  if (!token) throw new Error("Expected a session token")
  expect(ServerAuth.verifySession(token, { ...config, openLink: "run1" }, now)).toBe(true)
  expect(ServerAuth.verifySession(token, config, now)).toBe(true)
})
