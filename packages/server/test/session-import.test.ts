import { expect } from "bun:test"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const SessionResponse = Schema.Struct({ data: Schema.toEncoded(Session.Info) })
const SessionsResponse = Schema.Struct({ data: Schema.Array(Schema.toEncoded(Session.Info)) })

const setup = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { version: "test" },
    database: { path: ":memory:" },
    fs: { filewatcher: false },
  })
  return (path: string, body?: unknown, status = 200) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`http://opencode.local${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      const json: unknown = await response.json()
      expect(response.status).toBe(status)
      return json
    })
})

it.live("preserves imported parentID through HTTP import, read, and parent filter", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const parent = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", { title: "Parent" }))
    const id = Session.ID.create()
    const imported = Schema.decodeUnknownSync(SessionResponse)(
      yield* request("/api/experimental/session/import", {
        info: { ...parent.data, id, parentID: parent.data.id, title: "Imported child" },
        messages: [],
      }),
    )
    const read = Schema.decodeUnknownSync(SessionResponse)(yield* request(`/api/session/${id}`))
    const children = Schema.decodeUnknownSync(SessionsResponse)(
      yield* request(`/api/session?parentID=${parent.data.id}`),
    )
    expect({
      imported: imported.data.parentID,
      read: read.data.parentID,
      children: children.data.map((child) => child.id),
    }).toEqual({ imported: parent.data.id, read: parent.data.id, children: [id] })
  }).pipe(Effect.scoped),
)

it.live("upgrades native data in transcripts exported before v2.1", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const template = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", {}))
    const id = Session.ID.create()
    yield* request("/api/experimental/session/import", {
      info: { ...template.data, id },
      messages: [
        {
          id: "msg_legacy",
          type: "assistant",
          agent: "build",
          model: { providerID: "anthropic", id: "claude" },
          providerState: { finish: "kept" },
          content: [
            { type: "text", text: "Answer", state: { signature: "text" } },
            { type: "reasoning", text: "Thinking", state: { signature: "reasoning" } },
            {
              type: "tool",
              id: "call",
              name: "web_search",
              executed: true,
              providerState: { call: "kept" },
              providerResultState: { result: "kept" },
              state: { status: "completed", input: {}, content: [{ type: "text", text: "Found" }] },
              time: { created: 1, ran: 1, completed: 2 },
            },
          ],
          time: { created: 1, completed: 2 },
        },
        {
          id: "msg_compaction",
          type: "compaction",
          status: "completed",
          reason: "manual",
          summary: "Summary",
          recent: "[User]: kept",
          providerState: { compaction: "kept" },
          time: { created: 3 },
        },
        { id: "msg_moved", type: "location-switched", location: { directory: "/moved" }, time: { created: 4 } },
      ],
    })
    expect(yield* request(`/api/session/${id}/message?order=asc`)).toMatchObject({
      data: [
        {
          id: "msg_legacy",
          native: { finish: "kept" },
          content: [
            { type: "text", native: { signature: "text" } },
            { type: "reasoning", native: { signature: "reasoning" } },
            { type: "tool", native: { call: "kept", result: "kept" } },
          ],
        },
        { id: "msg_compaction", native: { compaction: "kept" }, metadata: { recent: "[User]: kept" } },
        { id: "msg_moved", location: { directory: "/moved" } },
      ],
    })
  }).pipe(Effect.scoped),
)

it.live("keeps unsettled messages and settles them as interrupted", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const template = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", {}))
    const id = Session.ID.create()
    const importedAssistant = {
      id: "msg_imported_latest",
      type: "assistant",
      agent: "build",
      model: { providerID: "anthropic", id: "claude" },
      content: [
        { type: "reasoning", text: "latest thought", time: { created: 10 } },
        {
          type: "tool",
          id: "call_latest",
          name: "shell",
          state: { status: "running", input: { command: "bun test" }, metadata: {} },
          time: { created: 10 },
        },
      ],
      time: { created: 10 },
    }
    const importedShell = {
      id: "msg_imported_shell",
      type: "shell",
      shellID: "sh_latest",
      command: "bun test",
      status: "running",
      time: { created: 11 },
    }
    yield* request("/api/experimental/session/import", {
      info: { ...template.data, id },
      messages: [importedAssistant, importedShell],
    })

    const appendedAssistant = {
      id: "msg_appended_latest",
      type: "assistant",
      agent: "build",
      model: { providerID: "anthropic", id: "claude" },
      content: [{ type: "text", text: "appended thought" }],
      time: { created: 12 },
    }
    const appendedCompaction = {
      id: "msg_appended_compaction",
      type: "compaction",
      status: "running",
      reason: "auto",
      summary: "partial summary",
      time: { created: 13 },
    }
    const appended = yield* request(`/api/experimental/session/${id}/import`, {
      messages: [appendedAssistant, appendedCompaction],
    })
    expect(appended).toEqual({ data: { appended: 2 } })

    expect(yield* request(`/api/session/${id}/message?order=asc`)).toMatchObject({
      data: [
        {
          id: "msg_imported_latest",
          time: { created: 10, completed: expect.any(Number) },
          content: [
            { type: "reasoning", text: "latest thought" },
            { type: "tool", name: "shell", state: { status: "running", input: { command: "bun test" } } },
          ],
        },
        { id: "msg_imported_shell", status: "killed", time: { created: 11, completed: expect.any(Number) } },
        {
          id: "msg_appended_latest",
          time: { created: 12, completed: expect.any(Number) },
          content: [{ type: "text", text: "appended thought" }],
        },
        {
          id: "msg_appended_compaction",
          status: "failed",
          error: { type: "compaction.interrupted" },
        },
      ],
    })
  }).pipe(Effect.scoped),
)

it.live("rejects an invalid imported message without creating the session", () =>
  Effect.gen(function* () {
    const request = yield* setup
    const template = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", {}))
    const id = Session.ID.create()
    const error = yield* request(
      "/api/experimental/session/import",
      { info: { ...template.data, id }, messages: [{ id: "msg_invalid", type: "assistant" }] },
      400,
    )
    expect(error).toMatchObject({
      _tag: "InvalidRequestError",
      kind: "Payload",
      message: expect.stringContaining(`["messages"][0]`),
    })
    expect(yield* request(`/api/session/${id}`, undefined, 404)).toMatchObject({ _tag: "SessionNotFoundError" })
  }).pipe(Effect.scoped),
)
;["missing", "self"].forEach((parent) => {
  it.live(`rejects a ${parent} parent without creating the imported session`, () =>
    Effect.gen(function* () {
      const request = yield* setup
      const template = Schema.decodeUnknownSync(SessionResponse)(yield* request("/api/session", {}))
      const id = Session.ID.create()
      const parentID = parent === "self" ? id : Session.ID.create()
      const error = yield* request(
        "/api/experimental/session/import",
        { info: { ...template.data, id, parentID }, messages: [] },
        404,
      )
      expect(error).toMatchObject({ _tag: "SessionNotFoundError", sessionID: parentID })
      expect(yield* request(`/api/session/${id}`, undefined, 404)).toMatchObject({
        _tag: "SessionNotFoundError",
        sessionID: id,
      })
    }).pipe(Effect.scoped),
  )
})
