#!/usr/bin/env bun
// Downloads the pinned Electron runtime the Windows installer bundles.
//
// The installer copies a complete Electron distribution next to the desktop
// app. Reading it from a workspace `node_modules/electron` is fragile: Bun may
// hoist it, keep it only in its virtual store, or skip the package's install
// script, which leaves `dist/electron.exe` missing. The release build must not
// depend on that layout, so this script downloads the official Electron zip
// for the version pinned in `packages/desktop/package.json` and verifies it
// against the release's SHASUMS256.txt.
//
// Output: installer/deps/electron/electron.exe
//
// Override the version with LARPCODE_ELECTRON_VERSION. The installer is x64
// only (installer/LarpCode-Setup.iss allows x64compatible).
import { $ } from "bun"
import { createHash } from "node:crypto"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
process.chdir(root)

const desktop = (await Bun.file("packages/desktop/package.json").json()) as {
  devDependencies?: Record<string, string>
}
const version = process.env.LARPCODE_ELECTRON_VERSION ?? desktop.devDependencies?.electron
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`packages/desktop/package.json must pin a stable electron version, got ${version ?? "nothing"}`)
}

const arch = "x64"
const name = `electron-v${version}-win32-${arch}.zip`
const base = `https://github.com/electron/electron/releases/download/v${version}`
const cache = path.join(root, "installer", ".electron-download")
const archive = path.join(cache, name)
const target = path.join(root, "installer", "deps", "electron")
const stamp = path.join(target, "version")

async function exists(target: string) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

if (await exists(path.join(target, "electron.exe"))) {
  const staged = await readFile(stamp, "utf8").catch(() => "")
  if (staged.trim() === version) {
    console.log(`Electron ${version} already staged at installer/deps/electron`)
    process.exit(0)
  }
}

console.log(`Fetching Electron ${version} (win32-${arch})`)
const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text()
const line = sums.split(/\r?\n/).find((entry) => entry.trim().endsWith(name))
if (!line) throw new Error(`SHASUMS256.txt has no entry for ${name}`)
const expected = line.trim().split(/\s+/)[0]?.toLowerCase()
if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error(`invalid sha256 entry for ${name}: ${line}`)

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

let bytes: Uint8Array | undefined
if (await exists(archive)) {
  const cached = new Uint8Array(await Bun.file(archive).arrayBuffer())
  if (digest(cached) === expected) bytes = cached
}

if (!bytes) {
  const response = await fetch(`${base}/${name}`)
  if (!response.ok) throw new Error(`download failed ${response.status}: ${base}/${name}`)
  bytes = new Uint8Array(await response.arrayBuffer())
  const actual = digest(bytes)
  if (actual !== expected) throw new Error(`sha256 mismatch for ${name}: ${actual}`)
  await mkdir(cache, { recursive: true })
  await Bun.write(archive, bytes)
}

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await $`tar -xf ${archive} -C ${target}`
if (!(await exists(path.join(target, "electron.exe")))) {
  throw new Error(`electron.exe not found in ${name}`)
}
await writeFile(stamp, version + "\n")
console.log(`Electron ${version} staged at installer/deps/electron`)
