import { Database } from "@opencode/core/database/database"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { sql } from "drizzle-orm"
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { randomBytes as nodeRandomBytes } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as path from "node:path"
import { ensureTor, signalNewNym, probeExitIp } from "@opencode/core/larpcode-tor"
import { recycleTorPool } from "@opencode/core/larpcode-socks-dispatcher"
import { LarpcodeAbliterated } from "@opencode/core/larpcode-abliterated"
import { findWarp } from "@opencode/util/larpcode-dependencies"
import { larpcodeDataPath } from "@opencode/util/larpcode-paths"

// LarpCode: side-channel routes the Reset button and the Abliterated setting
// call. There is no license, activation or signed-directive layer here: the
// app is fully usable without a key, so reset is a local operation.
//
// Shallow (default): zeroes aggregate token / cost columns on every session_v2
// row and purges the three usage event types. Local-only — Console budgets are
// untouched.
//
// Deep (?deep=1, ?mode=fresh, ?mode=fast or ?mode=deep): drops every row from
// every table that would make this install look recognisable to opencode.ai —
// sessions, projects, events, kv. Runs entirely in-process: snapshot the DB,
// wipe, checkpoint the WAL, rotate the local fingerprint, rotate egress
// (Tor/WARP when available), then return a structured result. The renderer
// reloads when the call returns.
//
// jsonUnsafe (not json) because json() returns Effect<HttpServerResponse> —
// yielding Effect<Effect<Response>> breaks the Node adapter's response reader.

// Belt-and-suspenders preflight response. The Electron renderer lives at
// `oc://renderer` and every sidecar POST is cross-origin from Chromium's
// point of view. The reset callers in packages/app set `authorization` and
// `content-type: application/json` to ride CORS-complex, which forces a
// browser OPTIONS preflight. The outer HttpMiddleware.cors in
// packages/server/src/process.ts should answer it, but if any future
// refactor reorders the middleware stack (or an embedder calls
// createRoutes without wrapping CORS at all), the router falls through to
// 405 Method Not Allowed and the reset pill dies with "HTTP 405". Owning
// the OPTIONS leg here guarantees the preflight succeeds regardless.
const PREFLIGHT_HEADERS = {
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-max-age": "86400",
}

const preflight = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const origin = request.headers.origin
  return HttpServerResponse.empty({
    status: 204,
    headers: origin
      ? {
          ...PREFLIGHT_HEADERS,
          "access-control-allow-origin": origin,
          vary: "origin",
        }
      : PREFLIGHT_HEADERS,
  })
})

export const larpcodePreflight = preflight

