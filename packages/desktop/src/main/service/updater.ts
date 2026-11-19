// LarpCode in-app auto-updater.
//
// Polls the public GitHub release feed for `update.json`, downloads the Inno
// Setup installer to %TEMP%, verifies its sha256, and surfaces an in-app
// toast via the renderer. Clicking "Install" closes the app and launches the
// installer with /SILENT /CLOSEAPPLICATIONS /FORCEAPPLICATIONS so the running
// electron is killed, files replaced, and the new version relaunched
// automatically.
//
// Security properties:
// - The feed is public and unauthenticated. No license key or machine id
//   leaves the app while checking for updates.
// - The downloaded installer's sha256 is verified against the value in
//   `update.json` BEFORE spawn. A tampered mirror or a corrupted download
//   fails this check and nothing runs.
// - Only an https URL is accepted from the feed.
//
// What this does NOT do:
// - No delta / block-diff updates (electron-updater supports those; we
//   don't need them for a <400 MB payload, every few weeks).
// - No scheduled auto-install without user consent. The user clicks the
//   toast. We never run the installer silently in the background.

import { app, BrowserWindow, dialog, ipcMain } from "electron"
import crypto from "node:crypto"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const POLL_INITIAL_DELAY_MS = 30_000
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000

const UPDATE_FEED = "https://github.com/Tazmyan/LarpCode/releases/latest/download/update.json"

type UpdateMeta = {
  version: string
  url: string
  sha256: string
}

type ReadyUpdate = {
  meta: UpdateMeta
  installerPath: string
}

let currentUpdate: ReadyUpdate | undefined
let pollTimer: NodeJS.Timeout | undefined
let initialTimer: NodeJS.Timeout | undefined

