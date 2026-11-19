import { resolveChannel } from "./utils"

const arg = process.argv[2]

const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId =
  channel === "prod"
    ? "ai.larpcode.desktop"
    : channel === "beta"
      ? "ai.larpcode.desktop.beta"
      : "ai.larpcode.desktop.dev"

const productName =
  channel === "prod" || channel === "local"
    ? "LarpCode"
    : `LarpCode ${channel.charAt(0).toUpperCase() + channel.slice(1)}`

const summary = `Open source AI coding app${channel === "dev" || channel === "beta" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="io.github.tazmyan">
    <name>Tazmyan</name>
  </developer>

  <description>
    <p>
      LarpCode is an open source AI coding app built on OpenCode. It helps you
      write and run code with the AI model and provider you choose.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/Tazmyan/LarpCode/issues</url>
  <url type="homepage">https://github.com/Tazmyan/LarpCode</url>
  <url type="vcs-browser">https://github.com/Tazmyan/LarpCode</url>

  <screenshots>
    <screenshot type="default">
      <image>https://raw.githubusercontent.com/Tazmyan/LarpCode/main/packages/web/src/assets/lander/screenshot.png</image>
    </screenshot>
  </screenshots>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)

console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
