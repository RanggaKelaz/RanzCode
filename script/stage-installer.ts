#!/usr/bin/env bun
// Stages the Windows installer tree under installer/ and optionally runs Inno
// Setup. Called by .github/workflows/release.yml after the CLI and desktop
// builds finish; also usable locally.
//
// Layout produced (matches installer/LarpCode-Setup.iss):
//   installer/app/electron/electron.exe
//   installer/app/desktop-pkg/{package.json,out,resources,node_modules}
//   installer/app/shortcuts/{LarpCode.vbs,larpcode.cmd}
//   installer/deps/tor/{tor.exe,geoip,geoip6}
//   installer/deps/impersonate/{curl-impersonate.exe,LICENSE}
//   installer/deps/electron/electron.exe (or a node_modules fallback)
//
// Tor, curl-impersonate, and Electron are third-party binaries and are never
// committed. The release workflow downloads them into installer/deps before
// this runs (script/fetch-installer-deps.ts and script/fetch-electron.ts).
import { $ } from "bun"
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
process.chdir(root)

const version = (await readFile("VERSION", "utf8")).trim()
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`VERSION must be semver-like, got ${version}`)

const tag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined
if (tag && tag !== `v${version}`) throw new Error(`tag ${tag} does not match VERSION v${version}`)

const stage = path.join(root, "installer", "app")
const pkgDir = path.join(stage, "desktop-pkg")

async function exists(target: string) {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

for (const required of ["packages/desktop/out/main/index.js", "packages/desktop/resources/icons/icon.ico"]) {
  if (!(await exists(required))) throw new Error(`${required} is missing; run the desktop build first`)
}

// Tor and curl-impersonate are release inputs, not source. Fail loudly rather
// than ship an installer whose reset/egress paths silently fall back.
const deps: Array<[string, string]> = [
  ["installer/deps/tor/tor.exe", "tor.exe"],
  ["installer/deps/tor/geoip", "geoip"],
  ["installer/deps/impersonate/curl-impersonate.exe", "curl-impersonate.exe"],
  ["installer/deps/impersonate/LICENSE", "curl-impersonate LICENSE"],
]
const missing = []
for (const [file, label] of deps) if (!(await exists(file))) missing.push(`${label} (${file})`)
if (missing.length > 0) {
  throw new Error(
    [
      "installer deps are missing:",
      ...missing.map((item) => `  - ${item}`),
      "Run script/fetch-installer-deps.ts or place the binaries manually (see installer/deps/README.md).",
    ].join("\n"),
  )
}

await rm(stage, { recursive: true, force: true })
await mkdir(pkgDir, { recursive: true })

await cp("packages/desktop/out", path.join(pkgDir, "out"), { recursive: true })
await cp("packages/desktop/resources", path.join(pkgDir, "resources"), { recursive: true })

// The staged package.json is what Electron reads for app.getVersion(). Do not
// ship the workspace manifest: it carries devDependencies and workspace links.
const manifest = (await Bun.file("packages/desktop/package.json").json()) as {
  type?: string
  dependencies?: Record<string, string>
}
await writeFile(
  path.join(pkgDir, "package.json"),
  JSON.stringify(
    {
      name: "larpcode-desktop",
      productName: "LarpCode",
      version,
      type: manifest.type ?? "module",
      main: "./out/main/index.js",
      dependencies: manifest.dependencies ?? {},
    },
    null,
    2,
  ) + "\n",
)

// Runtime dependencies are the five standalone packages in the manifest.
// Workspace code is already bundled into out/ by electron-vite.
await $`bun install --cwd ${pkgDir} --production --ignore-scripts --no-save`

// Electron itself is copied verbatim so the launcher can run
// `electron.exe <install>/desktop-pkg`. The release workflow stages a verified
// download under installer/deps/electron; the node_modules locations remain as
// fallbacks for local builds. Bun's isolated install may leave only the virtual
// store copy, so scan that too.
async function findElectronRuntime() {
  const candidates = [
    process.env.LARPCODE_ELECTRON_DIR,
    "installer/deps/electron",
    "packages/desktop/node_modules/electron/dist",
    "node_modules/electron/dist",
  ].filter((dir): dir is string => Boolean(dir))

  for (const dir of candidates) if (await exists(path.join(dir, "electron.exe"))) return dir

  try {
    for (const entry of await readdir(path.join("node_modules", ".bun"))) {
      if (!entry.startsWith("electron@")) continue
      const dir = path.join("node_modules", ".bun", entry, "node_modules", "electron", "dist")
      if (await exists(path.join(dir, "electron.exe"))) return dir
    }
  } catch {}

  return undefined
}

const electronDir = await findElectronRuntime()
if (!electronDir) {
  throw new Error(
    [
      "Electron runtime not found.",
      "Run `bun run script/fetch-electron.ts` (release builds) or `bun install` in packages/desktop.",
      "Searched:",
      "  - $LARPCODE_ELECTRON_DIR",
      "  - installer/deps/electron",
      "  - packages/desktop/node_modules/electron/dist",
      "  - node_modules/electron/dist",
      "  - node_modules/.bun/electron@*/node_modules/electron/dist",
    ].join("\n"),
  )
}
await cp(electronDir, path.join(stage, "electron"), { recursive: true })

await cp("shortcuts", path.join(stage, "shortcuts"), { recursive: true })

console.log(`staged LarpCode ${version} into installer/app`)

if (process.env.LARPCODE_SKIP_ISCC === "1") process.exit(0)

const isccCandidates = [
  process.env.ISCC,
  "C:/Program Files (x86)/Inno Setup 6/ISCC.exe",
  "C:/Program Files/Inno Setup 6/ISCC.exe",
].filter(Boolean) as string[]
const iscc = (await Promise.all(isccCandidates.map(async (file) => ((await exists(file)) ? file : undefined)))).find(
  Boolean,
)
if (!iscc) throw new Error("ISCC.exe not found; install Inno Setup 6 or set ISCC")

await $`${iscc} /DAppVersion=${version} ${path.join("installer", "LarpCode-Setup.iss")}`
console.log(`installer written to installer/dist/LarpCode-Setup.exe`)
