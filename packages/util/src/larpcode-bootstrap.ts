export * as LarpcodeBootstrap from "./larpcode-bootstrap.js"

// Runs at CLI startup, BEFORE any effect/http layer loads. Replaces
// globalThis.fetch with a routing function so every downstream consumer
// (effect/http's FetchHttpClient, the AI SDK, random utility code) that
// captures a reference to globalThis.fetch gets OUR routed version from
// the start.
//
// Lives in @opencode/util (not @opencode/core) because @opencode/cli
// depends on util but not on core. Putting the bootstrap here means the
// CLI entry point can import it directly without widening the dependency
// graph.
//
// Self-contained SOCKS5 + undici tunnel so this module has no imports
// from @opencode/core. Shares the Tor SOCKS5 port (9150) with the core-
// side torFetch; both route through the same bundled tor process.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { createConnection as netConnect } from "node:net"
import { dirname as pathDirname } from "node:path"
import { installImpersonateFetchOverride } from "./larpcode-impersonate-fetch.js"
import * as LarpcodeSettings from "./larpcode-settings.js"
import { larpcodeDataPath } from "./larpcode-paths.js"

const TOR_SOCKS_PORT = 9150

// MCP tools are exposed directly in the LarpCode CLI by default. Weaker
// free/fallback models do not reliably write Code Mode JavaScript, so a tool
// behind `execute` is a tool they cannot reach. `LARPCODE_MCP_DIRECT=0`
// restores the upstream Code Mode-only default; a server can still opt in
// with `codemode: true`.
process.env.LARPCODE_MCP_DIRECT ??= "1"

const DIAG_PATH = (() => {
  return larpcodeDataPath("log", "larpcode-diag.log")
})()
let diagDirOk = false
function diag(line: string): void {
  try {
    if (!diagDirOk) {
      mkdirSync(pathDirname(DIAG_PATH), { recursive: true })
      diagDirOk = true
    }
    appendFileSync(DIAG_PATH, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" })
  } catch {
    /* ignore */
  }
}

function shouldRouteThroughTor(hostname: string): boolean {
  if (!hostname) return false
  const h = hostname.toLowerCase()
  return h === "opencode.ai" || h.endsWith(".opencode.ai")
}

// Minimal SOCKS5 CONNECT handshake (inline, no deps). Returns a raw socket
// tunneled to <host>:<port>. Caller wraps TLS.
async function openSocks5(host: string, port: number, timeoutMs = 20_000): Promise<import("node:net").Socket> {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: "127.0.0.1", port: TOR_SOCKS_PORT })
    let step: "greet" | "connect" = "greet"
    let buf = Buffer.alloc(0)
    const t = setTimeout(() => {
      sock.destroy()
      reject(new Error("socks5 timeout"))
    }, timeoutMs)
    sock.once("connect", () => sock.write(Buffer.from([0x05, 0x01, 0x00])))
    sock.on("data", (chunk: Buffer | string) => {
      // A socket without setEncoding yields Buffers, but the Node typings also
      // admit strings on the data event; normalize so Buffer.concat stays typed.
      buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk) : chunk])
      if (step === "greet") {
        if (buf.length < 2) return
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          clearTimeout(t)
          sock.destroy()
          return reject(new Error("socks5 greet rejected"))
        }
        buf = buf.slice(2)
        const domain = Buffer.from(host, "ascii")
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]),
          domain,
          Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        ])
        sock.write(req)
        step = "connect"
        return
      }
      if (step === "connect") {
        if (buf.length < 10) return
        if (buf[0] !== 0x05 || buf[1] !== 0x00) {
          clearTimeout(t)
          sock.destroy()
          return reject(new Error(`socks5 connect rep=${buf[1]}`))
        }
        const atyp = buf[3]
        let addrLen = 0
        if (atyp === 0x01) addrLen = 4
        else if (atyp === 0x04) addrLen = 16
        else if (atyp === 0x03) addrLen = 1 + buf[4]
        else {
          clearTimeout(t)
          sock.destroy()
          return reject(new Error(`socks5 unknown atyp ${atyp}`))
        }
        const total = 4 + addrLen + 2
        if (buf.length < total) return
        const tail = buf.slice(total)
        clearTimeout(t)
        sock.removeAllListeners("data")
        if (tail.length > 0) sock.unshift(tail)
        resolve(sock)
      }
    })
    sock.on("error", (e) => {
      clearTimeout(t)
      reject(e)
    })
  })
}

