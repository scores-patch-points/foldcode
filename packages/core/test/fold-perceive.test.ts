import { expect, test } from "bun:test"
import { PERCEIVE_MAX_B64, PERCEIVE_MAX_BYTES, perceivableMime, tooLargeToPerceive } from "../src/plugin/fold-perceive.js"

test("pictures, sound, video and PDFs are forwarded to the door; other media and text are not", () => {
  for (const m of ["image/png", "image/jpeg", "audio/wav", "audio/mpeg", "video/mp4", "video/quicktime", "application/pdf"]) expect(perceivableMime(m)).toBe(true)
  for (const m of ["text/plain", "application/json", "application/zip", "application/octet-stream", ""]) expect(perceivableMime(m)).toBe(false)
})

test("the check is case-insensitive", () => {
  expect(perceivableMime("VIDEO/MP4")).toBe(true)
  expect(perceivableMime("Application/PDF")).toBe(true)
})

test("video is forwarded: the regression this seam exists for (it was skipped before)", () => {
  expect(perceivableMime("video/webm")).toBe(true)
})

test("an attachment over the door's cap is not posted, one at the cap is", () => {
  expect(PERCEIVE_MAX_BYTES).toBe(25 * 1024 * 1024)
  expect(tooLargeToPerceive("A".repeat(PERCEIVE_MAX_B64))).toBe(false)
  expect(tooLargeToPerceive("A".repeat(PERCEIVE_MAX_B64 + 1))).toBe(true)
  expect(tooLargeToPerceive("")).toBe(false)
})

test("the base64 cap holds exactly the door's byte cap", () => {
  const bytes = Buffer.alloc(PERCEIVE_MAX_BYTES, 1)
  expect(tooLargeToPerceive(bytes.toString("base64"))).toBe(false)
  expect(tooLargeToPerceive(Buffer.alloc(PERCEIVE_MAX_BYTES + 3, 1).toString("base64"))).toBe(true)
})
