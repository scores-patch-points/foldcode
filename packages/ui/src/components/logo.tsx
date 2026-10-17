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

// The openfold wordmark: opencode's block-letter "open" (muted) followed by the
// fold's block-letter "fold" (ink). Each letter keeps the block style's inset
// weak square, and the last four glyphs are the fold's own art.
const OpenfoldWordmarkPaths = () => (
  <>
    <path fill="var(--icon-weak-base)" d="M18 30H6V18H18V30Z" />
    <path fill="var(--icon-base)" d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" />
    <path fill="var(--icon-weak-base)" d="M48 30H36V18H48V30Z" />
    <path fill="var(--icon-base)" d="M36 30H48V12H36V30ZM54 36H36V42H30V6H54V36Z" />
    <path fill="var(--icon-weak-base)" d="M84 24V30H66V24H84Z" />
    <path fill="var(--icon-base)" d="M84 24H66V30H84V36H60V6H84V24ZM66 18H78V12H66V18Z" />
    <path fill="var(--icon-weak-base)" d="M108 36H96V18H108V36Z" />
    <path fill="var(--icon-base)" d="M108 12H96V36H90V6H108V12ZM114 36H108V12H114V36Z" />
    <path fill="var(--icon-weak-base)" d="M138 36H132V12H138V36Z" />
    <path fill="var(--icon-strong-base)" d="M138 36H132V0H138V36ZM138 6H126V0H138V6ZM138 18H120V12H138V18Z" />
    <path fill="var(--icon-weak-base)" d="M168 30H156V18H168V30Z" />
    <path fill="var(--icon-strong-base)" d="M168 12H156V30H168V12ZM174 36H150V6H174V36Z" />
    <path fill="var(--icon-weak-base)" d="M204 36H198V18H204V36Z" />
    <path fill="var(--icon-strong-base)" d="M204 36H198V0H204V36Z" />
    <path fill="var(--icon-weak-base)" d="M228 30H216V18H228V30Z" />
    <path fill="var(--icon-strong-base)" d="M228 12H216V30H228V12ZM234 36H210V6H228V0H234V36Z" />
  </>
)

export const Wordmark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-wordmark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 234 42"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <OpenfoldWordmarkPaths />
    </svg>
  )
}