// Tor-routed fetch using undici Agent with a custom SOCKS5 connect.
let _torAgent: import("undici").Agent | null = null
async function torFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const undici = (await import("undici")) as typeof import("undici")
  const tlsMod = await import("node:tls")
  if (!_torAgent) {
    _torAgent = new undici.Agent({
      connect: (async (
        opts: { hostname?: string; host?: string; port?: number | string; protocol?: string; servername?: string },
        cb: (err: Error | null, sock: import("node:net").Socket | null) => void,
      ) => {
        try {
          const host = opts.hostname ?? opts.host ?? ""
          const port = Number(opts.port ?? 443)
          const protocol = opts.protocol ?? "https:"
          const servername = opts.servername ?? host
          const raw = await openSocks5(host, port, 20_000)
          if (protocol === "https:") {
            const tls = tlsMod.connect({ socket: raw, servername, ALPNProtocols: ["http/1.1"] })
            const onSecure = () => {
              tls.removeListener("error", onErr)
              cb(null, tls as unknown as import("node:net").Socket)
            }
            const onErr = (e: Error) => {
              tls.removeListener("secureConnect", onSecure)
              cb(e, null)
            }
            tls.once("secureConnect", onSecure)
            tls.once("error", onErr)
          } else {
            cb(null, raw)
          }
        } catch (e) {
          cb(e as Error, null)
        }
      }) as never,
      keepAliveTimeout: 10_000,
      keepAliveMaxTimeout: 20_000,
      pipelining: 0,
    } as never)
  }
  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
  diag(`[bootstrap-torFetch] -> ${urlStr?.slice(0, 160)}`)
  const res = (await (
    undici as unknown as {
      fetch: (
        u: RequestInfo | URL,
        init?: RequestInit & { dispatcher?: import("undici").Dispatcher },
      ) => Promise<Response>
    }
  ).fetch(input, { ...init, dispatcher: _torAgent })) as Response
  diag(`[bootstrap-torFetch] <- status=${res.status}`)
  return res
}

// PROXY REPORTING + FAIL-CLOSED GUARD.
//
// The compiled sidecar is Bun (`opencode-cli.exe`, bun build --compile).
// Bun's native `globalThis.fetch` is implemented in Zig and does NOT delegate
// to undici — `undici.setGlobalDispatcher()` is a no-op for any fetch the
// backend makes. The previous bootstrap set an EnvHttpProxyAgent here and
// expected it to route opencode.ai traffic through WARP's loopback proxy;
// strings pulled from the deployed 285 MB binary confirmed the install line
// fired but nothing changed on the wire. Removed.
//
// What actually routes Bun's fetch through the proxy is the env itself: Bun
// reads HTTP_PROXY / HTTPS_PROXY / ALL_PROXY (upper or lower case) on every
// call. The app process can set these when it launches with a proxy, and
// child processes inherit them. All this block does now is:
//
//   - LOG what the sidecar sees in its env, so the diag log shows whether
//     the Electron spawn propagated the proxy or not.
//   - FAIL CLOSED when LARPCODE_REQUIRE_PROXY=1 and the egress is bare.
//     A launcher can export LARPCODE_REQUIRE_PROXY=1 alongside the
//     HTTPS_PROXY vars, so a sidecar started without protected egress
//     refuses to boot. First launch with no proxy leaves LARPCODE_REQUIRE_PROXY
//     unset, and the guard is correctly skipped then - the user hasn't
//     opted into protected egress yet.
//   - Honour LARPCODE_FORCE_TOR=1 as a valid egress even when HTTPS_PROXY
//     is unset. patchEarly below installs a Tor SOCKS5 fetch override for
//     opencode.ai hosts; that IS protected egress, just not visible as an
//     env-level proxy.
;(function reportProxyState() {
  try {
    const envHttps = process.env.HTTPS_PROXY || process.env.https_proxy
    const envHttp = process.env.HTTP_PROXY || process.env.http_proxy
    const envAll = process.env.ALL_PROXY || process.env.all_proxy
    const target = envHttps || envHttp || envAll
    const torForced = LarpcodeSettings.resolved().forceTor
    if (target) {
      diag(`[bootstrap-proxy] bun native fetch will use proxy=${target} (no undici needed)`)
      return
    }
    if (torForced) {
      diag(
        `[bootstrap-proxy] no HTTPS_PROXY env but Tor routing is enabled — Tor SOCKS5 override will carry opencode.ai traffic`,
      )
      return
    }
    diag(`[bootstrap-proxy] no HTTPS_PROXY/HTTP_PROXY/ALL_PROXY env, no LARPCODE_FORCE_TOR`)
    if (process.env.LARPCODE_REQUIRE_PROXY === "1") {
      diag(`[bootstrap-proxy] FAIL-CLOSED: LARPCODE_REQUIRE_PROXY=1 and no proxy env; exiting`)
      try {
        process.stderr.write(
          "larpcode-bootstrap: egress not protected (LARPCODE_REQUIRE_PROXY=1 and no HTTPS_PROXY / LARPCODE_FORCE_TOR)\n",
        )
      } catch {
        /* ignore */
      }
      process.exit(17)
    }
  } catch (e) {
    diag(`[bootstrap-proxy] reporter failed: ${(e as Error).message}`)
  }
})()

