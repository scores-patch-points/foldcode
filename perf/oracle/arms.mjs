import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
// Arms: what the model is shown. An arm turns a task's turns into {context, resolve}. `resolve(ref)` returns the
// verbatim bytes behind a pointer (the snip), or undefined. identity is the baseline; truncate is a NEGATIVE
// CONTROL that the oracle must be able to see as worse; pointerDemo is the protocol fixture for layer 3.
export const render = (turns, from = 0) =>
  turns
    .map((t, i) => {
      const n = from + i + 1
      return [`[turn ${n}] USER: ${t.ask}`, ...t.calls.map((c) => `[turn ${n}] TOOL ${c.tool} ${c.path}:\n${c.output}`), `[turn ${n}] ASSISTANT: ${t.answer}`].join("\n")
    })
    .join("\n\n")

export const identity = {
  name: "identity",
  build: (task) => ({ context: render(task.turns), resolve: undefined, authored: "" }),
}

export const truncate = (keep = 6) => ({
  name: `truncate${keep}`,
  build: (task) => {
    const cut = Math.max(0, task.turns.length - keep)
    const note = `${cut} earlier turns are not shown.`
    return { context: `[${note}]\n\n` + render(task.turns.slice(cut), cut), resolve: undefined, authored: note }
  },
})

// Old tool results become pointers; everything else stays. Not a layer-3 implementation: it exists so the SNIP
// round-trip, and the oracle's ability to score it, are tested before layer 3 is built.
export const pointerDemo = (keep = 6) => ({
  name: `pointerDemo${keep}`,
  build: (task) => {
    const store = new Map()
    const cut = Math.max(0, task.turns.length - keep)
    const turns = task.turns.map((t, i) => ({
      ...t,
      calls: t.calls.map((c) => {
        if (i >= cut) return c
        const ref = `turn${i + 1}#${c.path}`
        store.set(ref, c.output)
        return { ...c, output: `[${c.output.length} chars kept out; SNIP ${ref}]` }
      }),
    }))
    return { context: render(turns), resolve: (ref) => store.get(ref), authored: [...store.keys()].map((r) => `kept out; SNIP ${r}`).join("\n") }
  },
})

// Opaque per-prompt handles: `SNIP r417`. The handle is minted for THIS prompt (random, unrelated to turn, path or
// byte range), so the model never sees a content-shaped address it could write from memory, and a handle it writes
// that was not issued is a measurable fabrication. `index` maps handle -> what it hides (the mock uses it; a real
// model cannot see it). Gary's no-address rule is satisfied by construction.
export const handles = (keep = 6) => ({
  name: `handles${keep}`,
  build: (task) => {
    const store = new Map(), index = new Map(), used = new Set()
    const mint = () => { for (;;) { const h = `r${100 + Math.floor(Math.random() * 900)}`; if (!used.has(h)) return (used.add(h), h) } }
    const cut = Math.max(0, task.turns.length - keep)
    const turns = task.turns.map((t, i) => ({
      ...t,
      calls: t.calls.map((c) => {
        if (i >= cut) return c
        const h = mint()
        store.set(h, c.output)
        index.set(h, { turn: i + 1, planted: c.planted })
        return { ...c, output: `[${c.output.length} chars kept out; SNIP ${h}]` }
      }),
    }))
    return { context: render(turns), resolve: (h) => store.get(h), index, authored: [...store.keys()].map((h) => `kept out; SNIP ${h}`).join("\n") }
  },
})

// ── sealed: the frontier sees recent turns + only the referents a cheap selector chose (khora/opencode-sealed.mjs).
// `enabled` is the toggle: off delegates to the handles arm (same names-and-SNIP shape the model could always use).
const KHORA = process.env.FOLD_KHORA ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../khora")
const S = await import(pathToFileURL(path.join(KHORA, "opencode-sealed.mjs")).href)
export const sealedEnabled = S.sealedEnabled

export const mechanicalSelector = (top = 3) => ({ name: "mech", calls: 0, select: async (probe, refs) => mechanicalSelect_(probe, refs, top) })
const mechanicalSelect_ = (probe, refs, top) => S.mechanicalSelect(probe, refs, { top })

// A small local model shown ONLY the question and the names (a ~1K-token prompt). Load is capped: one call at a time,
// a pause between calls, a hard call budget (past it the selector abstains and the call unseals), tiny num_ctx/num_predict.
export const modelSelector = (adapter, { top = 3, maxCalls = 200, pauseMs = 250 } = {}) => {
  const sel = { name: `local:${adapter.name}`, calls: 0, abstained: 0, prompts: [] }
  sel.select = async (probe, refs) => {
    if (sel.calls >= maxCalls) { sel.abstained++; return [] }
    sel.calls++
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs))
    const prompt = S.selectPrompt(probe, refs, { top })
    sel.prompts.push(prompt)
    const out = await adapter.ask(prompt)
    return out.error ? [] : S.parseSelection(out.text, refs.length, { top })
  }
  return sel
}

// The stack's own semantic eye: nomic-embed-text through corpus-resonance.js (embed, cosine, and the measured null ceiling a
// real match must beat). Names are embedded once per task; the probe is embedded once; top referents above the ceiling win.
// No generation, one small embedding model, a few KB per call. Falls back to nothing (so the call unseals) if the embedder is down.
export const resonantSelector = ({ top = 3, ollamaUrl } = {}) => {
  const sel = { name: "resonant", calls: 0, select: null }
  sel.select = async (probe, refs) => {
    sel.calls++
    const R = await import(pathToFileURL(path.join(KHORA, "native/the-fold/corpus-resonance.js")).href)
    const opts = ollamaUrl ? { ollamaUrl } : {}
    const cache = await R.buildResonanceCache(refs, (r) => r.name, opts)
    const [q] = await R.embed([probe], opts)
    return cache.itemVecs
      .map((iv, i) => ({ i, s: R.cosine(q, iv.vec) }))
      .filter((x) => x.s > cache.ceiling)
      .sort((x, y) => y.s - x.s)
      .slice(0, top)
      .map((x) => x.i)
  }
  return sel
}

export const sealedArm = ({ keep = 6, top = 3, selector = mechanicalSelector(top), enabled = S.sealedEnabled() } = {}) => ({
  name: enabled ? `sealed-${selector.name}` : `sealed-off`,
  selector,
  build: async (task) => {
    if (!enabled) return { ...handles(keep).build(task), meta: { sealed: false } }
    const r = await S.seal({ turns: task.turns, probe: task.probe, render, select: selector.select, keep, top })
    const cut = Math.max(0, task.turns.length - keep)
    const old = (task.needs ?? []).filter((n) => n.turn < cut)
    const chosen = new Set(r.selected)
    const got = old.filter((n) => r.refs.some((x) => x.turn === n.turn && x.part === n.part && chosen.has(x.id)))
    return { ...r, meta: { sealed: true, unsealed: r.unsealed, picked: r.selected.length, needOld: old.length, gotOld: got.length, refs: r.refs.length } }
  },
})
