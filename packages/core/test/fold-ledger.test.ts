import { expect, test } from "bun:test"
import { ledger } from "../src/plugin/fold-tokens.js"

// The ledger turns the tap's lines (provider tokens + the fold's own window sizes) into spent vs saved.
// Every expectation below is worked by hand from the inputs, so it checks the arithmetic, not the plumbing.
type L = Parameters<typeof ledger>[0][number]
const line = (seq: number, prompt: number, cacheRead: number, window?: { before: number; after: number; tools: number }, over: Partial<L> = {}) =>
  ({
    v: 1, ts: seq, sid: "s", seq, kind: "primary", status: 200, protocol: "openai-chat", complete: true, consistent: true,
    requestChars: prompt * 4, // 4 chars per token, so the session's measured ratio is exactly 4
    window,
    usage: { prompt, cacheRead, cacheWrite: 0, output: 10, reasoning: 0, total: null },
    prev: "", hash: "",
    ...over,
  }) as unknown as L

test("a request with no window record is its own no-fold twin: nothing saved, nothing invented", () => {
  const [r] = ledger([line(1, 1000, 0), line(2, 1100, 900)])
  expect(r.saved.raw).toBe(0)
  expect(r.saved.billed).toBe(0)
  expect(r.unmeasured).toBe(2)
})

test("window savings convert at the session's own chars-per-token, and no-fold caching is the best case", () => {
  // actual: prompts 1000/1100/1200, the fold broke the cache after the first request (cache read 0/200/200)
  // the fold kept out 0 / 4000 / 8000 chars = 0 / 1000 / 2000 tokens at 4 chars per token
  const w = (kept: number) => ({ before: 10_000 + kept, after: 10_000, tools: 0 })
  const [r] = ledger([line(1, 1000, 0, w(0)), line(2, 1100, 200, w(4000)), line(3, 1200, 200, w(8000))])
  expect(r.cpt).toBe(4)
  expect(r.saved.window).toBe(3000)
  expect(r.nofold.prompt).toBe(1000 + 2100 + 3200) // 6,300
  expect(r.saved.raw).toBe(6300 - 3300)
  // billed at 0.1: actual = 1000 + (900+20) + (1000+20) = 2940
  expect(r.spent.billed).toBeCloseTo(2940)
  // no fold, append-only: each request reads the previous whole request from cache
  // = 1000 + (1100 + 100) + (1100 + 210) = 3510 — more than the fold's 2940, so the fold saved 570 here
  expect(r.nofold.billed).toBeCloseTo(3510)
  expect(r.saved.billed).toBeCloseTo(570)
})

test("a fold that costs more than it saves shows as a negative, not hidden", () => {
  // the fold's notes added 4000 chars (after > before): tokens spent for nothing
  const [r] = ledger([line(1, 1000, 0, { before: 10_000, after: 14_000, tools: 0 }), line(2, 1000, 1000, { before: 10_000, after: 14_000, tools: 0 })])
  expect(r.saved.window).toBe(-2000)
  expect(r.saved.billed).toBeLessThan(0)
})

test("tool definitions not sent are their own line, against the fullest set the session carried", () => {
  // 20,000 chars of definitions the first time, 8,000 after a turn that needed fewer: 12,000 chars = 3,000 tokens
  const [r] = ledger([line(1, 1000, 0, { before: 5000, after: 5000, tools: 20_000 }), line(2, 1000, 1000, { before: 5000, after: 5000, tools: 8_000 })])
  expect(r.saved.tools).toBe(3000)
  expect(r.saved.window).toBe(0)
})

test("failed and usage-less lines are not counted", () => {
  const rows = ledger([
    line(1, 1000, 0, { before: 1, after: 1, tools: 0 }),
    line(2, 999_999, 0, undefined, { status: 403 }),
    line(4, 999_999, 0, undefined, { usage: null }),
  ])
  expect(rows[0].requests).toBe(1)
  expect(rows[0].spent.prompt).toBe(1000)
})

test("the no-fold twin is capped at the model window, so a long session cannot claim an impossible saving", () => {
  // each request kept 400,000 chars (100,000 tokens) out of the window; with a 128,000 cap the twin can hold at most
  // 128,000 - prompt more than what was sent
  const big = { before: 410_000, after: 10_000, tools: 0 }
  const [r] = ledger([line(1, 1000, 0, big), line(2, 1000, 1000, big)], 0.1, 128_000)
  expect(r.nofold.prompt).toBeLessThanOrEqual(2 * 128_000)
  expect(r.capped).toBe(0) // 100,000 tokens fits under the cap
  const [c] = ledger([line(1, 1000, 0, { before: 4_010_000, after: 10_000, tools: 0 })], 0.1, 128_000)
  expect(c.nofold.prompt).toBe(128_000)
  expect(c.capped).toBe(1)
})

test("an implausible chars-per-token ratio computes no saving instead of inventing one", () => {
  // 40 chars per token: the provider counted far fewer tokens than the characters sent (a truncating runtime)
  const [r] = ledger([line(1, 1000, 0, { before: 90_000, after: 10_000, tools: 0 }, { requestChars: 40_000 })])
  expect(r.implausible).toBe(true)
  expect(r.saved.raw).toBe(0)
})

test("title and summary requests are spent in both worlds and change no saving", () => {
  const [r] = ledger([line(1, 1000, 0, { before: 5000, after: 5000, tools: 0 }), line(2, 500, 0, undefined, { kind: "title" })])
  expect(r.spent.prompt).toBe(1500)
  expect(r.nofold.prompt).toBe(1500)
  expect(r.saved.raw).toBe(0)
})

test("the ratio comes only from requests that recorded their size", () => {
  // two old-build lines (no requestChars) beside two sized ones at exactly 4 chars/token
  const [r] = ledger([
    line(1, 1000, 0, undefined, { requestChars: undefined }),
    line(2, 1000, 0, undefined, { requestChars: undefined }),
    line(3, 1000, 0, { before: 14_000, after: 10_000, tools: 0 }),
    line(4, 1000, 1000, { before: 14_000, after: 10_000, tools: 0 }),
  ])
  expect(r.cpt).toBe(4)
  expect(r.saved.window).toBe(2000) // 2 requests x 4,000 chars / 4
})

test("a session that cannot be modelled is its own twin, cache included: no invented loss", () => {
  const [r] = ledger([line(1, 1000, 0, { before: 90_000, after: 10_000, tools: 0 }, { requestChars: 40_000 }), line(2, 1000, 100, { before: 90_000, after: 10_000, tools: 0 }, { requestChars: 40_000 })])
  expect(r.implausible).toBe(true)
  expect(r.saved.billed).toBe(0)
  expect(r.nofold.billed).toBe(r.spent.billed)
})
