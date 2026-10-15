# EOT Log - spec + demo

Append-only. Current state = fold(log). Never edit a block. Update by redefining referent with `supersedes:`.

Block shape:
```
### <id> · <date> · referent: `<name@version>`
supersedes: <prior-id or none>
<+ smallest diff, one behavior>
check: `<real testCommand>`
◼ EOT
```

Fold rule: last-wins per referent. History preserved. `testCommand` exit 0 = REC keep, else revert.

---

### e031 · 2026-10-15 · referent: `retryPolicy@1`
supersedes: none
+ `retry(fn): maxRetries 3, no jitter, path: lib/retry.ts#12-30`
+ source: box compute, address: lib/retry.ts#12-30
check: `bun test retry`
◼ EOT

### e042 · 2026-10-15 · referent: `retryPolicy@2`
supersedes: e031
+ maxRetries 3 -> 5 with jitter, snipped backoff from field `lib/backoff.ts#4-22`
+ source: field hunt, address: lib/backoff.ts#4-22, model: hunt (zero draw)
check: `bun test retry`
◼ EOT

### e043 · 2026-10-15 · referent: `retryPolicy@3`
supersedes: e042
+ reconcile param `delayMs` to caller type `RetryOpts`, mouth drew body only from anchor `async function retry(` + docstring + last failure
+ source: mouth spiral, address: lib/retry.ts#12-34, model: qwen2.5-coder:1.5b
+ dissent: web candidate rejected (frame-mismatch, wrong kind)
check: `bun test retry`
◼ EOT
