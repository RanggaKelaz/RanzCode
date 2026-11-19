import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { findOpenCodeDatabases, listOpenCodeSessions, readOpenCodeSession } from "../../src/util/opencode-import"
import { tmpdir } from "../fixture/fixture"

const hash = "a".repeat(64)
const missing = "b".repeat(64)
const saved = new Map<string, string | undefined>()
const keys = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "OPENCODE_DB",
  "LARPCODE_OPENCODE_DB",
  "LARPCODE_OPENCODE_DATA",
  "LARPCODE_DESKTOP_XDG_ROOT",
]

function isolate(directory: string, database: string) {
  for (const key of keys) saved.set(key, process.env[key])
  process.env.HOME = directory
  process.env.USERPROFILE = directory
  process.env.APPDATA = path.join(directory, "AppData", "Roaming")
  process.env.LOCALAPPDATA = path.join(directory, "AppData", "Local")
  process.env.XDG_DATA_HOME = path.join(directory, "xdg-data")
  process.env.XDG_CONFIG_HOME = path.join(directory, "xdg-config")
  delete process.env.OPENCODE_DB
  delete process.env.LARPCODE_OPENCODE_DB
  delete process.env.LARPCODE_OPENCODE_DATA
  delete process.env.LARPCODE_DESKTOP_XDG_ROOT
  process.env.LARPCODE_OPENCODE_DB = database
  process.env.LARPCODE_OPENCODE_DATA = path.dirname(database)
}

