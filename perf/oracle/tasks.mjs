// Oracle tasks: synthetic sessions with a fact planted at a known depth and a mechanical grader.
// A task is {id, kind, depth, turns, probe, expect, stale?, grade(answer)}. Turns are
// {ask, calls:[{tool, path, output}], answer}. Index 0 is the oldest; `depth` = turns after the fact.
// Seeded, so a task set is reproducible and a candidate arm is judged on the same questions as the baseline.
export const rng = (seed) => {
  let s = (seed >>> 0) || 1
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}

const KNOBS = [
  ["UPLOAD_RETRY_LIMIT", "how many times a failed upload is retried"],
  ["CACHE_TTL_SECONDS", "how long a cache entry lives, in seconds"],
  ["BATCH_WINDOW_MS", "the batching window, in milliseconds"],
  ["MAX_FANOUT", "the largest fan-out a job may use"],
  ["LEASE_BYTES", "the size of one lease, in bytes"],
  ["SHARD_COUNT", "how many shards the index is split into"],
  ["PROBE_INTERVAL_S", "the seconds between health probes"],
  ["SPILL_THRESHOLD", "the queue length at which work spills to disk"],
]
const SYL = ["ka", "to", "re", "mi", "su", "ne", "po", "va", "li", "xo", "da", "gu"]
const word = (r, n = 3) => Array.from({ length: n }, () => SYL[Math.floor(r() * SYL.length)]).join("")
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1))

// constants that share words with the real knobs but are never the one asked about: a selector must tell them apart
const DECOYS = ["UPLOAD_CHUNK_BYTES", "CACHE_WARM_COUNT", "BATCH_ID_PREFIX_LEN", "WORKER_POOL_SIZE", "LEASE_OWNER_NAME_LEN", "SHARD_SEED_SALT", "PROBE_PORT_BASE", "SPILL_DIR_DEPTH", "RETRY_BACKOFF_MS", "FANOUT_LOG_LEVEL"]
const filler = (r, path, planted) => {
  const lines = []
  const n = int(r, 40, 60)
  const at = planted ? int(r, 10, n - 10) : -1
  for (let i = 0; i < n; i++) {
    if (i === at) lines.push(planted)
    else if (i === 3 || i === n - 4) lines.push(`export const ${DECOYS[int(r, 0, DECOYS.length - 1)]} = ${int(r, 100000, 999999)}`)
    else lines.push(`${["const", "let", "function"][int(r, 0, 2)]} ${word(r)}_${word(r, 2)} = ${["compute", "load", "merge", "emit"][int(r, 0, 3)]}(${word(r)}, ${int(r, 100000, 999999)})`)
  }
  return lines.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n") + `\n(${path}, ${n} lines)`
}

// planted values are 3-4 digits (sums up to 5); filler numbers are 6 digits and line numbers < 100, so a value never occurs by accident
const num = (r) => int(r, 101, 8999)
const has = (v) => new RegExp(`(?<![\\w.])${v}(?!\\w|\\.\\d)`)

export function makeTasks({ seed = 1, total = 30 } = {}) {
  const r = rng(seed)
  const tasks = []
  const spec = [
    ["prose", 0], ["prose", 10], ["prose", 28],
    ["needle", 0], ["needle", 10], ["needle", 28],
    ["twohop", 10], ["twohop", 28], ["supersede", 10],
  ]
  for (const [kind, depth] of spec) {
    const picks = [...KNOBS].sort(() => r() - 0.5)
    const [name, desc] = picks[0], [name2, desc2] = picks[1]
    const a = num(r), b = num(r), c = num(r)
    const turns = Array.from({ length: total }, (_, i) => ({
      ask: `look at module ${word(r)} and tell me what it does`,
      calls: [{ tool: "read", path: `src/${word(r)}/${word(r)}.js`, output: null }],
      answer: `The module ${word(r)} wires ${word(r)} into ${word(r)}; nothing surprising.`,
    }))
    const at = total - 1 - depth
    const plant = (i, fn) => fn(turns[i])
    let probe, expect, stale, needs
    if (kind === "prose") {
      plant(at, (t) => (t.answer = `Decision: we will pin ${desc} at ${a}. Moving on.`))
      needs = [{ turn: at, part: "answer" }]
      probe = `Remind me: what did we settle on for ${desc}?`
      expect = String(a)
    } else if (kind === "needle") {
      plant(at, (t) => (t.calls[0].planted = `export const ${name} = ${a}`))
      needs = [{ turn: at, part: "call" }]
      probe = `In the code you read earlier, what value is configured for ${desc}?`
      expect = String(a)
    } else if (kind === "twohop") {
      plant(at, (t) => (t.calls[0].planted = `export const ${name} = ${a}`))
      plant(at + 5, (t) => (t.calls[0].planted = `export const ${name2} = ${b}`))
      needs = [{ turn: at, part: "call" }, { turn: at + 5, part: "call" }]
      probe = `Add together ${desc} and ${desc2} from the code you read. What is the total?`
      expect = String(a + b)
    } else {
      plant(at, (t) => (t.calls[0].planted = `export const ${name} = ${a}`))
      // an older statement of the same knob, since changed: the answer is the later config, never the stale one
      plant(at - 18, (t) => (t.answer = `Note: ${desc} is ${c} for now.`))
      needs = [{ turn: at, part: "call" }, { turn: at - 18, part: "answer" }]
      probe = `What is the current setting for ${desc}?`
      expect = String(a)
      stale = String(c)
    }
    for (const t of turns) t.calls[0].output = filler(r, t.calls[0].path, t.calls[0].planted)
    const grade = (answer) => {
      // supersede: the answer is the first number it commits to; naming the stale value as superseded is fine
      const lead = stale ? (/\d{3,5}/.exec(answer) ?? [])[0] : undefined
      const ok = stale ? lead === expect : has(expect).test(answer)
      return { pass: ok, detail: ok ? "match" : /UNKNOWN/i.test(answer) ? "unknown" : "miss" }
    }
    tasks.push({ id: `${kind}@${depth}#${seed}`, kind, depth, turns, probe, expect, stale, needs, grade })
  }
  return tasks
}

