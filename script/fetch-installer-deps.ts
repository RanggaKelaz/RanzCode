#!/usr/bin/env bun
// Downloads the two third-party Windows binaries the installer bundles.
//
// Optional overrides:
//   TOR_EXPERT_URL              URL of a Tor Expert Bundle .tar.gz
//   CURL_IMPERSONATE_URL        URL of a lexiforest/curl-impersonate Windows .tar.gz/.zip
//   TOR_EXPERT_SHA256           expected sha256 for an overridden Tor archive
//   CURL_IMPERSONATE_SHA256     expected sha256 for an overridden curl archive
//
// The defaults below pin the current stable Windows x64 builds so a tagged
// release works without repository configuration. The release workflow can
// override them from repository variables when a newer binary is reviewed.
import { $ } from "bun"
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
process.chdir(root)

const DEFAULT_TOR_URL =
  "https://dist.torproject.org/torbrowser/16.0.1/tor-expert-bundle-windows-x86_64-16.0.1.tar.gz"
const DEFAULT_TOR_SHA256 = "9eed3c3ff1fe43df034ce360196c9ec95472560d77ff55614d0cd5120edea27b"
const DEFAULT_CURL_URL =
  "https://github.com/lexiforest/curl-impersonate/releases/download/v2.3.2/curl-impersonate-v2.3.2.x86_64-win32.tar.gz"
const DEFAULT_CURL_SHA256 = "94affc91c64991552403d427cf0e6656ee74f85dcbe58c0ba389f540819f40db"

const torUrl = process.env.TOR_EXPERT_URL || DEFAULT_TOR_URL
const curlUrl = process.env.CURL_IMPERSONATE_URL || DEFAULT_CURL_URL
const torSha256 =
  process.env.TOR_EXPERT_SHA256 || (torUrl === DEFAULT_TOR_URL ? DEFAULT_TOR_SHA256 : undefined)
const curlSha256 =
  process.env.CURL_IMPERSONATE_SHA256 ||
  (curlUrl === DEFAULT_CURL_URL ? DEFAULT_CURL_SHA256 : undefined)

const work = path.join(root, "installer", ".deps-download")
await rm(work, { recursive: true, force: true })
await mkdir(work, { recursive: true })

async function download(url: string, name: string, expected?: string) {
  const target = path.join(work, name)
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`download failed ${resp.status}: ${url}`)
  const bytes = new Uint8Array(await resp.arrayBuffer())
  if (expected) {
    const actual = createHash("sha256").update(bytes).digest("hex")
    if (actual !== expected.toLowerCase()) throw new Error(`sha256 mismatch for ${url}: ${actual}`)
  }
  await Bun.write(target, bytes)
  return target
}

async function find(dir: string, match: (name: string) => boolean): Promise<string | undefined> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await find(full, match)
      if (nested) return nested
    } else if (match(entry.name)) {
      return full
    }
  }
  return undefined
}

async function extract(archive: string, into: string) {
  await mkdir(into, { recursive: true })
  if (archive.endsWith(".zip")) await $`tar -xf ${archive} -C ${into}`
  else await $`tar -xzf ${archive} -C ${into}`
}

async function exists(target: string) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

const torArchive = await download(torUrl, "tor-expert-bundle.tar.gz", torSha256)
await extract(torArchive, path.join(work, "tor"))
const torExe = await find(path.join(work, "tor"), (name) => name === "tor.exe")
if (!torExe) throw new Error("tor.exe not found in the Tor Expert Bundle")
const geoip = await find(path.join(work, "tor"), (name) => name === "geoip")
const geoip6 = await find(path.join(work, "tor"), (name) => name === "geoip6")
await rm("installer/deps/tor", { recursive: true, force: true })
await mkdir("installer/deps/tor", { recursive: true })
await cp(torExe, "installer/deps/tor/tor.exe")
if (geoip) await cp(geoip, "installer/deps/tor/geoip")
if (geoip6) await cp(geoip6, "installer/deps/tor/geoip6")

const curlArchive = await download(
  curlUrl,
  curlUrl.endsWith(".zip") ? "curl-impersonate.zip" : "curl-impersonate.tar.gz",
  curlSha256,
)
await extract(curlArchive, path.join(work, "curl"))
const curlExe = await find(path.join(work, "curl"), (name) => name === "curl-impersonate.exe")
if (!curlExe) throw new Error("curl-impersonate.exe not found in the archive")
const license = await find(path.join(work, "curl"), (name) => /^LICENSE/i.test(name))
await rm("installer/deps/impersonate", { recursive: true, force: true })
await mkdir("installer/deps/impersonate", { recursive: true })
await cp(curlExe, "installer/deps/impersonate/curl-impersonate.exe")
if (!license || !(await exists(license))) throw new Error("curl-impersonate LICENSE not found in the archive")
await cp(license, "installer/deps/impersonate/LICENSE")

await rm(work, { recursive: true, force: true })
console.log("installer deps ready under installer/deps")
