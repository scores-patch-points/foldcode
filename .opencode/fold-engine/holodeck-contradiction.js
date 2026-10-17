// holodeck-contradiction.js — the SHAAM. This file is NOT the holodeck's
// contradiction engine. It is a deliberate, disclosed stand-in so the vendored
// pure terrain engine (holodeck-research-terrain.js) loads without dragging in
// the engine's for-whom closure (for-whom.js -> dmd.js, identity.js -> fold.js
// + expectations.js, identity-meet.js, asserted.js — hundreds of lines of
// kernel).
//
// What this costs: the terrain's `field` cell still computes its own
// unit-string contradiction (`differs` — two sources, different values for the
// same figure unit), and that is what the discover-structure tool reports as
// "breaks". What is NOT computed in-process is the OPT-IN for-whom
// contradiction (identity-hold + value-split, decided by the identity law over
// an observer) — that needs the real kernel engine and a declared observer.
// `terrainOf` only ever calls this when the caller sets `input.forWhom`; this
// tool never does, so the stand-in is never on the default path. When a
// for-whom contradiction is wanted, it must come from the live fold (the khora
// proxy), never from a guess here.
//
// Falsifying control: import this module's `CONTRADICTION_FOR_WHOM_AVAILABLE`
// and assert false whenever a result claims a for-whom contradiction.

export const CONTRADICTION_FOR_WHOM_AVAILABLE = false;

/** Stand-in for holodeck-contradiction.js :: contradictionForField.
 *  Returns `null` — a typed absence, never an invented contradiction. */
export function contradictionForField() {
  return null;
}