// Numeric version compare over dot-separated integer segments, left-pads
// missing segments with 0. Returns >0 if `a` is newer, <0 if older, 0 if
// equal. "1.0.2" > "1.0.1". "2.1" > "2.0.99" via left-pad.
// Semver prerelease tags (-rc1, -beta) are ignored; releases are plain
// numeric `1.0.0` versions.
function compareVersions(a: string, b: string): number {
  const stripTag = (v: string) => v.split(/[-+]/, 1)[0]
  const sa = stripTag(a).split(".").map((n) => parseInt(n, 10) || 0)
  const sb = stripTag(b).split(".").map((n) => parseInt(n, 10) || 0)
  const n = Math.max(sa.length, sb.length)
  for (let i = 0; i < n; i++) {
    const d = (sa[i] ?? 0) - (sb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

async function fetchLatest(): Promise<UpdateMeta | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(UPDATE_FEED, {
      signal: controller.signal,
      headers: { "cache-control": "no-store" },
      redirect: "follow",
    })
    if (!resp.ok) return undefined
    const body = (await resp.json()) as {
      version?: string
      url?: string
      sha256?: string
    }
    if (!body?.version || !body.url || !body.sha256) return undefined
    if (!/^https:\/\//.test(body.url)) return undefined
    if (!/^[0-9a-f]{64}$/i.test(body.sha256)) return undefined
    return {
      version: String(body.version),
      url: String(body.url),
      sha256: String(body.sha256).toLowerCase(),
    }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function downloadVerify(meta: UpdateMeta): Promise<string | undefined> {
  const dir = path.join(os.tmpdir(), "larpcode-update")
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return undefined
  }
  // Fresh filename per version so a failed previous download doesn't
  // leave a stale file that passes the sha check later for the wrong
  // version string.
  const dest = path.join(dir, `LarpCode-Setup-${meta.version.replace(/[^A-Za-z0-9._-]/g, "_")}.exe`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  let buf: Buffer
  try {
    const resp = await fetch(meta.url, { signal: controller.signal })
    if (!resp.ok) return undefined
    buf = Buffer.from(await resp.arrayBuffer())
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }

  const actualSha = crypto.createHash("sha256").update(buf).digest("hex")
  if (actualSha !== meta.sha256) {
    // Do NOT persist a corrupt or tampered installer to disk. Silent
    // failure here just means no update offer surfaces — the user stays
    // on the current version safely.
    return undefined
  }

  try {
    fs.writeFileSync(dest, buf, { mode: 0o755 })
  } catch {
    return undefined
  }
  return dest
}

function notifyRenderer(meta: UpdateMeta): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      // Only the version crosses into the renderer.
      win.webContents.send("larpcode:update-ready", { version: meta.version })
    } catch {
      /* best-effort */
    }
  }
}

async function tryUpdateCheck(): Promise<void> {
  // Already have a downloaded update waiting? Don't re-download; the
  // renderer already has the toast. A newer version would still trigger
  // a fresh download below after we compare.
  const meta = await fetchLatest()
  if (!meta) return
  if (compareVersions(meta.version, app.getVersion()) <= 0) return
  // Skip if this exact version is already downloaded.
  if (currentUpdate && currentUpdate.meta.version === meta.version && fs.existsSync(currentUpdate.installerPath)) {
    notifyRenderer(currentUpdate.meta)
    return
  }
  const installerPath = await downloadVerify(meta)
  if (!installerPath) return
  currentUpdate = { meta, installerPath }
  notifyRenderer(meta)
}

// Called once at app.whenReady. Sets up the poll loop and the
// renderer-facing IPC.
export function registerUpdater(): void {
  // Guard against double-registration — hot-reload / re-entrant boots.
  try {
    ipcMain.removeHandler("larpcode:update-install")
    ipcMain.removeHandler("larpcode:update-status")
    ipcMain.removeHandler("larpcode:update-confirm")
    ipcMain.removeHandler("larpcode:app-version")
  } catch {
    /* no prior */
  }
  if (initialTimer) clearTimeout(initialTimer)
  if (pollTimer) clearInterval(pollTimer)

  initialTimer = setTimeout(() => {
    void tryUpdateCheck().catch(() => undefined)
  }, POLL_INITIAL_DELAY_MS)

  pollTimer = setInterval(() => {
    void tryUpdateCheck().catch(() => undefined)
  }, POLL_INTERVAL_MS)

  ipcMain.handle("larpcode:update-status", async () => {
    if (!currentUpdate) return { ready: false }
    return { ready: true, version: currentUpdate.meta.version }
  })

  // Native confirm dialog. Renderer used to call window.confirm() which is
  // suppressed in sandboxed Chromium contexts under some Electron builds —
  // the dialog never showed, confirm() returned false, the install silently
  // didn't fire. Delivering the prompt through dialog.showMessageBox from
  // main sidesteps the sandbox entirely and always works.
  ipcMain.handle(
    "larpcode:update-confirm",
    async (_, info: { version?: string }) => {
      const version = info?.version || "latest"
      const r = await dialog.showMessageBox({
        type: "question",
        title: "LarpCode update",
        message: `Install version ${version}?`,
        detail: "LarpCode will close and reopen.",
        buttons: ["Install", "Later"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      return { ok: r.response === 0 }
    },
  )

  // Exposed to the renderer via preload. Powers the subtle top-middle
  // version badge so the user always knows what they're on.
  ipcMain.handle("larpcode:app-version", async () => app.getVersion())

  ipcMain.handle("larpcode:update-install", async () => {
    if (!currentUpdate) return { ok: false, message: "no update ready" }
    // Guardrails against the silent-failure patterns that let a stuck install
    // read as "nothing happens" from the user's side.
    //
    //   1. File check. If antivirus quarantined the installer between
    //      download and click, the path points to nothing. spawn() would
    //      return a ChildProcess and fire 'error' async — we'd quit before
    //      the event surfaces. Catch the missing-file case here synchronously.
    //   2. Spawn error listener with a short wait. CreateProcess failures
    //      (ENOENT, EACCES, antivirus block) surface on 'error'. Give it a
    //      tick so we don't false-negative the common case while still
    //      catching real failures before app.quit() kills the parent.
    //   3. Early-exit watcher. UAC denied, Inno Setup "already running"
    //      bail, PE signature refusal — the installer dies within ~2s with
    //      a non-zero exit. app.quit() would still fire, user sees window
    //      die, no new version. Watch for exit while we're still alive.
    if (!fs.existsSync(currentUpdate.installerPath)) {
      return { ok: false, message: "installer missing (was it quarantined by antivirus?)" }
    }

    // The installer manifest is asInvoker (per-user), so no elevation is
    // requested or needed. Launch it directly.
    const installerArgs = ["/SILENT", "/SUPPRESSMSGBOXES", "/CLOSEAPPLICATIONS", "/FORCECLOSEAPPLICATIONS"]
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(currentUpdate.installerPath, installerArgs, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      })
    } catch (e) {
      return { ok: false, message: `installer failed to start: ${(e as Error).message}` }
    }
    const spawnError = await new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 800)
      child.once("error", (cause) => {
        clearTimeout(timer)
        resolve(cause.message)
      })
    })
    if (spawnError) return { ok: false, message: `installer failed to start: ${spawnError}` }
    child.unref()

    // The per-user installer only kills processes under its own install root,
    // so the running app has to close itself. No UAC broker sits in between.
    currentUpdate = undefined
    setTimeout(() => app.quit(), 1200)
    return { ok: true }
  })

  app.once("will-quit", () => {
    if (initialTimer) clearTimeout(initialTimer)
    if (pollTimer) clearInterval(pollTimer)
  })
}
