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
