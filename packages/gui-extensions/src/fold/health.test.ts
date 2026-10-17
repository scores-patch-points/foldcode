import { describe, expect, test } from "bun:test"
import { doorHealth, type DoorProbe, type DoorState } from "./health"

describe("door health", () => {
  const table: ReadonlyArray<{ name: string; probe: DoorProbe; state: DoorState }> = [
    { name: "nothing answered is down", probe: { reachable: false }, state: "down" },
    { name: "a port with no contract is not a door", probe: { reachable: true }, state: "incompatible" },
    { name: "a contract without ground is not a fold door", probe: { reachable: true, events: ["context", "surf"] }, state: "incompatible" },
    { name: "a fold door with no senses grounds text only", probe: { reachable: true, events: ["ground"], senses: 0 }, state: "text-only" },
    { name: "a fold door with senses is ok", probe: { reachable: true, events: ["context", "ground"], senses: 2 }, state: "ok" },
  ]

  for (const row of table) {
    test(row.name, () => {
      expect(doorHealth(row.probe).state).toBe(row.state)
    })
  }
})
