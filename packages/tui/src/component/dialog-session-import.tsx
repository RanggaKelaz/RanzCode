import { createMemo, createResource, createSignal, onMount, Show } from "solid-js"
import { batches } from "@opencode/util/session-import"
import { Keymap } from "../context/keymap"
import { useClient } from "../context/client"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { DIALOG_LIST_INSET, type DialogContext, useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { Locale } from "../util/locale"
import { listOpenCodeSessions, readOpenCodeSession, type OpenCodeSessionSummary } from "../util/opencode-import"
import { Spinner } from "./spinner"

/**
 * Copies a session out of an installed OpenCode profile into the current LarpCode location.
 *
 * The source database is opened read-only. Selecting a row never changes what OpenCode sees, and repeated imports
 * create separate LarpCode sessions with fresh ids.
 */
export function DialogSessionImport(props: { directory: string }) {
  const dialog = useDialog()
  const client = useClient()
  const route = useRoute()
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const shortcuts = Keymap.useShortcuts()
  const [importing, setImporting] = createSignal<OpenCodeSessionSummary>()
  const [progress, setProgress] = createSignal({ done: 0, total: 0 })
  const [list] = createResource(() => listOpenCodeSessions())

  const sessions = createMemo(() => list()?.sessions ?? [])
  const empty = createMemo(() => {
    if (list.loading) return { message: "Looking for OpenCode sessions…", error: false }
    if (list.error) return { message: `Could not read OpenCode data: ${errorMessage(list.error)}`, error: true }
    const result = list()
    if (!result) return { message: "Could not read OpenCode data.", error: true }
    if (result.databases.length === 0)
      return { message: "No OpenCode installation found on this computer.", error: false }
    if (result.sessions.length === 0 && result.legacySessions > 0)
      return {
        message:
          "OpenCode has sessions in its older format. Open OpenCode 2 once so it can upgrade them, then try again.",
        error: false,
      }
    if (result.sessions.length === 0) return { message: "No OpenCode sessions available to import.", error: false }
    return undefined
  })
  const options = createMemo(() =>
    sessions().map((session) => ({
      value: session,
      title: session.title,
      searchText: `${session.directory} ${session.preview ?? ""}`,
      footer: `${session.messageCount} ${session.messageCount === 1 ? "msg" : "msgs"} · ${timeAgo(session.timeUpdated)}`,
      details: session.preview ? [session.preview, session.directory] : [session.directory],
    })),
  )

  function start(session: OpenCodeSessionSummary) {
    if (importing()) return
    setImporting(session)
    // Let the importing state paint before the transcript is read from disk.
    setTimeout(() => {
      const fail = (error: unknown) => {
        setImporting(undefined)
        setProgress({ done: 0, total: 0 })
        toast.show({
          title: "Import failed",
          message: errorMessage(error),
          variant: "error",
          duration: 5000,
        })
      }
      try {
        const data = readOpenCodeSession({
          database: session.database,
          sessionID: session.id,
          directory: props.directory,
        })
        const chunks = batches(data.messages)
        setProgress({ done: 0, total: data.messages.length })
        void client.api.experimental.session
          .import({
            info: data.info,
            messages: chunks[0] ?? [],
            location: { directory: props.directory },
          })
          .then(async (imported) => {
            try {
              let done = chunks[0]?.length ?? 0
              for (let index = 1; index < chunks.length; index++) {
                await client.api.experimental.session.importAppend({
                  sessionID: imported.id,
                  messages: chunks[index]!,
                })
                done += chunks[index]!.length
                setProgress({ done, total: data.messages.length })
              }
              dialog.clear()
              route.navigate({ type: "session", sessionID: imported.id })
              toast.show({
                message: `Imported “${session.title}” with ${data.messages.length} messages`,
                variant: "success",
                duration: 4000,
              })
            } catch (error) {
              // A partially appended session would show a truncated transcript forever.
              await client.api.session.remove({ sessionID: imported.id }).catch(() => undefined)
              fail(error)
            }
          })
          .catch(fail)
      } catch (error) {
        fail(error)
      }
    }, 0)
  }

  onMount(() => dialog.setSize("large"))

  return (
    <DialogSelect
      title="Import from OpenCode"
      description="Copies one OpenCode session into this directory. OpenCode's own data is never changed."
      options={options()}
      locked={importing() !== undefined}
      footer={
        <Show when={importing()}>
          <Spinner shimmer={theme.text.base}>
            {progress().total > 0
              ? `Importing “${Locale.truncate(importing()!.title, 32)}” ${progress().done}/${progress().total}…`
              : `Importing “${Locale.truncate(importing()!.title, 32)}”…`}
          </Spinner>
        </Show>
      }
      emptyView={
        <box flexDirection="column" paddingLeft={DIALOG_LIST_INSET} paddingRight={DIALOG_LIST_INSET} gap={1}>
          <Show
            when={list.loading}
            fallback={
              <text fg={empty()?.error ? theme.text.feedback.error.base : theme.text.muted}>{empty()?.message}</text>
            }
          >
            <Spinner>{empty()?.message ?? "Looking for OpenCode sessions…"}</Spinner>
          </Show>
          <Show when={list()?.errors.length}>
            <text fg={theme.text.feedback.error.base} wrapMode="word">
              {list()?.errors.join("\n")}
            </text>
          </Show>
          <Show when={list()?.legacySessions && sessions().length > 0}>
            <text fg={theme.text.muted} wrapMode="word">
              {list()!.legacySessions} older OpenCode session
              {list()!.legacySessions === 1 ? "" : "s"} need OpenCode 2 to upgrade before they can be imported.
            </text>
          </Show>
        </box>
      }
      onSelect={(option) => start(option.value)}
      footerHints={[
        {
          title: importing() ? "importing" : "import",
          label: shortcuts.get("dialog.select.submit") ?? "enter",
          side: "right",
        },
      ]}
    />
  )
}

DialogSessionImport.show = (dialog: DialogContext, directory: string) =>
  dialog.replace(() => <DialogSessionImport directory={directory} />)

function timeAgo(timestamp: number) {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(days / 365)}y ago`
}
