import { existsSync, readdirSync, realpathSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Schema } from "effect"
import type { ExperimentalSessionImportInput, JsonValue } from "@opencode/client"
import { Session } from "@opencode/schema/session"
import { SessionLegacy } from "@opencode/schema/session-legacy"
import { SessionMessage } from "@opencode/schema/session-message"
import { Database } from "#zed-sqlite"
import { errorMessage } from "./error"

/**
 * Reads the sessions an installed OpenCode keeps in its own SQLite database.
 *
 * LarpCode stores its state under its own application id, so these databases belong to OpenCode and are opened
 * read-only. Nothing here writes, migrates, or deletes OpenCode data; importing copies a transcript into the
 * current LarpCode location and leaves the source database untouched.
 */

type SQLValue = string | number | bigint | null | Uint8Array

type Connection = {
  query(sql: string): {
    all(parameters?: Record<string, SQLValue>): unknown[]
    get(parameters?: Record<string, SQLValue>): unknown
  }
  close(): void
}

type Record_ = Record<string, unknown>

export type OpenCodeSessionSummary = {
  /** The OpenCode database this session was read from. */
  readonly database: string
  readonly id: string
  readonly title: string
  readonly directory: string
  readonly timeCreated: number
  readonly timeUpdated: number
  readonly messageCount: number
  readonly preview?: string
}

export type OpenCodeSessionList = {
  readonly databases: readonly string[]
  readonly sessions: readonly OpenCodeSessionSummary[]
  /** Root sessions stored in the pre-2.0 `session` table that OpenCode has not migrated yet. */
  readonly legacySessions: number
  readonly errors: readonly string[]
}

export type OpenCodeImportData = {
  readonly info: ExperimentalSessionImportInput["info"]
  readonly messages: ExperimentalSessionImportInput["messages"]
}

const mediaRef = /^media:([0-9a-f]{64})$/
const databaseName = /^opencode(?:-[a-zA-Z0-9._-]+)?\.db$/i

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info)
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