export const LarpcodeResetLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    // LarpCode: snapshot the live SQLite database to a self-contained .db
    // file under <data-dir>/session-backups/<timestamp>.db. One VACUUM INTO
    // call writes a complete copy (every table, every blob, every row) with
    // no WAL dependency, so the file can be opened offline or swapped back
    // into place with a straight copy. Called by the Usage reset pill BEFORE
    // the deep wipe; a failure here aborts the reset so sessions are never
    // lost silently.
    yield* router.add("OPTIONS", "/_larpcode/export-sessions", preflight)
    yield* router.add("OPTIONS", "/_larpcode/reset-limits", preflight)
    yield* router.add("OPTIONS", "/_larpcode/abliterated", preflight)
    yield* router.add("OPTIONS", "/_larpcode/abliterated/content", preflight)
    yield* router.add(
      "GET",
      "/_larpcode/abliterated/content",
      Effect.gen(function* () {
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          enabled: LarpcodeAbliterated.enabled(),
          custom: LarpcodeAbliterated.custom(),
          content: LarpcodeAbliterated.content(),
          default: LarpcodeAbliterated.DefaultContent,
          max: LarpcodeAbliterated.MaxContentLength,
        })
      }),
    )
    yield* router.add(
      "POST",
      "/_larpcode/abliterated/content",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const parsed = yield* Effect.result(request.json)
        if (parsed._tag === "Failure")
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "invalid JSON body" }, { status: 400 })
        const body = parsed.success
        const reset = body !== null && typeof body === "object" && "reset" in body && body.reset === true
        const content =
          body && typeof body === "object" && "content" in body && typeof body.content === "string"
            ? body.content
            : undefined
        if (!reset && content === undefined)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: "content or reset is required" }, { status: 400 })
        if (content !== undefined && content.length > LarpcodeAbliterated.MaxContentLength)
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `content exceeds ${LarpcodeAbliterated.MaxContentLength} characters` },
            { status: 413 },
          )
        const result = yield* Effect.result(
          Effect.try({
            try: () => (reset ? LarpcodeAbliterated.resetContent() : LarpcodeAbliterated.setContent(content ?? "")),
            catch: (cause) => cause,
          }),
        )
        if (result._tag === "Failure")
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `could not write instructions: ${String(result.failure)}` },
            { status: 500 },
          )
        return HttpServerResponse.jsonUnsafe({
          ok: true,
          custom: LarpcodeAbliterated.custom(),
          length: LarpcodeAbliterated.content().length,
        })
      }),
    )
    yield* router.add(
      "GET",
      "/_larpcode/abliterated",
      Effect.gen(function* () {
        return HttpServerResponse.jsonUnsafe({ ok: true, enabled: LarpcodeAbliterated.enabled() })
      }),
    )
    yield* router.add(
      "POST",
      "/_larpcode/abliterated",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const enabled = url.searchParams.get("enabled") === "1"
        const result = yield* Effect.result(
          Effect.try({
            try: () => LarpcodeAbliterated.setEnabled(enabled),
            catch: (cause) => cause,
          }),
        )
        if (result._tag === "Failure") {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `could not write setting: ${String(result.failure)}` },
            { status: 500 },
          )
        }
        return HttpServerResponse.jsonUnsafe({ ok: true, enabled })
      }),
    )
    yield* router.add(
      "POST",
      "/_larpcode/export-sessions",
      Effect.gen(function* () {
        const service = yield* Database.Service
        const backupsDir = resolveBackupsDir()
        try {
          mkdirSync(backupsDir, { recursive: true })
        } catch (e) {
          return HttpServerResponse.jsonUnsafe(
            { ok: false, error: `cannot create backup dir: ${(e as Error).message}` },
            { status: 500 },
          )
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, "-")
        const dest = path.join(backupsDir, `sessions-${stamp}.db`)
        // VACUUM INTO path literal — SQLite rejects parameters here, so
        // we escape single quotes manually (POSIX path chars don't need
        // more). The dir is server-chosen, never user input.
        const escaped = dest.replace(/'/g, "''")
        const vacuum = yield* Effect.result(service.db.run(sql.raw(`VACUUM INTO '${escaped}'`)))
        if (vacuum._tag === "Failure") {
          const message = vacuum.failure instanceof Error ? vacuum.failure.message : String(vacuum.failure)
          return HttpServerResponse.jsonUnsafe({ ok: false, error: `vacuum failed: ${message}` }, { status: 500 })
        }
        let bytes = 0
        try {
          bytes = statSync(dest).size
        } catch {}
        return HttpServerResponse.jsonUnsafe({ ok: true, path: dest, bytes })
      }),
    )
    yield* router.add(
      "POST",
      "/_larpcode/reset-limits",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const mode = url.searchParams.get("mode")
        // Every explicit reset mode performs the full ritual. `fast` is
        // accepted for older renderers and rewritten to the same deep path
        // because egress rotation alone never moved the anonymous quota
        // bucket in production.
        const deep = url.searchParams.get("deep") === "1" || mode === "fresh" || mode === "fast" || mode === "deep"
        const nukeCredentials = url.searchParams.get("nuke-credentials") === "1"
        diagWrite(`[reset] start mode=${mode ?? "default"} deep=${deep}`)

        // Database.Service pull is wrapped in Either so a dependency-
        // resolution failure (service not provided to this route, context
        // layer not initialised yet) doesn't escape as a bare 500. If the
        // extraction fails the pill gets a structured response explaining
        // why.
        const serviceResult = yield* Effect.result(Database.Service)
        if (serviceResult._tag === "Failure") {
          return HttpServerResponse.jsonUnsafe({
            ok: false,
            mode: mode || "default",
            error: `database unavailable: ${(serviceResult.failure as Error)?.message ?? String(serviceResult.failure)}`,
          })
        }
        const service = serviceResult.success

        if (!deep) {
          yield* service.db.run(
            sql`UPDATE session_v2
                   SET cost = 0,
                       tokens_input = 0,
                       tokens_output = 0,
                       tokens_reasoning = 0,
                       tokens_cache_read = 0,
                       tokens_cache_write = 0`,
          )
          yield* service.db.run(
            sql`DELETE FROM event
                   WHERE type IN (
                     'session.step.ended@1', 'session.step.ended@2',
                     'session.step.failed@1', 'session.step.failed@2',
                     'session.usage.recorded@1'
                   )`,
          )
          return HttpServerResponse.jsonUnsafe({ ok: true, deep: false })
        }

        // Rotate the local wire fingerprint before touching the DB. If the
        // write fails the pill gets a real error and no destructive work
        // happens; a reset with the same fingerprint is a no-op from
        // opencode.ai's point of view.
        const fingerprint = rotateFingerprint()
        if ("error" in fingerprint) {
          return HttpServerResponse.jsonUnsafe(
            {
              ok: false,
              mode: "fresh",
              error: `fingerprint rotation failed: ${fingerprint.error}`,
              stage: "rotateFingerprint",
            },
            { status: 500 },
          )
        }

        // One DELETE per table in child-before-parent order so foreign keys
        // don't block. Each runs inside Effect.result: a missing table from
        // a schema the current build never knew about is a skip (not an
        // error), and any OTHER sqlite failure (locked, FK violation) is
        // collected and surfaced in the JSON body instead of escaping up
        // the Effect error channel as a bare 500. Credentials are kept by
        // default so a signed-in workspace keeps its own quota and model
        // access; nuke only on the explicit flag.
        const wipeTargets = [
          "session_part",
          "session_message",
          "session_inbox",
          "instruction_entry",
          "instruction_state",
          "instruction_blob",
          "permission",
          ...(nukeCredentials ? (["credential"] as const) : []),
          "event",
          "event_sequence",
          "kv",
          "session_v2",
          "project_directory",
          "project",
        ] as const
        const wipeSkipped: string[] = []
        const wipeFailed: { table: string; error: string }[] = []
        for (const table of wipeTargets) {
          const outcome = yield* Effect.result(service.db.run(sql.raw(`DELETE FROM ${table}`)))
          if (outcome._tag === "Success") continue
          const msg = outcome.failure instanceof Error ? outcome.failure.message : String(outcome.failure)
          if (/no such table/i.test(msg)) {
            wipeSkipped.push(table)
            continue
          }
          wipeFailed.push({ table, error: msg })
        }
        if (wipeFailed.length > 0) {
          diagWrite(`[reset] wipe FAILED: ${wipeFailed.map((f) => `${f.table}=${f.error}`).join("; ")}`)
          return HttpServerResponse.jsonUnsafe(
            {
              ok: false,
              mode: "fresh",
              error: `wipe failed on ${wipeFailed.length} table(s): ${wipeFailed
                .map((f) => `${f.table}: ${f.error}`)
                .join("; ")}`,
              wipe_skipped: wipeSkipped,
              wipe_failed: wipeFailed,
              fingerprint_rotated: true,
              fingerprint_client: fingerprint.clientLabel,
            },
            { status: 500 },
          )
        }

        // opencode runs SQLite in WAL mode. Force the current WAL to merge
        // into the main DB and zero the WAL file so the delete records are
        // durable on disk before the renderer reloads or the sidecar exits.
        const checkpointResult = yield* Effect.result(service.db.run(sql.raw(`PRAGMA wal_checkpoint(TRUNCATE)`)))
        if (checkpointResult._tag === "Failure") {
          const msg =
            checkpointResult.failure instanceof Error
              ? checkpointResult.failure.message
              : String(checkpointResult.failure)
          console.warn(`[larpcode-reset] wal_checkpoint failed: ${msg}`)
          diagWrite(`[reset] wal_checkpoint FAILED: ${msg}`)
        } else {
          diagWrite("[reset] wal_checkpoint TRUNCATE ok")
        }

        // Egress rotation last: it is the slow step (~10-30s on a cold Tor
        // start), and it must not prevent the local wipe from being reported.
        const warp = yield* rotateWarp()
        diagWrite(`[reset] done warp=${warp.status}`)

        return HttpServerResponse.jsonUnsafe({
          ok: true,
          mode: "fresh",
          deep: true,
          kept_credentials: !nukeCredentials,
          wipe_skipped: wipeSkipped,
          wipe_failed: [],
          fingerprint_rotated: true,
          fingerprint_client: fingerprint.clientLabel,
          fingerprint_nonce_prefix: fingerprint.nonce.slice(0, 12),
          warp,
        })
      }).pipe(
        // Bulletproof outer guard. ANY uncaught Effect failure or defect
        // inside the handler above — DB-service missing, Effect.promise
        // defect, drizzle throwing a non-Effect error, anything the per-
        // branch Either wrappers didn't anticipate — is caught here and
        // converted to structured JSON. Keep the 200 (no scary HTTP code)
        // but ok:false so the pill renders failed with a real error and
        // never runs the post-success reload that assumed state was clean.
        Effect.catchCause((cause) => {
          // eslint-disable-next-line no-console
          console.error("[larpcode-reset] uncaught in handler:", cause)
          const pretty =
            typeof cause === "object" && cause !== null && "toString" in cause
              ? (cause as { toString(): string }).toString()
              : String(cause)
          return Effect.succeed(
            HttpServerResponse.jsonUnsafe({
              ok: false,
              handler_error: pretty.slice(0, 512),
              error: "reset failed before completion — see server log",
            }),
          )
        }),
      ),
    )
  }),
)

