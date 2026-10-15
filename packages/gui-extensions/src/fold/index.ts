import { Extension } from "../sdk"
import { Browser } from "../browser/contract"
import en from "./i18n/en"

export default Extension.define({
  id: "fold",
  // Optional: the desktop browser pane, used to open the REAL fold and holodeck pages (the actual embeds).
  uses: { browser: Browser },
  i18n: { en },
})
