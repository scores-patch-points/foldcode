import { createUniqueId, type ComponentProps } from "solid-js"

export function Wordmark(
  props: Pick<ComponentProps<"svg">, "class"> & { fade?: boolean; muted?: boolean; outline?: boolean },
) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      classList={{
        [props.class ?? ""]: !!props.class,
        "overflow-visible [&_path]:[vector-effect:non-scaling-stroke]": props.outline,
      }}
    >
      <g opacity={props.muted === false ? 1 : 0.6} class="[[data-color-scheme=dark]_&]:opacity-100">
        <g mask={props.fade === false ? undefined : `url(#${mask})`}>
          <g
            opacity={props.muted === false ? 1 : 0.16 * 0.7}
            fill={props.outline ? "none" : "currentColor"}
            stroke={props.outline ? "currentColor" : undefined}
            stroke-width={props.outline ? 1 : undefined}
          >
            <path pathLength={props.outline ? 1 : undefined} d="M8 25.2H22.4V39.6H8Z" />
            <path pathLength={props.outline ? 1 : undefined} d="M22.4 25.2 41.6 39.6 22.4 39.6Z" />
            <path pathLength={props.outline ? 1 : undefined} d="M22.4 39.6H41.6V58.8H22.4Z" />
            <path pathLength={props.outline ? 1 : undefined} d="M22.4 25.2 36.8 6 56 20.4 41.6 39.6Z" />
          </g>
        </g>
      </g>
      <defs>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
          <rect width="64" height="64" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="20" y1="34" x2="20" y2="64" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
