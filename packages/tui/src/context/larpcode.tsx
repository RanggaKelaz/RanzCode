import { createEffect, on } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"
import { errorMessage } from "../util/error"

export type LarpcodeSettings = {
  autoRotate: boolean
  autoRotateMaxPerHour: number
  freeFallback: boolean
  forceTor: boolean
}

export type LarpcodeSettingKey = "autoRotate" | "freeFallback" | "forceTor"
export type LarpcodeSettingSource = "env" | "file" | "default"

export type LarpcodeDependency = {
  id: "warp" | "tor" | "impersonate"
  name: string
  installed: boolean
  path?: string
  detail: string
  hint: string
}

export type LarpcodePayload = {
  ok: boolean
  settings: LarpcodeSettings
  sources: Record<LarpcodeSettingKey, LarpcodeSettingSource>
  settingsPath: string
  autoJb: {
    enabled: boolean
    custom: boolean
    length: number
    defaultLength: number
    max: number
  }
  dependencies: LarpcodeDependency[]
  proxy: {
    configured: boolean
    value?: string
  }
  missing: number
}

type State = {
  status: "idle" | "loading" | "ready" | "error"
  data?: LarpcodePayload
  error?: string
  saving: boolean
}

// The TUI talks to the engine over HTTP for LarpCode-only state that is not in
// OpenCode's config schema. Reads are cached in this provider; every write
// returns the refreshed payload so the menu and the top-right warning marker
// update without a second round trip.
export const { use: useLarpcode, provider: LarpcodeProvider } = createSimpleContext({
  name: "Larpcode",
  init: () => {
    const client = useClient()
    const [store, setStore] = createStore<State>({ status: "idle", saving: false })

    async function call<T>(path: string, init?: RequestInit) {
      const base = client.url
      if (!base) throw new Error("The LarpCode server endpoint is unavailable")
      const headers = new Headers(client.headers)
      if (init?.body !== undefined) headers.set("content-type", "application/json")
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
      const response = await fetch(new URL(path, base), { ...init, headers })
      const body = (await response.json().catch(() => undefined)) as ({ ok?: boolean; error?: string } & T) | undefined
      if (!response.ok || !body || body.ok === false)
        throw new Error(body?.error ?? `LarpCode server returned ${response.status}`)
      return body
    }

    const refresh = async () => {
      if (!client.url) {
        setStore({ status: "error", error: "The LarpCode server endpoint is unavailable" })
        return
      }
      if (!store.data) setStore("status", "loading")
      try {
        const body = await call<LarpcodePayload>("/_larpcode/settings")
        setStore({ status: "ready", data: body, error: undefined })
      } catch (error) {
        setStore({ status: store.data ? "ready" : "error", error: errorMessage(error) })
      }
    }

    async function mutate<T>(work: () => Promise<T>) {
      if (store.saving) throw new Error("A LarpCode setting is already being saved")
      setStore("saving", true)
      try {
        return await work()
      } finally {
        setStore("saving", false)
      }
    }

    const update = (patch: Partial<LarpcodeSettings>) =>
      mutate(async () => {
        const body = await call<LarpcodePayload>("/_larpcode/settings", {
          method: "POST",
          body: JSON.stringify(patch),
        })
        setStore({ status: "ready", data: body, error: undefined })
        return body
      })

    const setAutoJb = (enabled: boolean) =>
      mutate(async () => {
        await call(`/_larpcode/abliterated?enabled=${enabled ? 1 : 0}`, { method: "POST" })
        await refresh()
      })

    const resetInstructions = () =>
      mutate(async () => {
        await call("/_larpcode/abliterated/content", {
          method: "POST",
          body: JSON.stringify({ reset: true }),
        })
        await refresh()
      })

    const resetLimits = () =>
      mutate(async () => {
        // A bare POST is the shallow reset: usage counters clear and sessions stay.
        await call("/_larpcode/reset-limits", { method: "POST" })
        await refresh()
      })

    // A managed service reconnect can replace the port and password, so refresh
    // against the endpoint that is current now instead of the one first seen.
    createEffect(
      on(
        () => client.url,
        (url) => {
          if (url) void refresh()
        },
      ),
    )

    return {
      data: () => store.data,
      status: () => store.status,
      error: () => store.error,
      saving: () => store.saving,
      /** Number of optional LarpCode helpers that are not installed. */
      missing: () => store.data?.missing ?? 0,
      refresh,
      update,
      setAutoJb,
      resetInstructions,
      resetLimits,
    }
  },
})
