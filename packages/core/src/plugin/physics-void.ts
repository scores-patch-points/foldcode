// The void an ask names, and whether the file fills it. An ask says what is missing ("TIMEOUT should be 30", "rename
// hello to greet", "delete b", "add a function two"); the machine derives that as checks over the file's own bytes and
// evaluates them on the file the model wrote BEFORE anything is written. An answer that leaves the void open is a bad
// answer, whatever it looks like. No model takes part. An ask with no derivable check is "unchecked", said as such.

export type Check =
  | { kind: "set"; name: string; value: string; why: string }
  | { kind: "renamed"; from: string; to: string; why: string }
  | { kind: "gone"; name: string; why: string }
  | { kind: "defined"; name: string; why: string }
  | { kind: "swapped"; from: string; to: string; why: string }

const word = (w: string) => new RegExp(`(?<![\\w])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`)
const strip = (v: string) => v.replace(/^[`'"]+|[`'".,;:!?]+$/g, "")
const IDENT = "[A-Za-z_][\\w.]*"
const DEF = (name: string) => new RegExp(`(^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?(?:def|function|class|const|let|var|fn|func)\\s+${name}(?![\\w])|(^|\\n)\\s*${name}\\s*(?:=|:=)`)

/** The checks an ask implies. Empty when the ask names nothing the machine can test. */
export const derive = (ask: string): Check[] => {
  const out: Check[] = []
  const a = ask.replace(/\s+/g, " ")
  for (const m of a.matchAll(new RegExp(`\\brename\\s+(?:the\\s+)?(?:function|class|method|variable|const)?\\s*(${IDENT})\\s+to\\s+(${IDENT})`, "gi")))
    out.push({ kind: "renamed", from: m[1], to: strip(m[2]), why: `${m[1]} is gone and ${strip(m[2])} stands in its place` })
  for (const m of a.matchAll(new RegExp(`\\b(?:change|set|make|update)\\s+(?:the\\s+)?(?:value of\\s+)?(${IDENT})\\s+(?:\\w+\\s+)?to\\s+(\\S+)`, "gi"))) {
    const value = strip(m[2])
    if (value && !/^(be|a|an|the|use|return|returns)$/i.test(value)) out.push({ kind: "set", name: m[1], value, why: `${m[1]} is set to ${value}` })
  }
  for (const m of a.matchAll(new RegExp(`\\b(?:delete|remove)\\s+(?:the\\s+)?(?:function|class|method|variable|const)\\s+(${IDENT})`, "gi")))
    out.push({ kind: "gone", name: m[1], why: `${m[1]} is no longer defined` })
  for (const m of a.matchAll(new RegExp(`(?:^|[.;]\\s+)(?:please\\s+)?add\\s+(?:a|an|the)?\\s*(?:new\\s+)?(?:function|method|class)\\s+(?!in\\b|to\\b|that\\b|which\\b)(${IDENT})`, "gi")))
    out.push({ kind: "defined", name: m[1], why: `${m[1]} is defined` })
  for (const m of a.matchAll(/\breplace\s+(\S+)\s+with\s+(\S+)/gi)) {
    const from = strip(m[1])
    const to = strip(m[2])
    if (from && to) out.push({ kind: "swapped", from, to, why: `${to} stands where ${from} was` })
  }
  return out
}

const count = (hay: string, needle: string) => (needle ? hay.split(needle).length - 1 : 0)

/** The checks the file does not satisfy, each with what is still open. */
export const open = (checks: Check[], before: string, after: string): string[] => {
  const left: string[] = []
  for (const c of checks) {
    if (c.kind === "renamed") {
      if (word(c.from).test(after)) left.push(`${c.from} is still in the file`)
      else if (!word(c.to).test(after)) left.push(`${c.to} is not in the file`)
    } else if (c.kind === "set") {
      const line = after.split("\n").find((l) => word(c.name).test(l))
      if (!line) left.push(`no line holds ${c.name}`)
      else if (!line.includes(c.value)) left.push(`${c.name} is not set to ${c.value} (the line reads: ${line.trim().slice(0, 60)})`)
    } else if (c.kind === "gone") {
      if (DEF(c.name).test(after)) left.push(`${c.name} is still defined`)
    } else if (c.kind === "defined") {
      if (!DEF(c.name).test(after)) left.push(`${c.name} is not defined`)
    } else if (c.kind === "swapped") {
      if (!after.includes(c.to)) left.push(`${c.to} is not in the file`)
      else if (count(after, c.from) >= count(before, c.from) && before.includes(c.from)) left.push(`${c.from} is still where it was`)
    }
  }
  return left
}
