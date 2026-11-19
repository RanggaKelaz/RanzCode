import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

const location = { directory, project: { id: "project", directory, canonical: directory } }
const session = {
  id: "ses_larpcode",
  title: "LarpCode session",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

function payload(autoJb: boolean) {
  return {
    ok: true,
    settings: { autoRotate: true, autoRotateMaxPerHour: 30, freeFallback: true, forceTor: false },
    sources: { autoRotate: "default", freeFallback: "default", forceTor: "default" },
    settingsPath: "C:\\data\\larpcode-settings.json",
    autoJb: { enabled: autoJb, custom: false, length: 123231, defaultLength: 123231, max: 750000 },
    dependencies: [
      {
        id: "warp",
        name: "Cloudflare WARP",
        installed: false,
        detail: "Cloudflare WARP CLI not found (warp-cli).",
        hint: "Install it from https://1.1.1.1/.",
      },
      { id: "tor", name: "Tor", installed: true, path: "C:\\tor\\tor.exe", detail: "installed", hint: "Optional." },
      {
        id: "impersonate",
        name: "curl-impersonate",
        installed: false,
        detail: "curl-impersonate binary not found.",
        hint: "Optional.",
      },
    ],
    proxy: { configured: false },
    missing: 2,
  }
}

async function render(state: string) {
  let autoJb = false
  const toggles: string[] = []
  const resets: string[] = []
  return createAppFixture({
    state,
    args: { sessionID: session.id },
    config: { animations: false, tabs: { mode: "on" } },
    fetch: (url) => {
      if (url.pathname === "/_larpcode/settings") return json(payload(autoJb))
      if (url.pathname === "/_larpcode/abliterated") {
        toggles.push(url.search)
        autoJb = url.searchParams.get("enabled") === "1"
        return json({ ok: true, enabled: autoJb })
      }
      if (url.pathname === "/_larpcode/reset-limits") {
        resets.push(url.search)
        return json({ ok: true, deep: false })
      }
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }],
        })
      return undefined
    },
  }).then((setup) => ({ setup, toggles, resets }))
}

test("the LarpCode menu opens from the top-right control and toggles Auto JB", async () => {
  await using state = await tmpdir()
  const rendered = await render(state.path)
  await using setup = rendered.setup

  await setup.waitForFrame((frame) => frame.includes("LarpCode session"))
  const marked = await setup.waitForFrame((frame) => frame.includes("⚙!"))
  const row = marked.split("\n").findIndex((line) => line.includes("⚙!"))
  const column = marked.split("\n")[row]!.indexOf("⚙!") + 1
  expect(row).toBe(0)

  await setup.mockMouse.click(column, row)
  const opened = await setup.waitForFrame((frame) => frame.includes("Dependencies missing"))
  expect(opened).toContain("2 missing")
  expect(opened).toContain("RanzCode settings")

  await setup.mockInput.typeText("Auto JB")
  await setup.waitForFrame((frame) => frame.includes("Auto JB") && !frame.includes("Dependencies missing"))
  setup.mockInput.pressEnter()
  await setup.waitFor(() => rendered.toggles.length === 1)
  expect(rendered.toggles).toEqual(["?enabled=1"])
  await setup.waitForFrame((frame) => frame.split("\n").some((line) => /Auto JB\s+on$/.test(line.trimEnd())))

  setup.mockInput.pressEscape()
  await setup.mockInput.typeText("/larpcode:settings")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Dependencies missing"))

  await setup.mockInput.typeText("Reset usage")
  await setup.waitForFrame((frame) => frame.includes("Reset usage limits"))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes("Sessions are kept"))
  setup.mockInput.pressEnter()
  await setup.waitFor(() => rendered.resets.length === 1)
  expect(rendered.resets).toEqual([""])
})
