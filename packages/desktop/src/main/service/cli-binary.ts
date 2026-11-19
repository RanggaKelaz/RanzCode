// LarpCode: locate the bundled opencode-cli[.exe] on disk.
//
// Lives in its own module because desktop-cli.ts and the sidecar probe spawn
// the binary to run the backend.

import { app } from "electron"
import { existsSync } from "node:fs"
import path from "node:path"

export function resolveCliBinary(): string {
  const names =
    process.platform === "win32" ? ["opencode-cli.exe", "opencode.exe"] : ["opencode-cli", "opencode"]

  const appPath = app.getAppPath()
  console.log("[larpcode-cli-binary] app.getAppPath():", appPath)

  // LarpCode installer layout: Inno Setup launches Electron with the
  // desktop-pkg folder as its app path, and the CLI lives inside
  // <app-path>/resources/<name>. Check this BEFORE process.resourcesPath,
  // because a non-packaged Electron (direct electron.exe) sets
  // resourcesPath to Electron's own resources dir, which does not contain
  // our CLI and makes every look-up miss.
  for (const n of names) {
    const bundled = path.join(appPath, "resources", n)
    if (existsSync(bundled)) {
      console.log("[larpcode-cli-binary] CLI found (installer layout):", bundled)
      return bundled
    }
  }

  // electron-builder / asar layout — the renamed binary sits at
  // process.resourcesPath/<exe>, next to the main app.asar.
  if (process.resourcesPath) {
    for (const n of names) {
      const packaged = path.join(process.resourcesPath, n)
      if (existsSync(packaged)) {
        console.log("[larpcode-cli-binary] CLI found (packaged resourcesPath):", packaged)
        return packaged
      }
    }
  }

  // Dev-tree / preview: walk up from app.getAppPath() looking for the
  // sibling cli package's dist/<arch>/bin/<name>.
  const archDir =
    process.platform === "win32"
      ? "cli-windows-x64"
      : process.platform === "darwin"
        ? process.arch === "arm64"
          ? "cli-darwin-arm64"
          : "cli-darwin-x64"
        : process.arch === "arm64"
          ? "cli-linux-arm64"
          : "cli-linux-x64"

  const bases = [
    appPath,
    path.join(appPath, ".."),
    path.join(appPath, "..", ".."),
    path.join(appPath, "..", "..", ".."),
    path.join(appPath, "..", "..", "..", ".."),
  ]
  for (const base of bases) {
    for (const n of names) {
      const c = path.resolve(base, "..", "cli", "dist", archDir, "bin", n)
      if (existsSync(c)) {
        console.log("[larpcode-cli-binary] CLI found (dev-tree):", c)
        return c
      }
    }
  }
  const fallback = path.join(appPath, "resources", names[0])
  console.log("[larpcode-cli-binary] all probes missed; falling through to:", fallback)
  return fallback
}
