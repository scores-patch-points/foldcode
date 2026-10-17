# Verdict: does the reduced arm hold quality?

**Question.** The oracle exists to answer one thing: can the fold show a model much less of a session — by
address instead of bytes — and keep the answer? If it cannot, the fold is a compressor, not a fold.

**Measured** (adapter `opencode-go/deepseek-v4.1-flash`, seed 1's 9 tasks, n=1; rows:
`runs/1792251283807-opencode_opencode_go_deepseek_v4_1_flash.jsonl`):

| arm | pass | ctx | errors |
|---|---|---|---|
| identity (the whole session) | 100.0% (7/7 scored) | 76 KB (100%) | 2/9 |
| handles6 (old tool results as opaque SNIP handles) | 66.7% (4/6 scored) | 20 KB (27%) | 3/9 |

`handles6` vs `identity`: **Δ −20.0pt, CI [−60.0, 0.0] — NOT non-inferior** (margin 5pt).

**Where it fails.** Every failure is a task that needs the pointer protocol: needle@10 (a wrong answer after
137k tokens), needle@28, twohop@10, twohop@28 (three `provider.invalid-request` rejections), supersede@10 (a
SNIP round happened, the answer was still wrong). The prose tasks — which need no pointer — and the first
needle hold.

**Caveats.**
- Three of nine trials died on `provider.invalid-request` in *both* arms (the provider rejects the request
  before a model turn). Those rows measure the harness, not the fold.
- 6–7 scored trials per arm: the CI is wide ([−60, 0]). The point estimate is what it is.
- This model does not follow the text SNIP protocol reliably: it reaches for tools (attempts are recorded in
  the row; none executed, `providerCall.executed === false`) instead of replying `SNIP <handle>`.

**Supersedes.** The earlier "sealed-mech 88.9% @ 28% ctx" figure was measured with an oracle config whose tool
deny was silently ignored — the key had to be the agent's `permissions` ruleset, not the top-level
`permission`, so the model was offered the fold's own `snip`/`execute` tools. Those numbers are not comparable
to these (`runs/1792190241247-*.jsonl`).

**Verdict.** Not proven. The fold cuts the shown context to 27%; on this model, in this configuration, it does
not hold the answer. The next lever is protocol adherence — the model must SNIP the way the arm expects — not
more compression.
