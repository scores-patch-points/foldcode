import { type ComponentProps } from "solid-js"
import { Wordmark as BlockWordmark } from "../../components/logo"

// The foldcode wordmark: the fold's block-letter "fold" followed by "code" in the brand face.
export function Wordmark(
  props: Pick<ComponentProps<"svg">, "class"> & { fade?: boolean; muted?: boolean; outline?: boolean },
) {
  return (
    <BlockWordmark
      class={[
        props.class,
        props.outline && "overflow-visible [&_path]:fill-none [&_path]:stroke-current [&_path]:[stroke-width:1] [&_path]:[vector-effect:non-scaling-stroke]",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  )
}
