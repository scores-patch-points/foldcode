import { expect, test } from "bun:test"
import { capContext, contextChars, neededSteps, projectSteps, stepLog, type Projection } from "../src/plugin/fold.js"

// THE APPEND-ONLY STEP PROJECTION: the head is never edited, a fold appends a superseding event, the dependency
// chain (not age) picks what stays verbatim, and every retired step is lossless under its snip handle.
type M = Parameters<typeof capContext>[0][number]
// SAFETY: the minimal shapes the fold reads (role, id, part type, id/name/input, result text); nothing else is fabricated.
const ask = (text: string) => ({ id: "u1", role: "user", content: [{ type: "text", text }] }) as unknown as M
const call = (id: string, name: string, input: Record<string, unknown>) =>
  ({ id: `a-${id}`, role: "assistant", content: [{ type: "tool-call", id, name, input }] }) as unknown as M
const result = (id: string, name: string, value: string) =>
  ({ id: `r-${id}`, role: "tool", content: [{ type: "tool-result", id, name, result: { type: "text", value } }] }) as unknown as M
const step = (id: string, name: string, input: Record<string, unknown>, out: string) => [call(id, name, input), result(id, name, out)]
const withEnv = <T>(env: Record<string, string>, fn: () => T): T => {
  const prev = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
}
const numbered = (path: string, body: string) =>
  `Read file ${path}, lines 1-${body.split("\n").length}\n${body.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n")}`
