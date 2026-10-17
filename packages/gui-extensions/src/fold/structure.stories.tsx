import { structureOf, structureFromText } from "./structure-model"
import { StructureView } from "./structure"

// Storybook fixtures for the Structure panel — no door, no model: each view is the pure
// StructureView over fixed material, so the registers render deterministically. A break or a
// nomination is a CROSS-source finding, so those fixtures carry two sources; one source can
// only ever show a single-source notice.

export default { title: "App/Fold/Structure", id: "app-fold-structure" }

export const AnchoredBreak = {
  render: () => (
    <StructureView
      structure={structureOf([
        { id: "record-a", title: "record-a", text: "Metro Nashville searched 227 plates in August 2026. Flock Safety runs the cameras." },
        { id: "record-b", title: "record-b", text: "A second record says Metro Nashville searched 340 plates. Flock Safety runs the network." },
      ])}
    />
  ),
}

export const NominationOnly = {
  render: () => (
    <StructureView
      structure={structureOf([
        { id: "record-a", title: "record-a", text: "The library budget was 120 dollars this year." },
        { id: "record-b", title: "record-b", text: "Ticket sales reached 340 dollars last night." },
      ])}
    />
  ),
}

export const SingleSource = { render: () => <StructureView structure={structureFromText("Only one source says 5 plates.", "record")} /> }
