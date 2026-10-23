import { expect, test } from "bun:test"
import { classify, longformAsk, named, resolve, workspaceish } from "../src/plugin/physics.js"
import * as Gather from "../src/plugin/physics-gather.js"

const ASK = "find me a corpus of sample documents for OCR training"

test("an ask that names no file and says find is a search; one that names a file is not", () => {
  expect(classify(ASK)).toBe("search")
  expect(classify("search for a dataset of handwriting samples")).toBe("search")
  expect(classify("find the bug in calc.py")).not.toBe("search")
  expect(classify("what does calc.py do")).toBe("read")
  expect(classify("change the sum in calc.py")).toBe("edit")
  expect(classify("run npm test")).toBe("shell")
  expect(classify("hello")).toBe("other")
  expect(classify("find it")).not.toBe("search") // one content word names nothing to look for
  expect(named(ASK)).toEqual([])
})

test("resolve turns the ask into queries made of its own words and nothing else", () => {
  const plan = resolve(ASK, "/nonexistent")
  expect(plan.kind).toBe("gather")
  if (plan.kind !== "gather") return
  expect(plan.queries.length).toBeGreaterThanOrEqual(2)
  const own = new Set(Gather.terms(ASK).concat(["dataset", "benchmark", "github"]))
  for (const q of plan.queries) for (const w of q.split(" ")) expect(own.has(w)).toBe(true)
  expect(plan.queries[0]).toBe("corpus sample documents ocr training")
  expect(plan.queries.some((q) => q.includes("dataset") && !q.includes("corpus"))).toBe(true) // pages say dataset where the ask says corpus
  expect(Gather.queries(ASK)).toEqual(plan.queries) // deterministic
  expect(Gather.terms(ASK)).not.toContain("me")
  expect(Gather.terms(ASK)).not.toContain("find")
})

// The research itself (search, gate, read, stop; statements selected by the asker's stance; zero model calls; the serial, cached,
// rate-limit-aware IO) is the door's, and its tests are khora's: opencode-gather.test.mjs.

test("an ask that names the workspace's own things is never a web search (found by falsification: these all classified as search)", () => {
  for (const ask of [
    "search the codebase for TODO comments",
    "find all usages of parseConfig in this repo",
    "look up where the config is loaded",
    "locate the failing test",
    "find the file that defines the router",
    "search for the function that parses dates",
    "find where `loadConfig()` is called",
    "look for the snake_case helper in utils",
    "find me the bug in calc.py",
  ])
    expect([ask, classify(ask)]).not.toEqual([ask, "search"])
  // and the asks that are the world's still are
  for (const ask of ["find me a corpus of sample documents for OCR training", "search for rust async runtimes", "find me the tallest mountains in South America", "where can I get a corpus of speech data"])
    expect([ask, classify(ask)]).toEqual([ask, "search"])
  expect(workspaceish("explain what this function does")).toBe(true)
  expect(workspaceish("explain how photosynthesis works")).toBe(false)
})

test("a long piece is asked for by its kind and a writing verb; an explanation or a question is not one", () => {
  for (const ask of ["write me an essay about dolphins", "draft a report on renewable energy", "compose a blog post about sourdough", "write a white paper on zero trust", "create an analysis of the French Revolution"]) expect([ask, longformAsk(ask)]).toEqual([ask, true])
  for (const ask of ["explain how photosynthesis works", "what is an essay", "find me an essay about dolphins", "hello", "who painted the Sistine Chapel ceiling?", "tell me about dolphins"]) expect([ask, longformAsk(ask)]).toEqual([ask, false])
})