// Keep session snapshots under the same LarpCode data root as the live database.
function resolveBackupsDir(): string {
  return larpcodeDataPath("session-backups")
}

// Where the ua-spoof plugin picks up the per-reset fingerprint rotation.
// Stamped by rotateFingerprint() in the reset pipeline, read at every
// outbound opencode.ai request to derive the wire identifiers that replace
// the real session / project ids in request headers. Local DB rows keep
// their real ids (chat history, tabs, backups all unaffected); only the
// values that cross the wire change.
function fingerprintPath(): string {
  return larpcodeDataPath("larpcode-fingerprint.json")
}

// A small pool of plausible modern Chrome / Firefox UAs. Picked at random on
// every reset so the server-side fingerprinter can't tie two post-reset
// installations by UA alone. Kept in sync with the plugin's own fallback
// pool; the plugin reads whichever UA this file stamps.
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
] as const

// Resolve the shared diag file the ua-spoof plugin also writes to. Every
// rotation step (success AND failure) lands there so a reader can confirm
// post-hoc why a given pill click did or didn't move the fingerprint.
function resetDiagPath(): string {
  return larpcodeDataPath("log", "larpcode-diag.log")
}

function diagWrite(line: string): void {
  try {
    const p = resetDiagPath()
    mkdirSync(path.dirname(p), { recursive: true })
    appendFileSync(p, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" })
  } catch {
    /* swallow — diag write failures must not stop the reset */
  }
}

// Write a fresh fingerprint file. Every attempt is logged so a write failure
// (perm issue, AV lock, bad XDG path) surfaces to the caller instead of
// looking like a successful rotation, and the UA pick is uniform-random via
// one byte so the distribution doesn't bias.
function rotateFingerprint(): { nonce: string; ua: string; clientLabel: string; file: string } | { error: string } {
  const file = fingerprintPath()
  try {
    const nonce = nodeRandomBytes(32).toString("hex")
    const uaIdx = nodeRandomBytes(1)[0] % UA_POOL.length
    const ua = UA_POOL[uaIdx]
    const clientLabel = "oc-" + nodeRandomBytes(6).toString("hex")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ nonce, ua, clientLabel, stamped: Date.now() }), { encoding: "utf8" })
    // Verify the write landed — a successful writeFileSync on Windows can
    // still be shadowed by an AV scanner that holds the file open and
    // reverts. Re-stat to confirm the file exists.
    const st = statSync(file)
    diagWrite(
      `[reset-fingerprint] rotated ok nonce=${nonce.slice(0, 12)}… client=${clientLabel} ` +
        `ua="${ua.slice(0, 40)}…" file=${file} size=${st.size}`,
    )
    return { nonce, ua, clientLabel, file }
  } catch (e) {
    const err = (e as Error)?.message ?? String(e)
    diagWrite(`[reset-fingerprint] FAILED file=${file} error=${err}`)
    return { error: err }
  }
}

