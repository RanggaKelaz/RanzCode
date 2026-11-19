import { NodeServices } from "@effect/platform-node"
import { EffectFlock } from "@opencode/util/effect-flock"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Effect, FileSystem, Layer, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Updater } from "../../src/services/updater"

const root = process.env.RANZCODE_UPDATER_TEST_DIR
if (!root) throw new Error("RANZCODE_UPDATER_TEST_DIR is required")
const releaseVersion = "1.0.1"
const archiveName = `RanzCode-v${releaseVersion}-linux-x64.tar.gz`
const archiveUrl = `https://github.com/RanggaKelaz/RanzCode/releases/download/v${releaseVersion}/${archiveName}`
const checksumUrl = `${archiveUrl}.sha256`
const latestUrl = "https://github.com/RanggaKelaz/RanzCode/releases/latest"
const latestReleaseUrl = `https://github.com/RanggaKelaz/RanzCode/releases/tag/v${releaseVersion}`
const archiveBytes = Buffer.from("test release archive contents")
const checksum = createHash("sha256").update(archiveBytes).digest("hex")

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const executable = path.join(root, "bin", "ranzcode")
  const config = path.join(root, "config", "opencode.json")
  const data = path.join(root, "data", "sentinel")
  yield* fs.makeDirectory(path.dirname(executable), { recursive: true })
  yield* fs.makeDirectory(path.dirname(config), { recursive: true })
  yield* fs.makeDirectory(path.dirname(data), { recursive: true })
  yield* fs.writeFileString(executable, "old ranzcode binary")
  yield* fs.writeFileString(config, "existing OpenCode config")
  yield* fs.writeFileString(data, "existing OpenCode data")

  const global = Global.make({
    home: path.join(root, "home"),
    data: path.join(root, "data"),
    cache: path.join(root, "cache"),
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    tmp: path.join(root, "tmp"),
    bin: path.join(root, "local-bin"),
    log: path.join(root, "log"),
    repos: path.join(root, "repos"),
  })
  const commands: Array<{ command: string; args: string[] }> = []
  const versionCheckEnv: Record<string, string> = {}
  const appProcess = AppProcess.Service.of({
    ...spawner,
    run: (input) =>
      Effect.suspend(() => {
        if (input._tag !== "StandardCommand") return Effect.die("Unexpected streaming process")
        const command = input.command
        const args = input.args.map(String)
        commands.push({ command, args })
        let result = {
          exitCode: 0,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
        }
        if (command === "curl") {
          const url = args.at(-1)!
          if (url === latestUrl) {
            result.stdout = Buffer.from(latestReleaseUrl)
          } else if (args.includes("--output")) {
            const target = args[args.indexOf("--output") + 1]!
            writeFileSync(target, archiveBytes)
          } else if (url === checksumUrl) {
            const digest = process.env.RANZCODE_UPDATER_BAD_CHECKSUM === "1" ? "0".repeat(64) : checksum
            result.stdout = Buffer.from(`${digest}  ${archiveName}\n`)
          } else {
            result.exitCode = 22
            result.stderr = Buffer.from(`Unexpected curl URL: ${url}`)
          }
        } else if (command === "tar") {
          const destination = args[args.indexOf("--directory") + 1]!
          mkdirSync(destination, { recursive: true })
          writeFileSync(path.join(destination, "ranzcode"), "new ranzcode binary v1.0.1")
        } else if (path.basename(command) === "ranzcode" && args[0] === "--version") {
          if (input.options.env) Object.assign(versionCheckEnv, input.options.env)
          result.stdout = Buffer.from(`ranzcode v${releaseVersion}\n`)
        } else {
          result.exitCode = 127
          result.stderr = Buffer.from(`Unexpected command: ${command}`)
        }
        return Effect.succeed({
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutTruncated: false,
          stderrTruncated: false,
        })
      }),
    runStream: () => Stream.die("Unexpected streaming process"),
  })
  const updater = yield* Updater.Service.pipe(
    Effect.provide(Updater.layer),
    Effect.provide(
      LayerNode.compile(EffectFlock.node, {
        replacements: [Global.node.replace(Layer.succeed(Global.Service, global))],
      }),
    ),
    Effect.provideService(Global.Service, global),
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      realPath: (input) => (input === process.execPath ? Effect.succeed(executable) : fs.realPath(input)),
    }),
    Effect.provideService(AppProcess.Service, appProcess),
  )
  const latest = yield* updater.latest()
  const upgradeError = yield* updater.upgrade("standalone", releaseVersion).pipe(Effect.flip, Effect.option)
  return {
    latest,
    executable: readFileSync(executable, "utf8"),
    config: readFileSync(config, "utf8"),
    data: readFileSync(data, "utf8"),
    commands,
    versionCheckEnv,
    upgradeError: upgradeError._tag === "Some" ? upgradeError.value.message : undefined,
  }
})

const result = await Effect.runPromise(main.pipe(Effect.provide(NodeServices.layer)))
console.log(JSON.stringify(result))
