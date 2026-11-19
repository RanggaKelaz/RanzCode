import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const linuxX64 = process.platform === "linux" && process.arch === "x64" ? test : test.skip

linuxX64("standalone Linux updates from RanzCode GitHub Releases without touching OpenCode data", async () => {
  const result = await runFixture()
  expect(result.latest).toBe("1.0.1")
  expect(result.executable).toBe("new ranzcode binary v1.0.1")
  expect(result.config).toBe("existing OpenCode config")
  expect(result.data).toBe("existing OpenCode data")
  const curlUrls = result.commands.filter((command) => command.command === "curl").map((command) => command.args.at(-1))
  expect(curlUrls).toEqual([
    "https://github.com/RanggaKelaz/RanzCode/releases/latest",
    "https://github.com/RanggaKelaz/RanzCode/releases/download/v1.0.1/RanzCode-v1.0.1-linux-x64.tar.gz",
    "https://github.com/RanggaKelaz/RanzCode/releases/download/v1.0.1/RanzCode-v1.0.1-linux-x64.tar.gz.sha256",
  ])
  const latestCheck = result.commands.find((command) => command.args.at(-1) === curlUrls[0])
  expect(latestCheck?.args).toContain("--write-out")
  expect(latestCheck?.args).toContain("%{url_effective}")
  expect(result.commands.map((command) => command.command)).toContain("tar")
  expect(result.upgradeError).toBeUndefined()
  expect(result.versionCheckEnv.HOME).toStartWith(path.join(result.root, "cache", "ranzcode-update-"))
  expect(result.versionCheckEnv.XDG_DATA_HOME).not.toBe(process.env.XDG_DATA_HOME)
})

linuxX64("a checksum mismatch leaves the installed RanzCode executable and OpenCode data unchanged", async () => {
  const result = await runFixture(true)
  expect(result.upgradeError).toContain("incomplete or modified")
  expect(result.executable).toBe("old ranzcode binary")
  expect(result.config).toBe("existing OpenCode config")
  expect(result.data).toBe("existing OpenCode data")
  expect(result.commands.map((command) => command.command)).not.toContain("tar")
})

async function runFixture(badChecksum = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ranzcode-updater-"))
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--define",
        'LARPCODE_CLI_DISTRIBUTION="1"',
        "--define",
        'OPENCODE_VERSION="1.0.0"',
        "--define",
        'OPENCODE_CHANNEL="prod"',
        path.join(import.meta.dir, "fixture/ranzcode-updater.ts"),
      ],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: {
          ...process.env,
          RANZCODE_UPDATER_TEST_DIR: root,
          ...(badChecksum ? { RANZCODE_UPDATER_BAD_CHECKSUM: "1" } : {}),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode, stderr).toBe(0)
    const result = JSON.parse(stdout.trim()) as {
      latest: string
      executable: string
      config: string
      data: string
      commands: Array<{ command: string; args: string[] }>
      versionCheckEnv: Record<string, string>
      upgradeError?: string
    }
    return { ...result, root }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