// Outcome shape kept under its original name (`WarpOutcome`) and JSON key
// (`warp`) so the renderer fab doesn't need to change. Semantically this is
// the Tor egress outcome; `mode: "tor"` distinguishes it from the old
// `mode: "warp"` payloads, but the pill only reads status + ip_before +
// ip_after so the mode label is informational.
type WarpOutcome =
  | { status: "rotated"; mode: "tor"; ip_before: string | null; ip_after: string }
  | { status: "unverified"; mode: "tor"; ip_before: null; ip_after: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; step: string; error: string; ip_before?: string | null }

// Rotate both identity layers in parallel:
//   - Tor gives opencode.ai a new exit IP (routed via our SOCKS5 dispatcher
//     for opencode.ai hosts only).
//   - WARP gives DIRECT traffic (non-Tor, non-opencode.ai) a new Cloudflare
//     exit, so browsing + BYOK paths don't keep a residual identity thread.
// Both rotations go concurrently so the pill latency is max(tor, warp).
export function rotateWarp(): Effect.Effect<WarpOutcome & { warp_cycle?: WarpCycleOutcome }> {
  return Effect.promise(async (): Promise<WarpOutcome & { warp_cycle?: WarpCycleOutcome }> => {
    const [torResult, warpCycle] = await Promise.all([doTorRotation(), doWarpCycle()])
    // Primary outcome shape stays Tor's — the pill reads status / ip_before /
    // ip_after and shows "IP X → Y" from those, which should be the Tor exit
    // (that's what opencode.ai actually SEES for our dispatched traffic).
    // WARP's rotation data rides along in `warp_cycle`.
    return { ...finalizeDisplay(torResult), warp_cycle: warpCycle }
  })
}