/** OpenCode databases, most explicit source first. Tests and advanced users can point these at a copied profile. */
export function findOpenCodeDatabases() {
  const explicit = process.env.LARPCODE_OPENCODE_DB
  const explicitData = process.env.LARPCODE_OPENCODE_DATA
  const home = os.homedir()
  const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming")
  const candidates: string[] = []
  const excluded = [process.env.XDG_DATA_HOME, process.env.LARPCODE_DESKTOP_XDG_ROOT, process.env.OPENCODE_DB]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(resolve)

  const addFile = (file: string) => {
    if (!existsSync(file) || !isFile(file)) return
    if (!databaseName.test(path.basename(file)) && resolve(file) !== resolve(explicit ?? "")) return
    if (excluded.some((root) => isInside(file, root))) return
    candidates.push(resolve(file))
  }

  const addDirectory = (directory: string | undefined) => {
    if (!directory || !existsSync(directory)) return
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      return
    }
    for (const name of names) if (databaseName.test(name)) addFile(path.join(directory, name))
  }

  if (explicit) addFile(explicit)
  addDirectory(explicitData)
  addDirectory(path.join(home, ".local", "share", "opencode"))

  if (process.platform === "win32")
    addDirectory(path.join(appData, "ai.opencode.desktop", "xdg", "data", "opencode"))
  if (process.platform === "darwin")
    addDirectory(
      path.join(home, "Library", "Application Support", "ai.opencode.desktop", "xdg", "data", "opencode"),
    )
  if (process.platform === "linux")
    addDirectory(
      path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
        "ai.opencode.desktop",
        "xdg",
        "data",
        "opencode",
      ),
    )

  // A custom XDG data home is where OpenCode's CLI keeps its database when the
  // user overrides it. LarpCode's own XDG root is in `excluded`.
  if (process.env.XDG_DATA_HOME) addDirectory(path.join(process.env.XDG_DATA_HOME, "opencode"))

  const seen = new Set<string>()
  return candidates.filter((file) => {
    const key = canonical(file).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function listOpenCodeSessions(): OpenCodeSessionList {
  const databases = findOpenCodeDatabases()
  const sessions = new Map<string, OpenCodeSessionSummary>()
  const errors: string[] = []
  const readable: string[] = []
  let legacySessions = 0

  for (const database of databases) {
    try {
      const result = listDatabaseSessions(database)
      readable.push(database)
      legacySessions += result.legacySessions
      for (const session of result.sessions) {
        const previous = sessions.get(session.id)
        if (
          !previous ||
          session.timeUpdated > previous.timeUpdated ||
          (session.timeUpdated === previous.timeUpdated && session.messageCount > previous.messageCount)
        )
          sessions.set(session.id, session)
      }
    } catch (error) {
      errors.push(`${path.basename(database)}: ${errorMessage(error)}`)
    }
  }

  return {
    databases: readable,
    sessions: [...sessions.values()].sort((a, b) => b.timeUpdated - a.timeUpdated),
    legacySessions,
    errors,
  }
}

export function readOpenCodeSession(input: {
  readonly database: string
  readonly sessionID: string
  readonly directory: string
}): OpenCodeImportData {
  const db = openReadOnly(input.database)
  try {
    const tables = tableNames(db)
    if (!tables.has("session_v2") || !tables.has("session_message"))
      throw new Error("This OpenCode profile uses the legacy session format. Open it once in OpenCode 2 to migrate it.")

    const row = get(db, "SELECT * FROM session_v2 WHERE id = $sessionID LIMIT 1", { sessionID: input.sessionID })
    if (!isRecord(row)) throw new Error("That OpenCode session no longer exists.")

    const parts = tables.has("session_part") ? readParts(db, input.sessionID) : new Map<string, Record_[]>()
    const rows = readMessageRows(db, input.sessionID)
    const ids = new Map(rows.map((message) => [message.id, SessionMessage.ID.create()]))

    const messages = rows.map((message) => {
      const data = { ...message.data }
      if (message.type === "assistant") {
        const split = parts.get(message.id)
        if (split?.length) {
          const inline = Array.isArray(data.content) ? data.content : []
          data.content = [...split, ...inline]
        }
      }
      // A summary compaction points at the first message it kept. Fresh message
      // ids keep repeated imports from colliding, so the pointer moves with them.
      if (isRecord(data.metadata) && typeof data.metadata.keepID === "string") {
        const next = ids.get(data.metadata.keepID)
        if (next) data.metadata = { ...data.metadata, keepID: next }
      }
      return {
        id: ids.get(message.id)!,
        type: message.type,
        data: SessionLegacy.message(message.type, data),
      }
    })

    hydrateMedia(db, messages, tables.has("blob"))

    return {
      info: sessionInfo(row, input.directory),
      messages: messages.map((message) => {
        try {
          // Stored messages are flat, exactly like the rows `core` decodes from SQLite.
          return encodeMessage(decodeMessage({ ...message.data, id: message.id, type: message.type })) as JsonValue
        } catch (error) {
          throw new Error(`Could not read OpenCode message ${message.id}: ${errorMessage(error)}`)
        }
      }),
    }
  } finally {
    db.close()
  }
}

function listDatabaseSessions(database: string) {
  const db = openReadOnly(database)
  try {
    const tables = tableNames(db)
    const sessions: OpenCodeSessionSummary[] = []

    if (tables.has("session_v2")) {
      const columns = tableColumns(db, "session_v2")
      const where = columns.has("parent_id") ? "s.parent_id IS NULL" : "1"
      const archived = columns.has("time_archived") ? "AND s.time_archived IS NULL" : ""
      const order = columns.has("time_updated") ? "s.time_updated DESC" : "s.time_created DESC"
      const stats = tables.has("session_message")
        ? `,
          (SELECT COUNT(*) FROM session_message m WHERE m.session_id = s.id) AS message_count,
          (SELECT substr(CASE WHEN json_valid(m.data) THEN json_extract(m.data, '$.text') END, 1, 240)
             FROM session_message m
            WHERE m.session_id = s.id AND m.type = 'user'
            ORDER BY m.seq ASC LIMIT 1) AS preview`
        : ", 0 AS message_count, NULL AS preview"

      for (const row of all(db, `SELECT s.*${stats} FROM session_v2 s WHERE ${where} ${archived} ORDER BY ${order}`)) {
        if (!isRecord(row)) continue
        const id = text(row.id)
        if (!id?.startsWith("ses_")) continue
        sessions.push({
          database,
          id,
          title: title(row.title),
          directory: text(row.directory) ?? "",
          timeCreated: number(row.time_created),
          timeUpdated: number(row.time_updated),
          messageCount: number(row.message_count),
          preview: preview(row.preview),
        })
      }
    }

    let legacySessions = 0
    if (tables.has("session")) {
      const columns = tableColumns(db, "session")
      const where = columns.has("parent_id") ? "s.parent_id IS NULL" : "1"
      const excluded = tables.has("session_v2")
        ? "AND NOT EXISTS (SELECT 1 FROM session_v2 v WHERE v.id = s.id)"
        : ""
      const counted = get(db, `SELECT COUNT(*) AS count FROM session s WHERE ${where} ${excluded}`)
      legacySessions = isRecord(counted) ? number(counted.count) : 0
    }

    return { sessions, legacySessions }
  } finally {
    db.close()
  }
}

function readMessageRows(db: Connection, sessionID: string) {
  return all(
    db,
    "SELECT id, type, data FROM session_message WHERE session_id = $sessionID ORDER BY seq ASC",
    { sessionID },
  ).map((row): { id: string; type: string; data: Record_ } => {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.type !== "string")
      throw new Error("OpenCode returned a malformed session message.")
    const data = parseRecord(row.data)
    if (!data) throw new Error(`OpenCode message ${row.id} is not valid JSON.`)
    return { id: row.id, type: row.type, data }
  })
}

function readParts(db: Connection, sessionID: string) {
  const parts = new Map<string, Record_[]>()
  for (const row of all(
    db,
    "SELECT message_id, type, data FROM session_part WHERE session_id = $sessionID ORDER BY message_id ASC, ordinal ASC",
    { sessionID },
  )) {
    if (!isRecord(row) || typeof row.message_id !== "string" || typeof row.type !== "string") continue
    const data = parseRecord(row.data)
    if (!data) throw new Error(`OpenCode session part for ${row.message_id} is not valid JSON.`)
    const part = typeof data.type === "string" ? data : { ...data, type: row.type }
    const list = parts.get(row.message_id)
    if (list) list.push(part)
    else parts.set(row.message_id, [part])
  }
  return parts
}

function hydrateMedia(db: Connection, messages: ReadonlyArray<{ data: Record_ }>, hasBlob: boolean) {
  const hashes = new Set<string>()
  for (const message of messages) {
    if (Array.isArray(message.data.files))
      for (const file of message.data.files) collectMedia(file, hashes)
    if (Array.isArray(message.data.content))
      for (const part of message.data.content) {
        if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state)) continue
        if (part.state.status !== "completed" && part.state.status !== "error") continue
        if (!Array.isArray(part.state.content)) continue
        for (const item of part.state.content) collectMedia(item, hashes)
      }
  }
  if (hashes.size === 0) return

  const blobs = new Map<string, { mime: string; data: string }>()
  if (hasBlob)
    for (const hash of hashes) {
      const row = get(db, "SELECT mime, data FROM blob WHERE hash = $hash LIMIT 1", { hash })
      if (!isRecord(row)) continue
      const bytes = row.data
      if (!(bytes instanceof Uint8Array)) continue
      blobs.set(hash, {
        mime: text(row.mime) ?? "application/octet-stream",
        data: Buffer.from(bytes).toString("base64"),
      })
    }

  for (const message of messages) {
    if (Array.isArray(message.data.files))
      message.data.files = message.data.files.map((file) => hydrateFile(file, blobs))
    if (Array.isArray(message.data.content))
      for (const part of message.data.content) {
        if (!isRecord(part) || part.type !== "tool" || !isRecord(part.state)) continue
        if (part.state.status !== "completed" && part.state.status !== "error") continue
        if (!Array.isArray(part.state.content)) continue
        part.state.content = part.state.content.map((item) => hydrateToolItem(item, blobs))
      }
  }
}

