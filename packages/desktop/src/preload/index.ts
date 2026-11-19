import { contextBridge, ipcRenderer, webUtils } from "electron"
import {
  DragCancelEvent,
  IpcTransportPort,
  WindowSnapshotChannel,
  storageSnapshotNames,
  type WindowSnapshot,
} from "../shared/ipc-transport"
import { windowBootstrapFromArguments } from "../shared/window-bootstrap"

ipcRenderer.on(IpcTransportPort, (event) => {
  const port = event.ports[0]

  if (port) window.postMessage(IpcTransportPort, "*", [port])
})

ipcRenderer.on(DragCancelEvent, () => window.dispatchEvent(new Event(DragCancelEvent)))

const bootstrap = windowBootstrapFromArguments(process.argv)

// Asked before the page runs, so the stores the shell reads are hydrated on the first render.
const snapshot: Promise<WindowSnapshot> = ipcRenderer
  .invoke(WindowSnapshotChannel, storageSnapshotNames(bootstrap.id))
  .catch(() => ({ storage: {} }))

// LarpCode narrow IPC surface for the updater toast + theme persistence.
// Each method is an explicit named function; no generic `invoke(channel,
// ...)` pass-through. The renderer must not be able to call arbitrary
// ipcMain channels from a hostile page.
//
// updateStatus / installUpdate talk to registerUpdater in
// service/updater.ts. onUpdateReady lets the renderer FAB subscribe to
// the push event the main process fires when a download finishes +
// verifies, so the toast can appear without polling.
type UpdateInfoPublic = { version: string }
const updateReadyListeners = new Set<(info: UpdateInfoPublic) => void>()
ipcRenderer.on("larpcode:update-ready", (_e, info: { version: string; notes?: string }) => {
  const scrubbed: UpdateInfoPublic = { version: info.version }
  updateReadyListeners.forEach((fn) => {
    try { fn(scrubbed) } catch { /* listener should not break the renderer */ }
  })
})

contextBridge.exposeInMainWorld("electron", {
  windowID: bootstrap.id,
  bootstrap,
  storageSnapshot: snapshot.then((snapshot) => snapshot.storage),
  plugins: snapshot.then((snapshot) => snapshot.plugins),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  larpcode: {
    // Theme persistence lives in the main process so it survives every
    // Electron relaunch (localStorage is per-session partition). Reads +
    // writes a tiny JSON at <data-dir>/opencode/theme.json via IPC.
    themeGet: () => ipcRenderer.invoke("larpcode:theme-get") as Promise<string | null>,
    themeSet: (id: string) => ipcRenderer.invoke("larpcode:theme-set", id) as Promise<{ ok: boolean }>,
    // Average luminance of the display behind this window, 0..1. Only the
    // Clear kit calls it, on a timer, to decide dark-on-bright glyphs.
    backdropLuminance: () => ipcRenderer.invoke("larpcode:backdrop-luminance") as Promise<number | null>,
    updateStatus: async (): Promise<{ ready: boolean; version?: string }> => {
      const r = await (ipcRenderer.invoke("larpcode:update-status") as Promise<{ ready: boolean; version?: string }>)
      return r?.ready ? { ready: true, version: r.version } : { ready: false }
    },
    installUpdate: () => ipcRenderer.invoke("larpcode:update-install") as Promise<{ ok: boolean; message?: string }>,
    // Native confirm dialog — the renderer's window.confirm() is suppressed
    // in sandboxed Chromium contexts under some Electron builds (the dialog
    // never appears and the call returns false), which read to users as
    // "clicking the pill does nothing". Routing through main's dialog
    // module guarantees a visible prompt every time.
    //
    // Deliberately no `notes` in the argument: main's dialog shows only the
    // version + a generic "will close and reopen" line.
    confirmUpdate: (info: { version: string }) =>
      ipcRenderer.invoke("larpcode:update-confirm", { version: info.version }) as Promise<{ ok: boolean }>,
    onUpdateReady: (fn: (info: UpdateInfoPublic) => void) => {
      updateReadyListeners.add(fn)
      return () => updateReadyListeners.delete(fn)
    },
    // Current app version baked into desktop/package.json at build time
    // (OPENCODE_VERSION in the pipeline). Used by the subtle top-middle
    // version badge so users can glance at what they're on.
    appVersion: () => ipcRenderer.invoke("larpcode:app-version") as Promise<string>,
    // The renderer never receives the destination URL. It asks main to open
    // the site; main owns the constant and validates nothing from the caller.
    openWebsite: () => ipcRenderer.invoke("larpcode:open-website") as Promise<{ ok: boolean }>,
  },
})
