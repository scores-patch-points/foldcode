import { Schema } from "effect"
import { Extension, Store } from "../sdk"
import { Browser } from "../browser/contract"
import { FileTree } from "../file/contract"
import en from "./i18n/en"

// The savings tally's per-window state: whether it is hidden, and the meter baseline a reset zeroes against.
const TallyState = Schema.Struct({
  hidden: Schema.Boolean,
  baseline: Schema.Struct({
    tokens: Schema.Number,
    usd: Schema.Number,
  }),
})

export default Extension.define({
  id: "fold",
  // Optional: the desktop browser pane, used to open the REAL fold and holodeck pages (the actual embeds).
  // The file extension's tree draws the workspace worktree the panel opens on.
  uses: { browser: Browser, tree: FileTree },
  stores: {
    tally: Store.global(TallyState, { hidden: false, baseline: { tokens: 0, usd: 0 } }),
  },
  i18n: { en },
})
