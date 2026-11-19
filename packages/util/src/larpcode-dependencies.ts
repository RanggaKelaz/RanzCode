import { existsSync, statSync } from "node:fs"
import path from "node:path"

// Shared optional-dependency probes. The CLI doctor, the server-side LarpCode
// settings endpoint, and the TUI warning surface all read this so the wording
// and detection strategy stay identical.

export type DependencyID = "warp" | "tor" | "impersonate"

export type Dependency = {
  id: DependencyID
  name: string
  installed: boolean
  path?: string
  detail: string
  hint: string
}

export type Proxy = {
  configured: boolean
  value?: string
}

export type Report = {
  dependencies: Dependency[]
  proxy: Proxy
  missing: number
}

const WARP_CANDIDATES = [
  "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe",
  "C:\\Program Files (x86)\\Cloudflare\\Cloudflare WARP\\warp-cli.exe",
]

export function findWarp(): string | undefined {
  for (const candidate of WARP_CANDIDATES) if (existsSync(candidate)) return candidate
  return findOnPath(["warp-cli", "warp-cli.exe"])
}

export function findTor(): string | undefined {
  const binary = process.platform === "win32" ? "tor.exe" : "tor"
  const bundled = findBundled("deps", "tor", binary)
  if (bundled) return bundled
  const override = process.env.LARPCODE_TOR_BIN
  if (override && existsSync(override)) return override
  return findOnPath(["tor", "tor.exe"])
}

export function findImpersonate(): string | undefined {
  const override = process.env.LARPCODE_CURL_IMPERSONATE
  if (override !== undefined) {
    if (override === "" || override === "0" || override.toLowerCase() === "none") return undefined
    return existsSync(override) ? override : undefined
  }
  const binary = process.platform === "win32" ? "curl-impersonate.exe" : "curl-impersonate"
  const bundled = findBundled("deps", "impersonate", binary)
  if (bundled || process.platform === "win32") return bundled
  return findOnPath(["curl-impersonate", "curl-impersonate-chrome"])
}

export function findBundled(...parts: string[]): string | undefined {
  let directory = path.dirname(process.execPath)
  for (let index = 0; index < 6; index++) {
    const candidate = path.join(directory, ...parts)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

export function findOnPath(names: ReadonlyArray<string>): string | undefined {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
  const extensions =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""]
  for (const directory of directories) {
    for (const name of names) {
      for (const extension of extensions) {
        const suffix = extension !== "" && !name.toLowerCase().endsWith(extension.toLowerCase()) ? extension : ""
        const candidate = path.join(directory, name + suffix)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

export function proxyValue(): string | undefined {
  return (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy
  )
}

export function redactProxy(value: string): string {
  try {
    const url = new URL(value)
    if (url.username || url.password) {
      url.username = "***"
      url.password = "***"
    }
    return url.toString()
  } catch {
    return value
  }
}

export function inspect(): Report {
  const warp = findWarp()
  const tor = findTor()
  const impersonate = findImpersonate()
  const proxy = proxyValue()
  const dependencies: Dependency[] = [
    {
      id: "warp",
      name: "Cloudflare WARP",
      installed: Boolean(warp),
      path: warp,
      detail: warp ?? "Cloudflare WARP CLI not found (warp-cli).",
      hint: warp
        ? "Auto-rotate can reset your egress IP through WARP."
        : "Install it from https://1.1.1.1/ to rotate your egress IP automatically.",
    },
    {
      id: "tor",
      name: "Tor",
      installed: Boolean(tor),
      path: tor,
      detail: tor ?? "Tor binary not found.",
      hint: tor
        ? "Deep resets can rotate a Tor circuit when Tor routing is enabled."
        : "Optional. Deep resets cannot rotate a Tor circuit; WARP rotation still works. Set LARPCODE_TOR_BIN if Tor is outside PATH.",
    },
    {
      id: "impersonate",
      name: "curl-impersonate",
      installed: Boolean(impersonate),
      path: impersonate,
      detail: impersonate ?? "curl-impersonate binary not found.",
      hint: impersonate
        ? "opencode.ai requests carry a browser TLS fingerprint."
        : "Optional. opencode.ai requests use native TLS when a compatible helper is unavailable.",
    },
  ]
  return {
    dependencies,
    proxy: proxy ? { configured: true, value: redactProxy(proxy) } : { configured: false },
    missing: dependencies.filter((dependency) => !dependency.installed).length,
  }
}

export function isFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}
