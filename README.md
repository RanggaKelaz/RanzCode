# LarpCode

LarpCode is an open-source AI coding app for Windows. It is a community fork of
[OpenCode](https://github.com/anomalyco/opencode) with a redesigned interface
and extra tools for working with AI models.

It runs on your own machine. Your files and prompts stay local, except for the
requests you choose to send to an AI provider.

## Download

LarpCode comes in two shapes. Choose one:

- **Desktop app (recommended)** — the full graphical app plus the `larpcode`
  terminal command.
- **CLI only** — the terminal UI and `larpcode` command, without the desktop app.

Both use the same LarpCode sessions, settings, and providers.

### Desktop app

1. Open the [Releases page](https://github.com/Tazmyan/LarpCode/releases).
2. Download the latest `LarpCode-Setup.exe`.
3. Run the installer and launch **LarpCode** from the Start Menu or desktop.

The installer also adds the bundled `larpcode` command to your user `PATH`, so
you can open a terminal and start the TUI in any folder.

The current build is for **Windows 10 and 11 (64-bit)**.

The installer is not code-signed, so Windows SmartScreen may show a warning.
Only continue if you downloaded the file from the official Releases page above
(`More info` → `Run anyway`). Release files also include a `SHA256SUMS` file if
you want to verify your download.

### CLI only

Open PowerShell and run:

```powershell
irm https://github.com/Tazmyan/LarpCode/releases/latest/download/install-cli.ps1 | iex
```

Or paste this into Command Prompt:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/Tazmyan/LarpCode/releases/latest/download/install-cli.ps1 | iex"
```

The script:

1. Downloads the latest `larpcode.exe` from the official Releases page.
2. Verifies its SHA-256 checksum against `cli.json`.
3. Installs it to `%LOCALAPPDATA%\Programs\LarpCode CLI\bin`.
4. Adds that folder to your user `PATH`.

Open a new terminal afterward, then run `larpcode --help` or just `larpcode` to
start the TUI in the current folder. You can also download `larpcode.exe`
manually from the Releases page and put it in any folder that is already on
your `PATH`.

The CLI-only install does not create Start Menu shortcuts, install the desktop
app, or share OpenCode's data.

<details>
<summary>Install a specific CLI version</summary>

```powershell
$install = irm https://github.com/Tazmyan/LarpCode/releases/latest/download/install-cli.ps1
& ([scriptblock]::Create($install)) -Version 1.0.0
```

</details>

## Updates

- **Desktop app** — checks the public LarpCode release feed and offers updates
  inside the app. Your sessions and settings are kept.
- **CLI only** — `larpcode upgrade` checks the same release feed, downloads the
  matching `larpcode.exe`, verifies its checksum, and replaces the CLI. Open a
  new terminal afterward.
- **CLI installed by the desktop app** — update through the desktop app. The
  bundled CLI does not replace itself.

The first update check happens automatically. Open `/update` in the TUI or run
`larpcode upgrade` to check manually.

## First launch

LarpCode does not include an AI model or an API key. To start coding, open
**Settings** and connect the provider you want to use (for example OpenAI,
Anthropic, Google, or a local model). You can change or remove providers at any
time.

## Command line

Both installs add `larpcode` to your per-user `PATH`, so the command works in
Command Prompt, PowerShell, and Windows Terminal. Open a new terminal after
installing, then pass a folder to start there or use any CLI flag:

```bat
larpcode C:\path\to\project
larpcode --help
```

`larpcode` with no arguments opens the TUI in the current directory. In the TUI,
open the `larpcode` control at the top right or run `/larpcode:settings` to
toggle Auto JB, auto-rotate, free fallback, and Tor routing, reset usage, and
see missing helpers.

Useful commands:

```bat
larpcode usage       limits, reset times, and local activity graphs
larpcode usage       limits, reset times, and local activity graphs
larpcode reset       clear local usage counters (--deep also clears sessions)
larpcode settings    LarpCode switches, Auto JB, dependencies, and paths
larpcode doctor      server, database, WARP, Tor, and curl-impersonate
```

`larpcode doctor` and `larpcode settings` report optional helpers that are not
installed, including Cloudflare WARP, Tor, and curl-impersonate. They are
warnings, not fatal errors.

- Desktop install: the launcher is
  `%LOCALAPPDATA%\Programs\LarpCode\shortcuts\larpcode.cmd`, and the **LarpCode
  CLI** Start Menu shortcut runs the same thing.
- CLI-only install: the executable is
  `%LOCALAPPDATA%\Programs\LarpCode CLI\bin\larpcode.exe`.

The desktop app, the Start Menu shortcut, and the CLI-only install share
LarpCode's own config, sessions, and cache. They do not read or overwrite the
data of an OpenCode installation on the same machine.

## Features

- **Unlimited free AI coding** — no paid edition, activation key, or app-side
  message cap. Connect your own provider or a local model.
- **Auto JB** — one Settings toggle applies a configurable instruction set to
  every model request instead of the workspace `AGENTS.md`.
- **Full OpenCode experience** — sessions, tools, plugins, projects, and the
  local agent runtime, with a LarpCode interface.
- **Windows desktop app** — a normal installer, Start Menu shortcuts, and an
  in-app updater.
- **Fresh reset** — backs up local sessions, clears local usage data, rotates
  the local client identity, and can rotate your network egress if you have
  configured it.
- **Network options** — optional Tor and SOCKS5 routing for supported requests.
- **Usage dashboard** — see local token and cost estimates and reset the local
  counters when you want a clean slate.

## Build from source

You need [Bun](https://bun.sh) and, for the installer, Inno Setup 6.

```bash
bun install
bun run --cwd packages/cli build
bun run --cwd packages/desktop build
bun run script/fetch-installer-deps.ts
bun run script/fetch-electron.ts
bun run script/stage-installer.ts
```

The desktop build bundles the CLI. `script/stage-installer.ts` stages the app
and builds `installer/dist/LarpCode-Setup.exe`. The fetch steps download the
third-party Tor, curl-impersonate, and Electron binaries used by the installer;
Electron is pinned to `packages/desktop/package.json` and verified against the
official `SHASUMS256.txt`.

The version comes from the `VERSION` file. A release tag must be `v` plus that
version (for example `VERSION` = `1.0.0` and tag `v1.0.0`).

## Community

Questions, bug reports and feature requests are welcome.

- Discord: <https://discord.gg/CXXxz68BR5>

## Legal notice and disclaimer

LarpCode is an independent community project. It is **not affiliated with,
endorsed by, or sponsored by** OpenCode, Anomaly, GitHub, or any AI
model provider. All product names, logos, and trademarks belong to their
respective owners.

LarpCode is provided **"as is"**, without warranty of any kind, express or
implied, including merchantability, fitness for a particular purpose, and
non-infringement. You use LarpCode at your own risk. To the maximum extent
permitted by applicable law, the maintainers and contributors are not liable
for any direct, indirect, incidental, special, consequential, or punitive
damages, including data loss, lost profits, account suspension, service
termination, or any other harm arising from the use of or inability to use
LarpCode.

By downloading or using LarpCode, you agree to this notice. If you do not
agree, do not use LarpCode.

You are responsible for how you use LarpCode. That includes following the terms
of service of any AI provider or other service you connect, respecting
copyright and other rights, and complying with the laws that apply to you.
LarpCode does not include or grant access to any AI account, API key, model, or
service.

Nothing in this notice excludes or limits liability that cannot be excluded or
limited under applicable law. If you are a consumer in the EU/EEA, your
mandatory statutory rights are not affected.

The source code in this repository is available under the MIT License; see
[LICENSE](./LICENSE).

### Takedown and removal policy

We respect the rights of other projects and rights holders. If the OpenCode
maintainers, a rights holder, or GitHub ask us to remove material, or to remove
or disable a feature, we will do so promptly. If you believe something in this
repository infringes your rights, please contact us through the repository's
issue tracker or Discord so we can resolve it.

## Credits

LarpCode is based on **olliEcode**, which is itself built on OpenCode. Credit
for the original custom features and ideas goes to the olliEcode authors.

- OpenCode: <https://github.com/anomalyco/opencode>
- olliEcode: credit to the olliEcode project and its contributors
