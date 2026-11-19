import { createSignal, ErrorBoundary, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"

// LarpCode ambient background layer for animated themes. Rendered into
// <body> via a Portal so it can never affect the stacking / layout /
// clipping of vendor panels (file explorer, chat pane, dialogs). Behind
// everything with z-index: 0 + isolation: isolate — children can't
// escape this stacking context, siblings never see them.
//
// Only runs when the picked theme is in the animated set. Static themes
// render nothing (no DOM, no listeners, no cost). Switching themes is a
// Solid signal update + <Show> remount; no full reload needed.
//
// If any decoration throws during paint (rare but possible on exotic
// drivers / GPU memory pressure), the ErrorBoundary catches it and
// renders nothing — the app keeps working, the theme just loses its
// atmospheric layer. Better than a runtime that takes down the whole
// window.

function readTheme(): string {
  if (typeof document === "undefined") return ""
  return document.documentElement.getAttribute("data-theme") ?? ""
}

export function LarpcodeFxAmbient() {
  const [theme, setTheme] = createSignal<string>(readTheme())

  onMount(() => {
    const html = document.documentElement
    setTheme(html.getAttribute("data-theme") ?? "")
    const obs = new MutationObserver(() => {
      const t = html.getAttribute("data-theme") ?? ""
      if (t !== theme()) setTheme(t)
    })
    obs.observe(html, { attributes: true, attributeFilter: ["data-theme"] })
    onCleanup(() => obs.disconnect())
  })

  const kit = () => theme()

  return (
    <ErrorBoundary fallback={<></>}>
      <Portal mount={document.body}>
        <div
          class="Larp-ambient pointer-events-none fixed inset-0 overflow-hidden"
          style={{ "z-index": "0", isolation: "isolate" }}
          aria-hidden="true"
        >
          <Show when={kit() === "frost"}>
            <div class="Larp-orb Larp-orb-a" />
            <div class="Larp-orb Larp-orb-b" />
            <div class="Larp-orb Larp-orb-c" />
          </Show>
          <Show when={kit() === "porcelain"}>
            <div class="Larp-blob Larp-blob-a" />
            <div class="Larp-blob Larp-blob-b" />
            <div class="Larp-blob Larp-blob-c" />
          </Show>
          <Show when={kit() === "prism"}>
            <div class="Larp-aura Larp-aura-a" />
            <div class="Larp-aura Larp-aura-b" />
          </Show>
          <Show when={kit() === "vapor"}>
            <div class="Larp-sky" />
          </Show>
          <Show when={kit() === "obsidian"}>
            <div class="Larp-grain" />
          </Show>
        </div>
      </Portal>
    </ErrorBoundary>
  )
}
