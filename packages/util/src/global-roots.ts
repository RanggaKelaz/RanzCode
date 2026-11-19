import os from "os"
import path from "path"

declare const LARPCODE_CLI_DISTRIBUTION: string | undefined

const home = os.homedir()
// A standalone LarpCode CLI runs without the desktop launcher that normally
// sets XDG roots. Keep it out of OpenCode's ~/.local/share/opencode and use the
// same LarpCode-owned roots as the desktop app instead.
const standalone = typeof LARPCODE_CLI_DISTRIBUTION === "string"
const appData = process.env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : undefined)
const standaloneRoot =
  standalone && process.platform === "win32" && appData ? path.join(appData, "ai.larpcode.desktop", "xdg") : undefined
const fallback = (name: "data" | "cache" | "config" | "state", directory: string | undefined) =>
  standaloneRoot ? path.join(standaloneRoot, name) : directory
const data = process.env.XDG_DATA_HOME || fallback("data", home ? path.join(home, ".local", "share") : undefined)
const cache = process.env.XDG_CACHE_HOME || fallback("cache", home ? path.join(home, ".cache") : undefined)
const config = process.env.XDG_CONFIG_HOME || fallback("config", home ? path.join(home, ".config") : undefined)
const state = process.env.XDG_STATE_HOME || fallback("state", home ? path.join(home, ".local", "state") : undefined)

/** The XDG base directories that root opencode's global paths. */
export function roots(app: string) {
  const name = standalone && process.platform !== "win32" && app === "opencode" ? "larpcode" : app
  return {
    data: path.join(data!, name),
    cache: path.join(cache!, name),
    config: path.join(config!, name),
    state: path.join(state!, name),
    tmp: path.join(os.tmpdir(), name),
  }
}
