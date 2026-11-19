import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Session } from "@opencode/schema/session"
import { batches } from "@opencode/util/session-import"
import { Effect, Option, Schema } from "effect"
import { EOL } from "node:os"
import path from "node:path"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"

export default Runtime.handler(
  Commands.commands.session.commands.import,
  Effect.fn("cli.session.import")(function* (input) {
    const text = yield* Effect.tryPromise({
      try: () =>
        input.file.startsWith("http://") || input.file.startsWith("https://")
          ? fetch(input.file).then((response) => {
              if (!response.ok) throw new Error(`Failed to fetch session data: ${response.statusText}`)
              return response.text()
            })
          : Bun.file(input.file).text(),
      catch: (cause) =>
        new Error(`Failed to read session data: ${cause instanceof Error ? cause.message : String(cause)}`),
    })
    // The server validates the transcript, including exports written by earlier releases.
    const data = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
      text,
    )
    const server = yield* ServerConnection.resolve()
    const client = OpenCode.make({
      baseUrl: server.endpoint.url,
      headers: Service.headers(server.endpoint),
    })
    const location = yield* Effect.promise(() =>
      client.location.get({
        location: { directory: path.resolve(Option.getOrElse(input.directory, () => process.cwd())) },
      }),
    )
    const messages = Array.isArray(data.messages) ? data.messages : []
    const chunks = batches(messages)
    const headers = { ...Service.headers(server.endpoint), "content-type": "application/json" }
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/session/import", server.endpoint.url), {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...data,
          messages: chunks[0] ?? [],
          location: { directory: location.directory },
        }),
      }),
    )
    if (response.status === 409) {
      process.stderr.write(`Session already exists${EOL}`)
      return
    }
    if (!response.ok) yield* Effect.fail(new Error(`Failed to import session: ${response.statusText}`))
    const imported = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ data: Session.Info })))(
      yield* Effect.promise(() => response.text()),
    )
    let done = chunks[0]?.length ?? 0
    for (let index = 1; index < chunks.length; index++) {
      const chunk = chunks[index]!
      const appended = yield* Effect.promise(() =>
        fetch(
          new URL(`/api/experimental/session/${encodeURIComponent(imported.data.id)}/import`, server.endpoint.url),
          { method: "POST", headers, body: JSON.stringify({ messages: chunk }) },
        ),
      )
      if (!appended.ok) {
        // Leave no truncated copy behind when a later batch fails.
        yield* Effect.promise(() =>
          fetch(new URL(`/api/session/${encodeURIComponent(imported.data.id)}`, server.endpoint.url), {
            method: "DELETE",
            headers: Service.headers(server.endpoint),
          }).catch(() => undefined),
        )
        yield* Effect.fail(new Error(`Failed to import session messages: ${appended.statusText || appended.status}`))
      }
      yield* Effect.promise(async () => {
        await appended.body?.cancel()
      })
      done += chunk.length
      if (process.stderr.isTTY) process.stderr.write(`Imported ${done}/${messages.length} messages…\r`)
    }
    if (process.stderr.isTTY && chunks.length > 1) process.stderr.write("\r\x1b[K")
    process.stdout.write(`Imported session: ${imported.data.id}${EOL}`)
  }),
)
