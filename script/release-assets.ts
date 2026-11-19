#!/usr/bin/env bun
// Assembles and verifies the files attached to a GitHub release.
//
// Inputs (produced earlier in the release job):
//   installer/dist/LarpCode-Setup.exe
//   packages/cli/dist-cli/cli-windows-x64-baseline/bin/opencode.exe
//   script/install-cli.ps1
//
// Output: dist/release/
//   LarpCode-Setup.exe
//   larpcode.exe
//   install-cli.ps1
//   LarpCode-<version>-source.zip
//   update.json
//   cli.json
//   SHA256SUMS
//
// The script fails if the CLI does not report the expected version, if an
// input is missing or implausibly small, or if a generated manifest is invalid.
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { $ } from "bun"

const root = path.resolve(import.meta.dir, "..")
process.chdir(root)

const version = (await readFile("VERSION", "utf8")).trim()
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`VERSION must be semver-like, got ${version}`)

const tag = process.env.LARPCODE_TAG || `v${version}`
if (tag !== `v${version}`) throw new Error(`LARPCODE_TAG ${tag} does not match VERSION v${version}`)

const repository = process.env.GITHUB_REPOSITORY || "Tazmyan/LarpCode"
const updateUrl =
  process.env.LARPCODE_UPDATE_URL || `https://github.com/${repository}/releases/latest/download/LarpCode-Setup.exe`
if (!updateUrl.startsWith("https://")) throw new Error(`LARPCODE_UPDATE_URL must be https, got ${updateUrl}`)

const installer = "installer/dist/LarpCode-Setup.exe"
const cli = "packages/cli/dist-cli/cli-windows-x64-baseline/bin/opencode.exe"
const installScript = "script/install-cli.ps1"
const release = path.join(root, "dist", "release")
const installerName = "LarpCode-Setup.exe"
const cliName = "larpcode.exe"
const sourceName = `LarpCode-${version}-source.zip`

async function exists(target: string) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function require(file: string, label: string, minimum: number) {
  if (!(await exists(file))) throw new Error(`${label} is missing: ${file}`)
  const size = (await stat(file)).size
  if (size < minimum) throw new Error(`${label} is suspiciously small: ${file} (${size} bytes)`)
}

function sha256(file: string) {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256")
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")))
  })
}

await require(installer, "installer", 50 * 1024 * 1024)
await require(cli, "standalone CLI", 20 * 1024 * 1024)
await require(installScript, "CLI install script", 1024)

if (process.platform !== "win32") throw new Error("release-assets.ts runs on Windows")
const probe = Bun.spawnSync([path.resolve(cli), "--version"])
if (probe.exitCode !== 0) {
  throw new Error(`larpcode.exe --version failed: ${probe.stderr.toString().trim() || `exit ${probe.exitCode}`}`)
}
const reported = probe.stdout.toString().trim()
if (reported !== `larpcode v${version}`) {
  throw new Error(`larpcode.exe --version reported ${JSON.stringify(reported)}, expected "larpcode v${version}"`)
}

await rm(release, { recursive: true, force: true })
await mkdir(release, { recursive: true })

await copyFile(installer, path.join(release, installerName))
await copyFile(cli, path.join(release, cliName))
await copyFile(installScript, path.join(release, "install-cli.ps1"))
await $`git archive --format=zip --prefix=LarpCode-${version}/ -o ${path.join(release, sourceName)} HEAD`

const installerSha = await sha256(path.join(release, installerName))
const cliSha = await sha256(path.join(release, cliName))

await Bun.write(
  path.join(release, "update.json"),
  JSON.stringify({ version, url: updateUrl, sha256: installerSha, notes: "" }, null, 2) + "\n",
)
await Bun.write(
  path.join(release, "cli.json"),
  JSON.stringify(
    {
      version,
      assets: {
        "win32-x64": {
          url: `https://github.com/${repository}/releases/download/${tag}/${cliName}`,
          sha256: cliSha,
        },
      },
    },
    null,
    2,
  ) + "\n",
)

const names = (await readdir(release, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS")
  .map((entry) => entry.name)
  .sort()
const sums = await Promise.all(names.map(async (name) => `${await sha256(path.join(release, name))}  ${name}`))
await Bun.write(path.join(release, "SHA256SUMS"), sums.join("\n") + "\n")

// Read the manifests back so a typo cannot ship a feed the CLIs reject.
const update = (await Bun.file(path.join(release, "update.json")).json()) as {
  version?: string
  url?: string
  sha256?: string
}
if (update.version !== version) throw new Error("update.json has the wrong version")
if (update.url !== updateUrl) throw new Error("update.json has the wrong url")
if (update.sha256 !== installerSha) throw new Error("update.json has the wrong installer sha256")

const manifest = (await Bun.file(path.join(release, "cli.json")).json()) as {
  version?: string
  assets?: Record<string, { url?: string; sha256?: string }>
}
if (manifest.version !== version) throw new Error("cli.json has the wrong version")
if (manifest.assets?.["win32-x64"]?.sha256 !== cliSha) throw new Error("cli.json has the wrong CLI sha256")
if (!manifest.assets?.["win32-x64"]?.url?.endsWith(`/${tag}/${cliName}`)) {
  throw new Error("cli.json has the wrong CLI url")
}

console.log(`release assets for LarpCode ${version} (${tag}):`)
for (const line of sums) {
  const [hash, name] = line.split("  ")
  const size = (await stat(path.join(release, name!))).size
  console.log(`  ${name}  ${(size / 1024 / 1024).toFixed(1)} MB  ${hash!.slice(0, 12)}…`)
}