afterEach(() => {
  for (const key of keys) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

function writeOpenCodeDatabase(file: string, legacy = false) {
  mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file)
  db.exec(legacy ? legacySchema : modernSchema)
  if (legacy) {
    db.query("INSERT INTO session VALUES ('ses_legacy', NULL, 'Legacy session', '/old', 1, 2)").run()
    db.close()
    return
  }

  const insertSession = db.query(
    `INSERT INTO session_v2 (
      id, project_id, parent_id, title, directory, agent, model, cost,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
      idle_outcome, metadata, time_created, time_updated, time_busy, time_idle, time_viewed, time_archived
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  insertSession.run(
    "ses_root",
    "proj_source",
    null,
    "Imported transcript",
    "C:/work/source",
    "build",
    JSON.stringify({ id: "gpt-5", providerID: "openai", variant: "default" }),
    0.25,
    10,
    20,
    0,
    1,
    2,
    "succeeded",
    JSON.stringify({ origin: "opencode" }),
    1_700_000_000_000,
    1_700_000_100_000,
    1_700_000_000_500,
    1_700_000_100_000,
    1_700_000_050_000,
    null,
  )
  insertSession.run(
    "ses_child",
    "proj_source",
    "ses_root",
    "Subagent transcript",
    "C:/work/source",
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    null,
    null,
    1,
    2,
    null,
    null,
    null,
    null,
  )
  insertSession.run(
    "ses_archived",
    "proj_source",
    null,
    "Archived transcript",
    "C:/work/source",
    null,
    null,
    0,
    0,
    0,
    0,
    0,
    0,
    null,
    null,
    1,
    2,
    null,
    null,
    null,
    3,
  )
  db.query("INSERT INTO session VALUES ('ses_legacy', NULL, 'Legacy session', '/old', 1, 2)").run()

  const insertMessage = db.query("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)")
  insertMessage.run(
    "msg_user",
    "ses_root",
    "user",
    1,
    JSON.stringify({
      text: "Please fix the parser",
      time: { created: 1_700_000_000_000 },
      files: [
        {
          data: "",
          mime: "image/png",
          source: { type: "inline" },
          name: "shot.png",
          uri: `media:${hash}`,
          bytes: 3,
        },
      ],
    }),
  )
  insertMessage.run(
    "msg_assistant",
    "ses_root",
    "assistant",
    2,
    JSON.stringify({
      agent: "build",
      model: { id: "gpt-5", providerID: "openai" },
      content: [{ type: "text", text: "inline text" }],
      time: { created: 1_700_000_000_100, completed: 1_700_000_000_200 },
    }),
  )
  insertMessage.run(
    "msg_compact",
    "ses_root",
    "compaction",
    3,
    JSON.stringify({
      status: "completed",
      reason: "manual",
      summary: "summary",
      metadata: { keepID: "msg_user" },
      time: { created: 1_700_000_000_300 },
    }),
  )
  insertMessage.run(
    "msg_running",
    "ses_root",
    "assistant",
    4,
    JSON.stringify({
      agent: "build",
      model: { id: "gpt-5", providerID: "openai" },
      content: [],
      time: { created: 1_700_000_000_400 },
    }),
  )

  const insertPart = db.query("INSERT INTO session_part VALUES (?, ?, ?, ?, ?)")
  insertPart.run("msg_assistant", "ses_root", "text", 0, JSON.stringify({ text: "part text" }))
  insertPart.run(
    "msg_assistant",
    "ses_root",
    "tool",
    1,
    JSON.stringify({
      id: "call_1",
      name: "read",
      state: {
        status: "completed",
        input: {},
        content: [{ type: "file", uri: `media:${missing}`, mime: "image/png", name: "missing.png" }],
      },
      time: { created: 1_700_000_000_150 },
    }),
  )
  insertPart.run(
    "msg_running",
    "ses_root",
    "reasoning",
    0,
    JSON.stringify({ text: "latest thought", time: { created: 1_700_000_000_400 } }),
  )
  insertPart.run(
    "msg_running",
    "ses_root",
    "tool",
    1,
    JSON.stringify({
      id: "call_latest",
      name: "shell",
      state: { status: "running", input: { command: "bun test" }, metadata: {} },
      time: { created: 1_700_000_000_450 },
    }),
  )

  db.query("INSERT INTO blob VALUES (?, ?, ?)").run(hash, "image/png", new Uint8Array([1, 2, 3]))
  db.close()
}

const modernSchema = `
  CREATE TABLE session_v2 (
    id text PRIMARY KEY, project_id text, parent_id text, title text, directory text, agent text, model text,
    cost real, tokens_input integer, tokens_output integer, tokens_reasoning integer,
    tokens_cache_read integer, tokens_cache_write integer, idle_outcome text, metadata text,
    time_created integer, time_updated integer, time_busy integer, time_idle integer, time_viewed integer,
    time_archived integer
  );
  CREATE TABLE session_message (
    id text PRIMARY KEY, session_id text, type text, seq integer, data text
  );
  CREATE TABLE session_part (
    message_id text, session_id text, type text, ordinal integer, data text
  );
  CREATE TABLE blob (hash text PRIMARY KEY, mime text, data blob);
  CREATE TABLE session (
    id text PRIMARY KEY, parent_id text, title text, directory text, time_created integer, time_updated integer
  );
`

const legacySchema = `
  CREATE TABLE session (
    id text PRIMARY KEY, parent_id text, title text, directory text, time_created integer, time_updated integer
  );
`

describe("OpenCode import reader", () => {
  test("lists root sessions and reports pre-2 sessions", async () => {
    await using state = await tmpdir()
    const file = path.join(state.path, "opencode", "opencode.db")
    writeOpenCodeDatabase(file, false)
    isolate(state.path, file)

    const result = listOpenCodeSessions()

    expect(result.errors).toEqual([])
    expect(result.databases).toHaveLength(1)
    expect(result.legacySessions).toBe(1)
    expect(result.sessions.map((session) => session.id)).toEqual(["ses_root"])
    expect(result.sessions[0]).toMatchObject({
      title: "Imported transcript",
      directory: "C:/work/source",
      messageCount: 4,
      preview: "Please fix the parser",
    })
  })

  test("decodes a transcript with fresh ids, parts, and hydrated media", async () => {
    await using state = await tmpdir()
    const file = path.join(state.path, "opencode", "opencode.db")
    writeOpenCodeDatabase(file, false)
    isolate(state.path, file)

    const data = readOpenCodeSession({
      database: file,
      sessionID: "ses_root",
      directory: "C:/work/target",
    })
    const messages = data.messages as Array<Record<string, any>>

    expect(data.info.title).toBe("Imported transcript")
    expect(data.info.location).toEqual({ directory: "C:/work/target" })
    expect(data.info.projectID).toBe("proj_source")
    expect(data.info.id).toStartWith("ses_")
    expect(messages).toHaveLength(4)
    expect(messages.map((message) => message.id)).not.toContain("msg_user")

    const user = messages[0]!
    expect(user.type).toBe("user")
    expect(user.text).toBe("Please fix the parser")
    expect(user.time.created).toBe(1_700_000_000_000)
    expect(user.files[0]).toMatchObject({ data: "AQID", mime: "image/png", source: { type: "inline" } })
    expect(user.files[0].uri).toBeUndefined()

    const assistant = messages[1]!
    expect(assistant.type).toBe("assistant")
    expect(assistant.content.map((part: { type: string; text?: string }) => part.type)).toEqual([
      "text",
      "tool",
      "text",
    ])
    expect(assistant.content[0].text).toBe("part text")
    expect(assistant.content[1].state.content[0]).toEqual({
      type: "text",
      text: "[media unavailable: missing.png (image/png)]",
    })
    expect(assistant.content[2].text).toBe("inline text")

    const compaction = messages[2]!
    expect(compaction.type).toBe("compaction")
    expect(compaction.metadata.keepID).toBe(user.id)

    // The latest assistant can still be in progress; its parts hold the newest thought and command.
    const running = messages[3]!
    expect(running.type).toBe("assistant")
    expect(running.time.completed).toBeUndefined()
    expect(running.content[0]).toMatchObject({ type: "reasoning", text: "latest thought" })
    expect(running.content[1]).toMatchObject({
      type: "tool",
      name: "shell",
      state: { status: "running", input: { command: "bun test" } },
    })

    // Reading must leave OpenCode's own rows exactly as they were.
    const source = new Database(file, { readonly: true })
    expect(source.query("SELECT title FROM session_v2 WHERE id = 'ses_root'").get()).toEqual({
      title: "Imported transcript",
    })
    expect(source.query("SELECT COUNT(*) AS count FROM session_message").get()).toEqual({ count: 4 })
    source.close()

    const again = readOpenCodeSession({
      database: file,
      sessionID: "ses_root",
      directory: "C:/work/target",
    })
    expect(again.info.id).not.toBe(data.info.id)
    expect((again.messages as Array<Record<string, any>>)[0]!.id).not.toBe(user.id)
  })

  test("asks for an OpenCode migration when only the legacy table exists", async () => {
    await using state = await tmpdir()
    const file = path.join(state.path, "opencode", "opencode.db")
    writeOpenCodeDatabase(file, true)
    isolate(state.path, file)

    expect(findOpenCodeDatabases()).toEqual([path.resolve(file)])
    expect(listOpenCodeSessions()).toMatchObject({ sessions: [], legacySessions: 1 })
    expect(() => readOpenCodeSession({ database: file, sessionID: "ses_legacy", directory: state.path })).toThrow(
      "legacy session format",
    )
  })

  test("never reads a database inside LarpCode's own data root", async () => {
    await using state = await tmpdir()
    const file = path.join(state.path, "larpcode", "opencode.db")
    writeOpenCodeDatabase(file, false)
    isolate(state.path, file)
    process.env.LARPCODE_DESKTOP_XDG_ROOT = path.dirname(file)

    expect(findOpenCodeDatabases()).toEqual([])
    expect(listOpenCodeSessions()).toMatchObject({ databases: [], sessions: [] })
  })
})