function collectMedia(value: unknown, hashes: Set<string>) {
  if (!isRecord(value) || typeof value.uri !== "string") return
  const hash = mediaRef.exec(value.uri)?.[1]
  if (hash) hashes.add(hash)
}

function hydrateFile(value: unknown, blobs: ReadonlyMap<string, { mime: string; data: string }>) {
  if (!isRecord(value) || typeof value.uri !== "string") return value
  const hash = mediaRef.exec(value.uri)?.[1]
  if (!hash) return value
  const rest = omitMediaFields(value)
  const mime = text(rest.mime) ?? "application/octet-stream"
  const blob = blobs.get(hash)
  if (!blob)
    return {
      ...rest,
      source: { type: "inline" },
      data: Buffer.from(unavailable(mime, text(rest.name))).toString("base64"),
      mime: "text/plain",
    }
  return { ...rest, source: isRecord(rest.source) ? rest.source : { type: "inline" }, data: blob.data }
}

function omitMediaFields(value: Record_) {
  const result = { ...value }
  delete result.uri
  delete result.bytes
  delete result.width
  delete result.height
  return result
}

function hydrateToolItem(value: unknown, blobs: ReadonlyMap<string, { mime: string; data: string }>) {
  if (!isRecord(value) || value.type !== "file" || typeof value.uri !== "string") return value
  const hash = mediaRef.exec(value.uri)?.[1]
  if (!hash) return value
  const blob = blobs.get(hash)
  if (!blob) return { type: "text", text: unavailable(text(value.mime) ?? "unknown", text(value.name)) }
  const { uri: _, ...rest } = value
  return { ...rest, uri: `data:${blob.mime};base64,${blob.data}` }
}