// The pill displays the real outcome. A fabricated "IP X -> Y" pair used to
// be returned whenever the probe failed or the rotation was skipped, which
// made a failed reset look successful and hid the reason from the operator.
// A failed or unverified rotation now renders as exactly that.
function finalizeDisplay(outcome: WarpOutcome): WarpOutcome {
  return outcome
}

// Tor rotation sends SIGNAL NEWNYM through the configured Tor control port.

async function doTorRotation(): Promise<WarpOutcome> {
  // Cold-start tor if it isn't up yet. Subsequent resets skip this — tor
  // runs for the sidecar's whole lifetime, and even past it since we
  // spawn it detached. First cold start pays ~15-25s for consensus +
  // circuit bootstrap; reusable across resets after that.
  const ensured = await ensureTor()
  if (ensured.status !== "ready") {
    return { status: "skipped", reason: `tor not ready: ${ensured.reason}` }
  }

  // Baseline exit IP, through the SOCKS5 proxy (i.e. what opencode.ai
  // sees RIGHT NOW on outbound inference requests). If this fails we
  // can still try the rotation — we just report ip_before as null and
  // mark the outcome `unverified` at the end.
  const ipBefore = await probeExitIp(15_000)

  // New circuit.
  const nym = await signalNewNym()
  if (!nym.ok) {
    return { status: "failed", step: "newnym", error: nym.response, ip_before: ipBefore }
  }

  // Tor's control-port SIGNAL NEWNYM queues a new circuit but doesn't
  // guarantee the NEXT TCP connection uses it. The signal rate-limits
  // to one every ~10s (MaxCircuitDirtiness default); waiting ~8s plus
  // dropping the keepalive sockets flushes the old circuit from
  // undici's pool so the next request opens a fresh tunnel.
  await new Promise((r) => setTimeout(r, 8_000))
  await recycleTorPool()

  let ipAfter = await probeExitIp(15_000)

  // Retry on same-IP. Tor occasionally picks the same exit on the next
  // circuit, especially in low-diversity countries. Send NEWNYM up to
  // twice more.
  for (let attempt = 0; attempt < 2 && ipAfter && ipBefore && ipAfter === ipBefore; attempt++) {
    const retry = await signalNewNym()
    if (!retry.ok) break
    await new Promise((r) => setTimeout(r, 8_000))
    await recycleTorPool()
    ipAfter = await probeExitIp(15_000)
  }

  if (!ipAfter) {
    return { status: "failed", step: "probe-after", error: "could not read tor exit IP", ip_before: ipBefore }
  }
  if (!ipBefore) {
    return { status: "unverified", mode: "tor", ip_before: null, ip_after: ipAfter }
  }
  if (ipBefore === ipAfter) {
    return {
      status: "failed",
      step: "same-ip",
      error: `tor returned the same exit (${ipAfter}) after 3 NEWNYMs`,
      ip_before: ipBefore,
    }
  }
  return { status: "rotated", mode: "tor", ip_before: ipBefore, ip_after: ipAfter }
}

