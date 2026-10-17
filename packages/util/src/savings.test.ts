import { describe, expect, test } from "bun:test"
import { compact, money } from "./savings.js"

describe("fold savings formatting", () => {
  test("money reads in whole cents, rounded up, never understating the saving", () => {
    expect(money(5.583)).toBe("$5.59")
    expect(money(0.004)).toBe("$0.01")
    expect(money(0)).toBe("$0.00")
    expect(money(50.002432)).toBe("$50.01")
  })

  test("tokens read compact, two decimals from K up", () => {
    expect(compact(50_002_432)).toBe("50.00M")
    expect(compact(3_130_000)).toBe("3.13M")
    expect(compact(1_234_567_890)).toBe("1.23B")
    expect(compact(6_847)).toBe("6.85K")
    expect(compact(999)).toBe("999")
  })
})
