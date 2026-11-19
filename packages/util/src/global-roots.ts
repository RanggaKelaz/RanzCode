import os from "os"
import path from "path"

declare const LARPCODE_CLI_DISTRIBUTION: string | undefined

const home = os.homedir()
// A standalone RanzCode CLI shares OpenCode's standard data and config roots.
const standalone = typeof LARPCODE_CLI_DISTRIBUTION === "string"
const appData = process.env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : undefined)
const standaloneRoot =
  standalone && process.platform === "win32" && appData ? path.join(appData, "ai.opencode.desktop", "xdg") : undefined
const fallback = (name: "data" | "cache" | "config" | "state", directory: string | undefined) =>
  standaloneRoot ? path.join(standaloneRoot, name) : directory
const data = process.env.XDG_DATA_HOME || fallback("data", home ? path.join(home, ".local", "share") : undefined)
const cache = process.env.XDG_CACHE_HOME || fallback("cache", home ? path.join(home, ".cache") : undefined)
const config = process.env.XDG_CONFIG_HOME || fallback("config", home ? path.join(home, ".config") : undefined)
const state = process.env.XDG_STATE_HOME || fallback("state", home ? path.join(home, ".local", "state") : undefined)

/** The XDG base directories that root opencode's global paths. */
export function roots(app: string) {
  return {
    data: path.join(data!, app),
    cache: path.join(cache!, app),
    config: path.join(config!, app),
    state: path.join(state!, app),
    tmp: path.join(os.tmpdir(), app),
  }
}
