# The Fold tab, as an MRI of the mind

The work tree answers *what did it touch, in order*. It is a listing, an expanded
chronological trace. That is one question, and it is the wrong one to lead with when
someone asks "how do I go inside of anything."

An MRI answers a different question. Not *what happened* but *what shape is the
thinking, and where is it abnormal*. This note is the prior art for the scan, and the
design it points to.

## Why the MRI metaphor is the right one for *this* system

A scan needs a fixed frame. An MRI works because the brain's anatomy does not move
between patients: you can overlay a lesion map on a grayscale slice because the slice
is always the same slice. The mind here already has that invariant frame — the nine
operators, in three triads, always in the same order:

```
      see            shape           hold
   ∅  ○  ●         ｜  ⋈  △        ⊢  ⊨  ◉
  Read Notice Name  Segment Bond Compose  Define Evaluate Reframe
```

That frame is *name-independent*. It does not care whether the system is reading War
and Peace, a symphony's leitmotif, or a screenshot — the operators are the shape
cognition takes in any modality. So an MRI of the nine operators is an MRI of the mind
itself, and it is the one view that survives the nameless-referent principle. The
work tree is bound to *things* (paths, commands); the scan is bound to *the invariant
shape*, which is what you actually want when you "go inside."

## Prior art (what exists, what to borrow)

| Source | What it does | What to borrow |
|---|---|---|
| **MRIcro / MRIcron** (Rorden) | Overlays a red *lesion map* on a grayscale *anatomical* scan; 255 grays, one opaque red reserved for the anomaly | The whole move: **anatomy in grays + a single-color anomaly overlay**. Never a rainbow; one accent reserved for "wrong." |
| **AFNI / standard MRI viewers** | Slice the same volume in each cardinal plane simultaneously; anatomy + activation overlay | **Anatomy + functional overlay**, and **slicing** (by turn, by triad, by target) |
| **fMRI** | Time series of activation across regions | The **functional** layer: which region lights when, over time |
| **DTI / tractography** | White-matter tracts: the paths between regions | The **tracts**: which operator followed which (the transition edges) |
| **Flame graph / flame chart** (Brendan Gregg; icicle) | Depth = stack, width = *share of samples*; flame chart = time on X; **differential** flame graph = two runs against each other | **Width by weight** (tokens/time per operator); a **time axis**; comparing this turn to the session's baseline |
| **Langfuse agent graphs** | Same trace drawn **Aggregated** (one node per step name, loops collapse to cycles → the *shape*) vs **Expanded** (every call → the exact run) | The tree is the **expanded** view; the scan is the **aggregated** view. Offer both as a mode toggle. |
| **LangSmith** | Trace (tree) / thread (session) / **trajectory** (flat ordered path) | A flat trajectory view is already implicit in the time strip |
| **ACT-R** | The *contents of the buffers at a moment* **are** the state of the mind; cognition unfolded as a succession of production firings printed as a **trace** | The live state is a *snapshot of slots*, not a log line. The scan should read slot contents at the moment. |
| **Soar** | Decision tree of **states and operators**; four **impasse** types when an operator can't be chosen | Name the **anomalies** as first-class, typed events (the "lesion map"), not just red text |
| **Activation Atlas / Summit** (Distill, Google, OpenAI) | A global, human-interpretable overview of internal concepts in one frame | "All in one frame, comparable between runs" — the point of a fixed anatomy |

The synthesis: **nobody in agent-observability has a fixed cognitive anatomy.** Every
trace viewer is content-bound (this tool, that path). The one asset this system has
that they don't is the nine operators as an invariant frame. That is what makes a
*scan* possible and a *listing* unavoidable for everyone else.

## The design: structural + functional + diffusion, on one frame

Three sequences, like a scanner's T1 / fMRI / DTI, all on the same nine-slot frame.

### 1. Structural — the anatomy (always drawn)

All nine operators, always present, always in place. Each slot carries what the
grayscale would: the count of steps that landed there, and its aggregate state.

- **never fired** — dark (the "black region"; a lobe that isn't there)
- **fired** — grays, brightness by count
- **failed** — the red anomaly
- **running** — the pulsing accent

Drawn as the three triads, so the columns read see / shape / hold.

### 2. Functional — the activity (the strip)

Time on X (one tick per step), the nine operators on Y. A step lights its operator.

- a **horizontal band** = stuck in one operator
- a **diagonal** = a healthy walk: see → shape → hold
- a **step back** (a REC tick slapping left to see, or a row jumping up) = a rebound
- a **running** tick pulses

This is the single view that makes "how it is thinking" legible at a glance, the way
a flame chart makes performance legible.

### 3. Diffusion — the tracts

The edges: which operator followed which, and which target grew out of which ("after"
edges). A 9×9 transition count, or a small flow. Shows whether the mind runs as a line
through the triads or loops.

## The read (the radiologist's line)

Under the scan, one sentence, computed only from the slots — never invented:

> see 6 · shape 4 · hold 1 — never bonded (⋈ unused) · settled with a check · one
> reframe, and it changed the frame

The last clause already exists in code (`frameChange`): *a REC that re-runs the same
tool on the same target is a line, not a spiral.*

## Anomalies are typed (the lesion map)

Reserved red, one kind each, so a scan can be differenced between turns:

| Anomaly | Signature | Meaning |
|---|---|---|
| **dark region** | a triad/operator never reached this turn | the mind never entered that lobe |
| **unclosed** | target settled, no passing `EVA` before settle | it stopped without a check |
| **stuck** | an `error` with no following `REC` | it hit a wall and did not reframe |
| **line, not spiral** | `REC` where `frameChange` = false | a reframe that re-drew the same frame |
| **re-draw** | same operator repeated with no progress in isle | churn without movement |

## What to build, concretely

- Keep the tree (expanded) and add the scan (aggregated) as a **mode toggle** — the
  Langfuse aggregated/expanded lesson.
- The scan's data is **already on the snapshot**: `laps[].steps[]` with `stage`,
  `status`, `reframed`, `error`. No new app-side plumbing is required for v1; the
  structural and functional layers are a projection of the existing `Snapshot`.
- The read is a pure function over the same projection — testable alone, like
  `mind-tree-model.ts`.
- The differential (this turn vs the session's baseline) is the v2 hook, and is where
  the flame-graph prior art pays off.