function unavailable(mime: string, name?: string) {
  return `[media unavailable: ${name === undefined ? mime : `${name} (${mime})`}]`
}

function sessionInfo(row: Record_, directory: string): ExperimentalSessionImportInput["info"] {
  const model = parseRecord(row.model)
  const metadata = parseRecord(row.metadata)
  const outcome = text(row.idle_outcome)
  return {
    id: Session.ID.create(),
    // The server resolves the destination project from `location`; the source id is
    // only carried so the payload names a project like every other session info.
    projectID: text(row.project_id) ?? "global",
    ...(text(row.agent) ? { agent: text(row.agent)! } : {}),
    ...(model && text(model.id) && text(model.providerID)
      ? {
          model: {
            id: text(model.id)!,
            providerID: text(model.providerID)!,
            variant: text(model.variant) ?? "default",
          },
        }
      : {}),
    cost: number(row.cost),
    tokens: {
      input: number(row.tokens_input),
      output: number(row.tokens_output),
      reasoning: number(row.tokens_reasoning),
      cache: { read: number(row.tokens_cache_read), write: number(row.tokens_cache_write) },
    },
    ...(outcome === "succeeded" || outcome === "failed" || outcome === "interrupted" ? { outcome } : {}),
    time: {
      created: number(row.time_created),
      updated: number(row.time_updated),
      ...timeValue("busy", row.time_busy),
      ...timeValue("idle", row.time_idle),
      ...timeValue("viewed", row.time_viewed),
    },
    ...(title(row.title) ? { title: title(row.title) } : {}),
    ...(metadata
      ? { metadata: metadata as NonNullable<ExperimentalSessionImportInput["info"]["metadata"]> }
      : {}),
    location: { directory },
  }
}

function timeValue(key: "busy" | "idle" | "viewed", value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? { [key]: value } : {}
}

function openReadOnly(file: string) {
  // `readonly` is the Bun option; the Node wrapper maps it to `readOnly`. Opening
  // read-only is the guarantee that an import never changes OpenCode's own state.
  return new Database(file, { readonly: true }) as unknown as Connection
}

function tableNames(db: Connection) {
  return new Set(
    all(db, "SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((row) => (isRecord(row) ? text(row.name) : undefined))
      .filter((name): name is string => name !== undefined),
  )
}

function tableColumns(db: Connection, table: string) {
  return new Set(
    all(db, `PRAGMA table_info(${table})`)
      .map((row) => (isRecord(row) ? text(row.name) : undefined))
      .filter((name): name is string => name !== undefined),
  )
}

function all(db: Connection, sql: string, parameters?: Record<string, SQLValue>) {
  const statement = db.query(sql)
  return (parameters === undefined ? statement.all() : statement.all(parameters)) as unknown[]
}

function get(db: Connection, sql: string, parameters?: Record<string, SQLValue>) {
  const statement = db.query(sql)
  return (parameters === undefined ? statement.get() : statement.get(parameters)) as unknown
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function title(value: unknown) {
  const result = text(value)?.trim()
  return result ? result : "Untitled session"
}

function preview(value: unknown) {
  const result = text(value)?.replace(/\s+/g, " ").trim()
  return result ? result : undefined
}

function parseRecord(value: unknown) {
  if (typeof value !== "string") return isRecord(value) ? value : undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resolve(file: string) {
  return path.resolve(file)
}

function canonical(file: string) {
  try {
    return realpathSync.native(file)
  } catch {
    return resolve(file)
  }
}

function isFile(file: string) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function isInside(file: string, root: string) {
  const target = resolve(file).toLowerCase()
  const base = resolve(root).toLowerCase()
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep)
}
