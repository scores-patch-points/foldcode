// Physics, the gather class: telling a search ask from the other asks. "find me a corpus of sample documents for OCR training" names no
// file and says find; a search is mechanical work (search, gate, read, stop), so the model is never offered a search tool. The work
// itself is the Holodeck's research pipeline, run by the door (khora opencode-gather.mjs, in a worker, no model); this module only
// decides that an ask is one, and derives the queries from the ask's own words.

export const SEARCH = /\b(find|search|look\s?up|look for|locate|gather|research|discover)\b|where can i (?:get|find)/i

const STOP = new Set(
  "a an the of for to and or in on with some any good best great please can could you i we me my us get give show tell find search look up locate gather research discover where how what which is are be that this it as at by from into so about around want need like".split(" "),
)

/** The ask's content words, lower-cased, in order, no repeats. Acronyms survive as words. */
export const terms = (ask: string): string[] => {
  const seen = new Set<string>()
  for (const w of ask.toLowerCase().match(/[a-z][a-z0-9+#-]*/g) ?? []) if (!STOP.has(w) && w.length > 1) seen.add(w)
  return [...seen]
}

const VARIANTS = ["", " dataset", " benchmark", " github"]

/** The queries the ask implies: its terms, then the same terms with the words pages use for the thing asked for. */
export const queries = (ask: string, max = 4): string[] => {
  const base = terms(ask)
  if (!base.length) return []
  const out: string[] = []
  for (const v of VARIANTS) {
    const swapped = base.map((w) => (w === "corpus" || w === "corpora" ? "dataset" : w))
    const q = (v === "" ? base : swapped).join(" ") + v
    if (!out.includes(q)) out.push(q)
  }
  return out.slice(0, max)
}
