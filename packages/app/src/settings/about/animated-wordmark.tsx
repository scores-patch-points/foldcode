import { createEffect, For, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"

// The brand wordmark (ui/logo): "fold" in IM Fell English Italic, then "code" in pixel letters. When the
// page opens it levitates (ui/logo.css) and the pixel half scrambles; "fold" never scrambles, so the name
// is always readable.
const target = ["c", "o", "d", "e"] as const

const choices = ["c", "o", "d", "e"] as const

export function AnimatedWordmark(props: { active: boolean }) {
  const [state, setState] = createStore({ letters: [...target] })
  const timers = new Set<ReturnType<typeof setTimeout>>()

  createEffect(
    on(
      () => props.active,
      (active) => {
        timers.forEach(clearTimeout)
        timers.clear()

        if (!active || matchMedia("(prefers-reduced-motion: reduce)").matches) {
          setState("letters", [...target])

          return
        }

        const starts = target.map(() => choices[Math.floor(Math.random() * choices.length)])
        const settles = target.map(() => 6 + Math.floor(Math.random() * 8))
        const last = Math.max(...settles)
        setState("letters", starts)

        Array.from({ length: last }, (_, index) => index + 1).forEach((tick) => {
          const timer = setTimeout(() => {
            setState(
              "letters",
              target.map((letter, index) =>
                tick >= settles[index] ? letter : choices[Math.floor(Math.random() * choices.length)],
              ),
            )
            timers.delete(timer)
          }, tick * 75)

          timers.add(timer)
        })
      },
    ),
  )

  onCleanup(() => timers.forEach(clearTimeout))

  return (
    <svg
      data-component="logo-wordmark"
      classList={{ "settings-about-wordmark": true, "wordmark-levitate": props.active }}
      viewBox="0 -2 206 54"
      aria-hidden="true"
    >
      <defs>
        <symbol id="settings-about-letter-o" viewBox="0 0 24 42">
          <path d="M18 12H6V30H18V12ZM24 36H0V6H24V36Z" />
        </symbol>
        <symbol id="settings-about-letter-e" viewBox="0 0 24 42">
          <path d="M24 24H6V30H24V36H0V6H24V24ZM6 18H18V12H6V18Z" />
        </symbol>
        <symbol id="settings-about-letter-c" viewBox="0 0 24 42">
          <path d="M24 12H6V30H24V36H0V6H24V12Z" />
        </symbol>
        <symbol id="settings-about-letter-d" viewBox="0 0 24 42">
          <path d="M18 12H6V30H18V12ZM24 36H0V6H18V0H24V36Z" />
        </symbol>
      </defs>
      <text
        data-slot="wordmark-fold"
        x="11"
        y="36"
        font-family="'IM Fell English', 'Iowan Old Style', Georgia, serif"
        font-style="italic"
        font-size="50"
      >
        fold
      </text>
      <g data-slot="wordmark-code" class="settings-about-code">
        <For each={state.letters}>
          {(letter, index) => (
            <use href={`#settings-about-letter-${letter}`} x={90 + index() * 30} width="24" height="42" />
          )}
        </For>
      </g>
    </svg>
  )
}
