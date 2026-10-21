import { GroundHover } from "./fold-ground-view"
import { readGround } from "./fold-ground"

const paragraphs = [
  "Marie Curie was a Polish and naturalised-French physicist and chemist. Curie discovered radium in 1898 with her husband Pierre. She won a Nobel Prize in 1911 for physics.",
  "The element radium glows faintly blue in the dark. It was used in luminous paint for watch dials until the 1960s. Therefore it is safe to handle in small amounts.",
  "Her notebooks are still radioactive and are kept in lead-lined boxes at the Bibliothèque nationale de France.",
]

const claim = (standing: string, text: string, extra: Record<string, unknown> = {}) => ({ standing, text, ...extra })
const mat = (text: string, ref: string) => ({ text, ref, source: "curie.md" })
const WIKI = { name: "wikipedia: Marie Curie", url: "https://en.wikipedia.org/wiki/Marie_Curie" }
const wiki = (text: string) => ({ text, ref: "Q7186", source: WIKI.name, url: WIKI.url })

const sources = [
  {
    name: "curie.md",
    text: [
      "# Marie Curie",
      "Marie Salomea Skłodowska-Curie was a Polish and naturalised-French physicist and chemist. She conducted pioneering research on radioactivity.",
      "She was the first woman to win a Nobel Prize, the first person to win a Nobel Prize twice, and the only person to win a Nobel Prize in two scientific fields.",
      "## Discoveries",
      "In July 1898 the Curies published a joint paper announcing the existence of an element they named polonium. In 1898 the Curies announced the discovery of radium. Isolating it took four more years of work in a converted shed.",
      "## Later uses",
      "Radium paint was used on watch dials and instruments until the 1960s. Many of the workers who applied it later fell ill.",
      "## Legacy",
      "Her papers are kept in lead-lined boxes at the Bibliothèque nationale de France. Visitors must sign a liability waiver and wear protective clothing.",
    ].join("\n"),
  },
  {
    ...WIKI,
    text: [
      "Marie Curie (7 November 1867 – 4 July 1934) was a Polish and naturalised-French physicist and chemist.",
      "## Nobel Prizes",
      "In 1903 she shared the Nobel Prize in Physics with Pierre Curie and Henri Becquerel. In 1911 she was awarded the 1911 Nobel Prize in Chemistry for the discovery of polonium and radium. She is the only person to win Nobel Prizes in two different sciences.",
      "## Death",
      "She died in 1934 of aplastic anaemia, likely from exposure to radiation in the course of her research.",
    ].join("\n"),
  },
]

const ground = (claims: ReturnType<typeof claim>[], revises: Array<{ was: string; now: string | null }> = []) =>
  readGround({
    notice: "fold-ground",
    ground: {
      step: {
        grounded: [],
        profile: {
          kind: "answer",
          words: 84,
          counts: Object.fromEntries(
            ["supported", "contradicted", "unsupported", "argument"].map((s) => [s, claims.filter((c) => c.standing === s).length]),
          ),
          rests: [
            { source: "curie.md", n: 4 },
            { source: WIKI.name, n: 1 },
          ],
          sources,
          claims,
          revises,
        },
      },
    },
  })!

const supported = [
  claim("supported", "Marie Curie was a Polish and naturalised-French physicist and chemist.", {
    evidence: mat("Marie Salomea Skłodowska-Curie was a Polish and naturalised-French physicist and chemist.", "curie.md#1"),
  }),
  claim("supported", "Curie discovered radium in 1898 with her husband Pierre.", {
    evidence: mat("In 1898 the Curies announced the discovery of radium.", "curie.md#9"),
  }),
  claim("supported", "It was used in luminous paint for watch dials until the 1960s.", {
    evidence: mat("Radium paint was used on watch dials and instruments until the 1960s.", "curie.md#31"),
  }),
  claim("supported", "Her notebooks are still radioactive and are kept in lead-lined boxes at the Bibliothèque nationale de France.", {
    evidence: mat("Her papers are kept in lead-lined boxes at the Bibliothèque nationale de France.", "curie.md#58"),
  }),
]

const contested = [
  supported[0],
  supported[1],
  claim("contradicted", "She won a Nobel Prize in 1911 for physics.", {
    why: "The source gives the 1911 prize as Chemistry, not Physics.",
    evidence: wiki("In 1911 she was awarded the 1911 Nobel Prize in Chemistry for the discovery of polonium and radium."),
  }),
  claim("unsupported", "The element radium glows faintly blue in the dark.", {
    why: "Nothing read this turn states this.",
    searched: ["workspace", "Wikipedia"],
  }),
  supported[2],
  claim("argument", "Therefore it is safe to handle in small amounts."),
  supported[3],
]

const Answer = () => (
  <div class="flex flex-col gap-3 text-14-regular leading-text-base">
    {paragraphs.map((p) => (
      <p>{p}</p>
    ))}
  </div>
)

const revised = [
  supported[0],
  supported[1],
  claim("supported", "She won the 1911 Nobel Prize in Chemistry.", {
    evidence: wiki("In 1911 she was awarded the 1911 Nobel Prize in Chemistry for the discovery of polonium and radium."),
  }),
]

const contestedView = ground(contested)
const supportedView = ground(supported)
const revisedView = ground(revised, [{ was: "She won a Nobel Prize in 1911 for physics.", now: "She won the 1911 Nobel Prize in Chemistry." }])

export default { title: "OpenCode/Fold/Ground facing page" }

export const Contested = () => (
  <div style={{ padding: "24px", "max-width": "860px" }}>
    <GroundHover view={contestedView} onRevise={(unit) => console.log("revise", unit.title)}>
      <Answer />
    </GroundHover>
  </div>
)

export const Uncontested = () => (
  <div style={{ padding: "24px", "max-width": "860px" }}>
    <GroundHover view={supportedView}>
      <Answer />
    </GroundHover>
  </div>
)

export const Revised = () => (
  <div style={{ padding: "24px", "max-width": "860px" }}>
    <GroundHover view={revisedView}>
      <p class="text-14-regular leading-text-base">
        Marie Curie was a Polish and naturalised-French physicist and chemist. Curie discovered radium in 1898 with her husband
        Pierre. She won the 1911 Nobel Prize in Chemistry.
      </p>
    </GroundHover>
  </div>
)
