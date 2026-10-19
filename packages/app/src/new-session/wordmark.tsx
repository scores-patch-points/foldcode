import { Wordmark } from "@opencode/ui/logo"
import "./wordmark.css"

export function NewSessionWordmark() {
  return (
    <div
      data-component="new-session-wordmark"
      aria-hidden="true"
      class="pointer-events-none mx-auto w-full max-w-[720px] text-v2-background-bg-inverse"
    >
      <div data-slot="wordmark-reveal" class="relative mx-auto w-4/5">
        <Wordmark class="wordmark-levitate block aspect-[206/54] w-full opacity-[0.55]" />
        <Wordmark class="wordmark-levitate wordmark-shimmer absolute inset-0 aspect-[206/54] w-full" />
      </div>
    </div>
  )
}
