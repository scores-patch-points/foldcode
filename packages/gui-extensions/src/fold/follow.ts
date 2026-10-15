// Keep a scrolling pane on its newest content, unless the person is scrolling. The same rule the session timeline
// uses: following is on until the person moves away from the bottom, and comes back on when they return to it.

const NEAR = 24
const QUIET_MS = 1500

/** Pure rule: follow when pinned to the bottom and the person is not actively scrolling. */
export const shouldFollow = (input: { distanceFromBottom: number; activeSinceMs: number }) =>
  input.distanceFromBottom <= NEAR && input.activeSinceMs > QUIET_MS

export function followBottom(element: HTMLElement): () => void {
  let activeAt = 0
  let pinned = true
  const quiet = () => Date.now() - activeAt > QUIET_MS
  const distance = () => element.scrollHeight - element.clientHeight - element.scrollTop
  const active = () => {
    activeAt = Date.now()
  }
  const onScroll = () => {
    pinned = distance() <= NEAR
  }
  const settle = () => {
    if (pinned && quiet()) element.scrollTop = element.scrollHeight
  }
  const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const
  events.forEach((name) => element.addEventListener(name, active, { passive: true }))
  element.addEventListener("scroll", onScroll, { passive: true })
  const resize = new ResizeObserver(settle)
  resize.observe(element)
  const mutate = new MutationObserver(settle)
  mutate.observe(element, { childList: true, subtree: true, characterData: true })
  settle()
  return () => {
    events.forEach((name) => element.removeEventListener(name, active))
    element.removeEventListener("scroll", onScroll)
    resize.disconnect()
    mutate.disconnect()
  }
}
