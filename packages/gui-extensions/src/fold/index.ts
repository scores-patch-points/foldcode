import { Extension } from "../sdk"
import { Browser } from "../browser/contract"
import { FileTree } from "../file/contract"
import en from "./i18n/en"

export default Extension.define({
  id: "fold",
  // Optional: the desktop browser pane, used to open the REAL fold and holodeck pages (the actual embeds).
  // The file extension's tree draws the workspace worktree the panel opens on.
  uses: { browser: Browser, tree: FileTree },
  i18n: { en },
})