const SIZES = { tools: 8_000, system: 1_000 }
const body = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} line ${i} ${"x".repeat(60)}`).join("\n")

test("the log types each act and links an edit to the read it was made from", () => {
  const a = body("A", 5)
  const messages = [
    ask("fix a.ts"),
    ...step("c1", "read", { path: "a.ts" }, numbered("a.ts", a)),
    ...step("c2", "read", { path: "b.ts" }, numbered("b.ts", body("B", 3))),
    ...step("c3", "edit", { path: "a.ts", oldString: "A line 1 ", newString: "A LINE 1 " }, "edited"),
    ...step("c4", "bash", { command: "bun test" }, "1 failed"),
  ]
  const log = stepLog(messages)!
  expect(log.acts.map((s) => s.acts[0].op)).toEqual(["SIG", "SIG", "SYN", "EVA"])
  expect(log.acts[2].deps).toEqual([1]) // the edit depends on the read it was compiled from
  const fact = log.state.get("a.ts")!
  expect(fact.bytes).toBe(a.replace("A line 1 ", "A LINE 1 ")) // the edit is compiled mechanically onto the read
  expect(fact.made).toEqual([3])
  expect(neededSteps(log, 1)).toEqual(new Set([1, 3, 4])) // frontier + latest edit + its root read + latest run; b.ts is free
})

const big = (steps: number, edits = false) => {
  const messages: M[] = [ask("work on the app")]
  for (let i = 0; i < steps; i++) {
    const id = `c${i}`
    if (edits && i === 4) messages.push(...step(id, "edit", { path: "app.js", oldString: "app line 3 ", newString: "app LINE 3 " }, "edited"))
    else if (i === 0) messages.push(...step(id, "read", { path: "app.js" }, numbered("app.js", body("app", 120))))
    else messages.push(...step(id, "read", { path: `f${i}.ts` }, numbered(`f${i}.ts`, body(`f${i}`, 20))))
  }
  return messages
}

test("append-only: every request is the previous one plus new bytes, except where steps were removed", () => {
  withEnv({ FOLD_GATE_CHARS: "30000", FOLD_MAX_CHARS: "1000000", FOLD_VIEW_CHARS: "4000", FOLD_FRONTIER: "2" }, () => {
    let proj: Projection | undefined
    let prev = ""
    let requests = 0
    let breaks = 0
    let events = 0
    const store = new Map<string, string>()
    for (let n = 1; n <= 30; n++) {
      const out = projectSteps(big(n, true), SIZES, proj, store)!
      proj = out.proj
      const text = JSON.stringify(out.messages)
      requests++
      if (prev && !text.startsWith(prev.slice(0, -1))) {
        breaks++
        events++
        expect(out.event || out.clipped).toBeTruthy() // a prefix break happens only when a fold removed steps or fixed a clip
      }
      if (process.env.DBG) console.log(n, out.event ? 'EVENT' : '', out.proj.retired.length, prev && !text.startsWith(prev.slice(0, -1)) ? 'BREAK' : '')
      prev = text
      const sent = structuredClone(out.messages)
      capContext(sent, [{ text: "x".repeat(SIZES.system) }], { fixed: SIZES.tools, store: new Map() }) // the real pipeline cap
      const queued = contextChars(sent) + SIZES.system
      expect(queued).toBeLessThanOrEqual(30_000 - SIZES.tools)
    }
    // the head (the user's ask) is byte-identical in every request: the note never edits it
    const last = projectSteps(big(30, true), SIZES, proj, store)!
    expect(JSON.stringify(last.messages[0])).toBe(JSON.stringify(ask("work on the app")))
    expect(breaks).toBeLessThanOrEqual(10)
    expect(breaks).toBeLessThan(requests / 3)
    console.log(`append-only: ${requests} requests, ${breaks} cache-breaking (each removed steps), ${requests - breaks} pure appends`)
  })
})

test("events supersede by version, and the latest event is current for every entry", () => {
  withEnv({ FOLD_GATE_CHARS: "30000", FOLD_MAX_CHARS: "1000000", FOLD_VIEW_CHARS: "4000", FOLD_FRONTIER: "2" }, () => {
    let proj: Projection | undefined
    for (let n = 1; n <= 30; n++) proj = projectSteps(big(n, true), SIZES, proj, new Map())!.proj
    const evs = proj!.events
    expect(evs.length).toBeGreaterThan(1)
    evs.forEach((ev, i) => {
      expect(ev.text).toContain(`Working notes (version ${i + 1}`)
      if (i > 0) expect(ev.text).toContain(`replacing version ${i}`)
      expect(ev.text).not.toMatch(/<fold|\[fold:/) // plain prose, no markup the model must learn
    })
  })
})

test("dependency retention: the read the latest edit was made from is never folded, however old", () => {
  withEnv({ FOLD_GATE_CHARS: "44000", FOLD_MAX_CHARS: "1000000", FOLD_VIEW_CHARS: "0", FOLD_FRONTIER: "2" }, () => {
    let proj: Projection | undefined
    const store = new Map<string, string>()
    const msgs = (n: number) => {
      const m = big(n)
      // the latest edit (step 3) is made from the read at step 1; it stays the latest edit as steps pile up
      m.splice(1 + 2 * 2, 0, ...step("e", "edit", { path: "app.js", oldString: "app line 3 ", newString: "app LINE 3 " }, "edited"))
      return m
    }
    let out
    for (let n = 3; n <= 30; n++) {
      out = projectSteps(msgs(n), SIZES, proj, store)!
      proj = out.proj
      const text = JSON.stringify(out.messages)
      expect(text).toContain("app line 100") // step 1's read (the edit's root) rides verbatim in every request
      expect(text).toContain(`"id":"e"`) // and so does the edit
    }
    expect(proj!.retired.length).toBeGreaterThan(10) // while the unrelated reads were retired
  })
})

test("mechanical state: the projection says the file was read at a version, so no re-read is needed", () => {
  withEnv({ FOLD_GATE_CHARS: "20000", FOLD_MAX_CHARS: "1000000", FOLD_VIEW_CHARS: "0", FOLD_FRONTIER: "1" }, () => {
    const m = [ask("x"), ...step("c1", "read", { path: "app.js" }, numbered("app.js", body("app", 60)))]
    for (let i = 2; i <= 12; i++) m.push(...step(`c${i}`, "read", { path: i % 2 ? "app.js" : `g${i}.ts` }, numbered(i % 2 ? "app.js" : `g${i}.ts`, body(i % 2 ? "app" : `g${i}`, 60))))
    const out = projectSteps(m, SIZES, undefined, new Map())!
    const text = out.event!.text
    expect(text).toMatch(/- app\.js @\w+ · read at this version at steps 1, 3, 5, 7, 9, 11 · the same bytes each time/)
    expect(text).toContain("as of step 12")
  })
})

test("lossless: every retired step's snip handle returns its exact bytes", () => {
  withEnv({ FOLD_GATE_CHARS: "30000", FOLD_MAX_CHARS: "1000000", FOLD_VIEW_CHARS: "4000", FOLD_FRONTIER: "2" }, () => {
    const store = new Map<string, string>()
    const messages = big(30, true)
    const out = projectSteps(messages, SIZES, undefined, store)!
    const log = stepLog(messages)!
    const retired = new Set(out.proj.retired)
    expect(retired.size).toBeGreaterThan(0)
    for (const a of log.acts) {
      if (!retired.has(a.id)) continue
      expect(store.get(a.handle)).toBe(JSON.stringify(messages.slice(a.start, a.end).map((m) => ({ role: m.role, content: m.content }))))
      expect(a.handle).toMatch(/^r[0-9a-z]{4,16}$/) // the snip tool resolves these locally
      expect(out.event!.text).toContain(a.handle) // and the receipt in the event names it
    }
    // nothing orphaned: every tool result in the window has its call
    const calls = new Set(out.messages.flatMap((m) => m.content.flatMap((p) => (p.type === "tool-call" ? [p.id] : []))))
    for (const m of out.messages) for (const p of m.content) if (p.type === "tool-result") expect(calls.has(p.id)).toBe(true)
  })
})

test("under the gate nothing changes", () => {
  withEnv({ FOLD_GATE_CHARS: "480000", FOLD_MAX_CHARS: "1000000" }, () => {
    const messages = big(6)
    const out = projectSteps(messages, SIZES, undefined, new Map())!
    expect(out.event).toBeUndefined()
    expect(JSON.stringify(out.messages)).toBe(JSON.stringify(messages))
  })
})
