import { Logo } from "@opencode/ui/logo"
import "./wordmark.css"

export function NewSessionWordmark() {
  return (
    <div
      data-component="new-session-wordmark"
      aria-hidden="true"
      class="pointer-events-none mx-auto w-full max-w-[720px] text-v2-background-bg-inverse"
    >
      <div data-slot="wordmark-reveal" class="relative mx-auto w-2/5 max-w-[260px]">
        <Logo class="block w-full opacity-[0.16]" />
        <Logo class="wordmark-shimmer absolute inset-0 w-full" />
      </div>
    </div>
  )
}
