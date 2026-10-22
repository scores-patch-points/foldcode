// Each source is drawn in its own site's typesetting (title face, body face, colours), so a clipping reads as borrowed. Ported
// from The Fold (the-fold/fold-chat-present.js SITE_TYPE): known sites are listed; anything else gets a neutral reading style.

export type SiteType = {
  bg: string
  ink: string
  edge: string
  rule: string
  mark: string
  title: string
  titleWeight: string
  titleCase: string
  titleTrack: string
  body: string
  bodySize: string
  fav: string
  favBg: string
  favFg: string
}

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Lato,'Helvetica Neue',Helvetica,Arial,sans-serif"
const SERIF = "Georgia,'Times New Roman',serif"
const T = (o: Partial<SiteType>): SiteType => ({
  bg: "#ffffff",
  ink: "#202122",
  edge: "#e4e4e9",
  rule: "#e4e4e9",
  mark: "#fdf0b0",
  title: SERIF,
  titleWeight: "400",
  titleCase: "none",
  titleTrack: "0",
  body: SERIF,
  bodySize: "15px",
  fav: "",
  favBg: "#f1f1f4",
  favFg: "#44444e",
  ...o,
})

const SITE_TYPE: Record<string, SiteType> = {
  "wikipedia.org": T({ ink: "#202122", edge: "#a2a9b1", rule: "#a2a9b1", mark: "#fef6e7", title: "'Linux Libertine','Georgia','Times',serif", body: SANS, fav: "W", favBg: "#ffffff", favFg: "#202122" }),
  "britannica.com": T({ ink: "#1a1a1a", edge: "#dcdcdc", rule: "#1a1a1a", mark: "#e6f0fa", titleWeight: "700", bodySize: "16px", fav: "B", favBg: "#0f4c81", favFg: "#ffffff" }),
  "gutenberg.org": T({ bg: "#fffffa", ink: "#1c1c1c", edge: "#e2dfd2", rule: "#e2dfd2", mark: "#f3ead0", title: "'Times New Roman',Times,serif", titleCase: "uppercase", titleTrack: ".08em", body: "'Times New Roman',Times,serif", bodySize: "16px", fav: "G", favBg: "#fffffa", favFg: "#5a4a2a" }),
  "worldatlas.com": T({ ink: "#2b2b2b", mark: "#e3f0ff", title: "'Trebuchet MS','Helvetica Neue',Arial,sans-serif", titleWeight: "700", body: "'Trebuchet MS','Helvetica Neue',Arial,sans-serif", fav: "A", favBg: "#2a6fb0", favFg: "#ffffff" }),
  "history.com": T({ ink: "#111111", rule: "#111111", mark: "#f3f3f3", title: "'Arial Narrow','Helvetica Neue',Arial,sans-serif", titleWeight: "700", titleCase: "uppercase", bodySize: "16px", fav: "H", favBg: "#111111", favFg: "#ffffff" }),
  "sparknotes.com": T({ ink: "#1b1b1b", mark: "#e7f1ff", title: SANS, titleWeight: "800", body: SANS, fav: "S", favBg: "#0b2a4a", favFg: "#ffffff" }),
  "litcharts.com": T({ ink: "#222222", mark: "#e6f4f1", title: SANS, titleWeight: "700", body: SERIF, fav: "L", favBg: "#00a19a", favFg: "#ffffff" }),
  "bbc.co.uk": T({ ink: "#141414", rule: "#141414", mark: "#fbe9e9", title: SANS, titleWeight: "700", body: SANS, fav: "B", favBg: "#000000", favFg: "#ffffff" }),
  "bbc.com": T({ ink: "#141414", rule: "#141414", mark: "#fbe9e9", title: SANS, titleWeight: "700", body: SANS, fav: "B", favBg: "#000000", favFg: "#ffffff" }),
  "theguardian.com": T({ ink: "#121212", rule: "#dcdcdc", mark: "#fff4d6", title: "Georgia,serif", titleWeight: "700", body: "Georgia,serif", bodySize: "16px", fav: "G", favBg: "#052962", favFg: "#ffffff" }),
  "nytimes.com": T({ ink: "#121212", mark: "#f2f2f2", title: "Georgia,'Times New Roman',serif", titleWeight: "700", body: "Georgia,'Times New Roman',serif", bodySize: "16px", fav: "T", favBg: "#ffffff", favFg: "#121212" }),
  "ncbi.nlm.nih.gov": T({ ink: "#212121", mark: "#eaf2fb", title: SANS, titleWeight: "700", body: SANS, fav: "N", favBg: "#20558a", favFg: "#ffffff" }),
  "nationalgeographic.com": T({ ink: "#111111", mark: "#fff6cc", title: SANS, titleWeight: "800", body: SERIF, fav: "N", favBg: "#ffce00", favFg: "#000000" }),
}

// A workspace file is set as a file: monospace measure, the editor's paper.
const FILE_TYPE = T({ bg: "#fbfbfa", title: SANS, titleWeight: "600", body: "ui-monospace,SFMono-Regular,Menlo,monospace", bodySize: "13px" })

export const domainOf = (url?: string) => {
  if (!url) return ""
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

/** The typesetting for a source: a listed site (or any of its subdomains), a workspace file, else the neutral reading style. */
// A page the turn read is often named by its own URL (the door's passage name), with no separate url: the name is then the address.
const urlOf = (source: { name: string; url?: string }) => source.url || (/^https?:\/\//.test(source.name) ? source.name : undefined)

export function typeOf(source: { name: string; url?: string }): SiteType {
  const domain = domainOf(urlOf(source)) || (source.name.startsWith("wikipedia:") ? "wikipedia.org" : "")
  const listed = Object.keys(SITE_TYPE).find((key) => domain === key || domain.endsWith(`.${key}`))
  if (listed) return SITE_TYPE[listed]
  if (!domain && /\.\w{1,6}$/.test(source.name)) return { ...FILE_TYPE, fav: source.name.charAt(0).toUpperCase() }
  return T({ fav: (domain.charAt(0) || source.name.charAt(0) || "?").toUpperCase() })
}

/** How a source names itself: the site (or "Workspace file") and the page or file, as a reader would say it. A web page is named by
 *  its domain and the last part of its path ("harvesttotable.com · legumes are plants that"); a Wikipedia page by its article. */
export function siteOf(source: { name: string; url?: string; ref?: string }) {
  if (source.name.startsWith("wikipedia:")) return { site: "Wikipedia", title: source.name.replace(/^wikipedia:\s*/, "") }
  const url = urlOf(source)
  const domain = domainOf(url)
  if (domain) {
    const page = pageOf(url!)
    if (domain.endsWith("wikipedia.org")) return { site: "Wikipedia", title: page || domain }
    return { site: domain, title: page || (url === source.name ? domain : source.name) }
  }
  // a workspace file names itself by its base name (and the line the evidence sits on, when the ref carries one)
  const ref = source.ref && source.ref.startsWith(source.name) ? source.ref : source.name
  return { site: "Workspace file", title: ref.split("/").pop() ?? ref }
}

/** The last part of a URL's path, read as words: "/wiki/Lima_bean" → "Lima bean", "/legumes-are-plants/" → "legumes are plants". */
function pageOf(url: string) {
  const path = (() => {
    try {
      return new URL(url).pathname
    } catch {
      return ""
    }
  })()
  const last = path.split("/").filter(Boolean).pop() ?? ""
  return decodeURIComponent(last).replace(/\.[a-z]{2,5}$/i, "").replace(/[_-]+/g, " ").trim()
}
