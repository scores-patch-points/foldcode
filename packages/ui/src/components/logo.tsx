import { type ComponentProps } from "solid-js"

// The fold's icon: Euclid I.47, the squares on the sides of a right triangle.
// The app wears the fold's mark (see brand/); violet lives in the brand mark,
// the in-app mark rides the theme's icon tokens like the mono mark variants.
const MarkPaths = () => (
  <>
    <path data-slot="logo-mark-shadow" d="M8 25.2H22.4V39.6H8Z" fill="var(--icon-weak-base)" />
    <path data-slot="logo-mark-inner" d="M22.4 25.2 41.6 39.6 22.4 39.6Z" fill="var(--icon-weak-base)" />
    <path data-slot="logo-mark-square" d="M22.4 39.6H41.6V58.8H22.4Z" fill="var(--icon-strong-base)" />
    <path data-slot="logo-mark-triangle" d="M22.4 25.2 36.8 6 56 20.4 41.6 39.6Z" fill="var(--icon-strong-base)" />
  </>
)

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <MarkPaths />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <MarkPaths />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <MarkPaths />
    </svg>
  )
}

// The foldcode wordmark: "fold" set in IM Fell English Italic (the hand: an old letterpress face, its "f"
// tail dropping below the line), full ink, followed by "code" in opencode's own pixel letters (the 6-unit
// grid of upstream's wordmark), muted. The counters stay open: upstream's filled insets turn the small
// letters into solid blocks. Add the class `wordmark-levitate` for the reveal (logo.css).
const FoldcodeWordmarkPaths = () => (
  <>
    <text
      data-slot="wordmark-fold"
      x="11"
      y="36"
      font-family="'IM Fell English', 'Iowan Old Style', Georgia, serif"
      font-style="italic"
      font-size="50"
      fill="var(--icon-strong-base)"
    >
      fold
    </text>
    <g data-slot="wordmark-code" transform="translate(-30 0)">
      <path fill="var(--wordmark-code, var(--icon-base))" d="M144 12H126V30H144V36H120V6H144V12Z" />
      <path fill="var(--wordmark-code, var(--icon-base))" d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z" />
      <path fill="var(--wordmark-code, var(--icon-base))" d="M198 12H186V30H198V12ZM204 36H180V6H198V0H204V36Z" />
      <path fill="var(--wordmark-code, var(--icon-base))" d="M216 12V18H228V12H216ZM234 24H216V30H234V36H210V6H234V24Z" />
    </g>
  </>
)

export const Wordmark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-wordmark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 -2 206 54"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <FoldcodeWordmarkPaths />
    </svg>
  )
}
