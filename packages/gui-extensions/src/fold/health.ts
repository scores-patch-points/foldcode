// The fold door's health, as the app can see it from outside. The app grounds nothing itself: every
// `fold facing` row is computed by the door (khora's opencode doorway). With the door down the app
// fails open into plain opencode and grounds nothing, silently — this names WHICH invariant is
// broken, so the tally can say "offline" or "not a ground door" instead of showing a stale number.
//
// The door's contract is the handshake: GET /v1/hooks/opencode answers with the event names it
// serves, and a fold door lists "ground". A reachable port that does not answer that is not a door.

/** What a probe of the fold door observed. */
export type DoorProbe = {
  /** The contract answered at all (GET /v1/hooks/opencode returned JSON). */
  reachable: boolean
  /** The event names the door listed for itself, when it answered. */
  events?: ReadonlyArray<string>
  /** How many sense organs the door found on its box, when it reported them. */
  senses?: number
}

/** The door's state — the dominant reason grounding is limited, or `ok`. */
export type DoorState = "ok" | "text-only" | "down" | "incompatible"

/** The verdict: the state, and a one-line reason for diagnostics (not shown to the user). */
export type DoorHealth = { state: DoorState; detail: string }

/**
 * Classify a door probe.
 *
 * - `down` — nothing answered; the app is running as upstream.
 * - `incompatible` — something answered, but it does not serve `ground`: not a fold door.
 * - `text-only` — a fold door with no sense organs: it grounds text, but media is a typed gap.
 * - `ok` — a fold door with at least one sense; text and media both ground.
 *
 * @param probe - what the app observed (see {@link DoorProbe}).
 * @returns the verdict (see {@link DoorHealth}).
 */
export function doorHealth(probe: DoorProbe): DoorHealth {
  if (!probe.reachable) return { state: "down", detail: "no contract answer" }

  const events = probe.events ?? []

  if (!events.includes("ground")) return { state: "incompatible", detail: "the door does not serve ground" }

  const senses = probe.senses ?? 0

  if (senses < 1) return { state: "text-only", detail: "no sense organs found" }

  return { state: "ok", detail: `${senses} sense organ(s)` }
}
