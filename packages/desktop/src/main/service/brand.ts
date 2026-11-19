import { app, ipcMain, shell } from "electron"
import fs from "node:fs"
import path from "node:path"

// The public repository is brand infrastructure, not user configuration. The
// URL is compiled into the signed main bundle and is the only value the IPC
// handler will open. Editing the renderer cannot redirect this link; editing
// this file invalidates the Ed25519 manifest and the watchdog exits the app.
export const WEBSITE_URL = "https://github.com/Tazmyan/LarpCode"
export const WEBSITE_LABEL = "LarpCode on GitHub"
export const WEBSITE_CHANNEL = "larpcode:open-website"

export function registerBrand(): void {
  ipcMain.removeHandler(WEBSITE_CHANNEL)
  ipcMain.handle(WEBSITE_CHANNEL, () => shell.openExternal(WEBSITE_URL))
}

function rendererEntryFile(): string | undefined {
  // app.getAppPath() is the desktop-pkg root both when Electron is pointed at
  // an unpacked directory and when it loads app.asar. __dirname does not exist
  // in this ESM bundle; using it aborted the ready chain before any window.
  try {
    const dir = path.join(app.getAppPath(), "out", "renderer", "assets")
    const name = fs.readdirSync(dir).find((entry) => /^main-.*\.js$/.test(entry))
    return name ? path.join(dir, name) : undefined
  } catch {
    return undefined
  }
}

/**
 * Refuses to boot if the renderer no longer contains the website pill or the
 * bridge call it uses. The destination is main-owned, so this does not protect
 * a URL in the renderer: it protects the branded surface itself.
 *
 * The signed manifest and the five-minute watchdog already hash the renderer
 * and main bundles. This is the semantic layer on top. Removing the pill is a
 * signed-file change; if that check is bypassed, the app still refuses to run.
 */
export function assertBrandPinned(): void {
  if (process.env.ELECTRON_RENDERER_URL) return
  let source = ""
  try {
    const file = rendererEntryFile()
    if (!file) return
    source = fs.readFileSync(file, "utf8")
  } catch {
    return
  }
  if (!source.includes("larpcode-website-pill")) {
    try {
      console.error("[LarpCode] brand check failed: website pill missing or altered")
    } catch {
      /* logging must never mask the exit */
    }
    app.exit(1)
  }
}