// v20 Tor override — opt-in via LARPCODE_FORCE_TOR=1 only.
;(function patchEarly() {
  try {
    if (!LarpcodeSettings.resolved().forceTor) {
      diag(
        `[bootstrap-fetch] disabled (enable Tor routing in LarpCode settings or set LARPCODE_FORCE_TOR=1). HTTPS_PROXY env (when configured) handles egress via the proxy.`,
      )
      return
    }
    if (typeof globalThis.fetch !== "function") return
    if ((globalThis as { __larpcodeFetchPatched?: boolean }).__larpcodeFetchPatched) return
    const original = globalThis.fetch.bind(globalThis)
    ;(globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      try {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
        const host = new URL(url).hostname.toLowerCase()
        if (shouldRouteThroughTor(host)) {
          diag(`[bootstrap-fetch] routing ${host} through torFetch (LARPCODE_FORCE_TOR=1)`)
          return await torFetch(input, init)
        }
      } catch (e) {
        diag(`[bootstrap-fetch] ERROR: ${(e as Error).message}, falling through to native`)
      }
      return original(input as RequestInfo | URL, init)
    }) as typeof globalThis.fetch
    ;(globalThis as { __larpcodeFetchPatched?: boolean }).__larpcodeFetchPatched = true
    diag(`[bootstrap-fetch] EARLY patch installed at CLI entry (LARPCODE_FORCE_TOR=1)`)
  } catch (e) {
    diag(`[bootstrap-fetch] FAILED to install: ${(e as Error).message}`)
  }
  void readFileSync
})()

// TLS-fingerprint impersonation and free-limit fallback for opencode.ai.
//
// Bun's native fetch rides BoringSSL with a fixed ClientHello. Every
// LarpCode install emits the SAME JA3/JA4 on every opencode.ai request,
// and Cloudflare's Bot Management can bucket them into one "free-tier abuse"
// quota pool regardless of what we rotate at the application layer.
//
// Fix: route requests through a compatible curl-impersonate binary when present.
// Windows bundles it; Linux can use a system binary or an explicit override. That
// binary emits a real Chrome/Firefox/Safari/Edge ClientHello + HTTP/2
// SETTINGS frame + ALPN set + GREASE values indistinguishable from an
// actual browser. Profile rotates per sidecar boot off the fingerprint
// nonce, so pill-driven epochs look like different browsers to Cloudflare.
// HTTPS_PROXY env (Tor HTTP tunnel) forwards unchanged through curl's -x
// flag, so Tor NEWNYM + Chrome JA3 stack additively.
//
// Installed after the Tor wrapper so the override's `nativeFetch` is the Tor
// path. It is installed even when the curl binary is missing (dev build,
// stripped installer): opencode.ai then uses native fetch and still swaps a
// free-limit refusal for the configured fallback provider.
;(function patchImpersonate() {
  try {
    const result = installImpersonateFetchOverride()
    diag(`[bootstrap-impersonate] install result: ${JSON.stringify(result)}`)
  } catch (e) {
    diag(`[bootstrap-impersonate] FAILED: ${(e as Error).message}`)
  }
})()
