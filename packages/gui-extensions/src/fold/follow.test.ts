import { describe, expect, test } from "bun:test"
import { shouldFollow } from "./follow"

describe("shouldFollow", () => {
  test("follows when at the bottom and quiet", () => {
    expect(shouldFollow({ distanceFromBottom: 0, activeSinceMs: 5000 })).toBe(true)
  })
  test("does not follow while the person is scrolling", () => {
    expect(shouldFollow({ distanceFromBottom: 0, activeSinceMs: 200 })).toBe(false)
  })
  test("does not follow once they have scrolled away", () => {
    expect(shouldFollow({ distanceFromBottom: 400, activeSinceMs: 5000 })).toBe(false)
  })
})