// --- WARP rotation (via warp-cli disconnect + rotate-keys + connect) --------

type WarpCycleOutcome =
  | { status: "rotated"; ip_before: string; ip_after: string }
  | { status: "same_ip"; ip: string }
  | { status: "unverified"; ip_before: string | null; ip_after: string | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; step: string; error: string }

const execFileAsync = promisify(execFile)

function resolveWarpCli(): string | undefined {
  return findWarp()
}

// Fetch WARP's assigned egress IP via a DIRECT HTTPS request to 1.1.1.1's
// trace endpoint. The ua-spoof dispatcher routes `opencode.ai` through Tor
// but leaves every other host on the direct pool, so this request exits
// through WARP (or the user's ISP if WARP is off) and reports the IP
// opencode.ai would see from any non-Tor traffic.
async function fetchDirectEgressIp(timeoutMs = 4000): Promise<string | null> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch("https://1.1.1.1/cdn-cgi/trace", { signal: controller.signal })
    const text = await res.text()
    const m = /\bip=([0-9a-fA-F:.]+)/.exec(text)
    return m ? m[1] : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function doWarpCycle(): Promise<WarpCycleOutcome> {
  const warp = resolveWarpCli()
  if (!warp) return { status: "skipped", reason: "warp-cli not installed" }

  const ipBefore = await fetchDirectEgressIp()

  const run = async (step: string, args: string[], tolerate = false): Promise<void> => {
    try {
      await execFileAsync(warp, ["--accept-tos", ...args], {
        windowsHide: true,
        timeout: 20_000,
      })
    } catch (e) {
      if (!tolerate) throw new Error(`${step}: ${(e as Error).message}`)
    }
  }

  try {
    // disconnect → rotate-keys → connect. This is the sequence that
    // actually rotates for consumer WARP. `rotate-keys` alone keeps the
    // same key-material in use because the existing tunnel sockets are
    // still live; cycling the tunnel forces re-key.
    await run("disconnect", ["disconnect"], true)
    await run("rotate-keys", ["tunnel", "rotate-keys"])
    await run("connect", ["connect"])

    // Wait for the new tunnel to come up + egress to stabilise. WARP's
    // `connect` returns before the tunnel is fully usable; 4s matches
    // what the manual test used.
    await new Promise((r) => setTimeout(r, 4_000))

    const ipAfter = await fetchDirectEgressIp()
    if (!ipAfter) {
      return { status: "unverified", ip_before: ipBefore, ip_after: null }
    }
    if (!ipBefore) {
      return { status: "unverified", ip_before: null, ip_after: ipAfter }
    }
    if (ipBefore === ipAfter) {
      return { status: "same_ip", ip: ipAfter }
    }
    return { status: "rotated", ip_before: ipBefore, ip_after: ipAfter }
  } catch (e) {
    return { status: "failed", step: "warp-cycle", error: (e as Error).message }
  }
}
