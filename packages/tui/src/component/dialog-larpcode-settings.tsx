import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useNewDesigns } from "../config"
import { useLarpcode, type LarpcodeDependency, type LarpcodeSettingSource } from "../context/larpcode"
import { useTheme } from "../context/theme"
import { DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogSelect, DialogSelectChoice } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { DialogConfig } from "./dialog-config"
import { useUsageLimits } from "./usage"

type Entry = {
  title: string
  category: string
  value: string
  description: string
  keywords?: string
  footer: string
  /** Under the new designs, render the footer as a changeable value. */
  choice?: boolean
  /** The active value opens a picker or action instead of cycling. */
  open?: boolean
  warning?: boolean
}

const onOff = (value: boolean) => (value ? "on" : "off")

const sourceNote = (source: LarpcodeSettingSource | undefined) =>
  source === "env" ? " The environment overrides the saved value." : ""

export function DialogLarpcodeSettings() {
  const larpcode = useLarpcode()
  const dialog = useDialog()
  const toast = useToast()
  const theme = useTheme().surface("dialog")
  const newDesigns = useNewDesigns()
  const limits = useUsageLimits()
  const [selected, setSelected] = createSignal<string>()

  onMount(() => {
    if (larpcode.status() !== "loading") void larpcode.refresh()
  })

  const entries = createMemo<Entry[]>(() => {
    const data = larpcode.data()
    if (!data) return []
    const result: Entry[] = []
    const missing = data.dependencies.filter((dependency) => !dependency.installed)

    if (missing.length > 0) {
      result.push({
        title: "Dependencies missing",
        category: "Warnings",
        value: "warning",
        description: missing.map((dependency) => dependency.name).join(", "),
        keywords: "missing dependencies cloudflare warp tor curl impersonate",
        footer: `${missing.length} missing`,
        warning: true,
      })
    }

    result.push(
      {
        title: "Auto JB",
        category: "Auto JB",
        value: "autoJb",
        description: "Inject the abliterated instruction set into every session",
        keywords: "auto jailbreak abliterated instructions system prompt",
        footer: onOff(data.autoJb.enabled),
        choice: true,
      },
      {
        title: "Instructions",
        category: "Auto JB",
        value: "instructions",
        description: data.autoJb.custom
          ? `Custom instruction set (${data.autoJb.length.toLocaleString("en-US")} characters). Enter resets to bundled.`
          : `Bundled instruction set (${data.autoJb.length.toLocaleString("en-US")} characters)`,
        keywords: "auto jb instructions content reset bundled custom",
        footer: data.autoJb.custom ? (data.autoJb.length === 0 ? "empty" : "custom") : "default",
        choice: true,
        open: true,
      },
      {
        title: "Auto-rotate",
        category: "Network",
        value: "autoRotate",
        description: `Rotate the wire identity when a free-limit refusal lands.${sourceNote(data.sources.autoRotate)}`,
        keywords: "auto rotate rotation fingerprint warp quota limit",
        footer: onOff(data.settings.autoRotate),
        choice: true,
      },
      {
        title: "Rotations per hour",
        category: "Network",
        value: "autoRotateMaxPerHour",
        description: "Most automatic rotations allowed in a rolling hour",
        keywords: "rotation cap limit hour maximum",
        footer: `${data.settings.autoRotateMaxPerHour} / hour`,
        choice: true,
      },
      {
        title: "Free fallback",
        category: "Network",
        value: "freeFallback",
        description: `Reroute a refused free request to the configured fallback model.${sourceNote(data.sources.freeFallback)}`,
        keywords: "free fallback deepseek pollinations refusal 429",
        footer: onOff(data.settings.freeFallback),
        choice: true,
      },
      {
        title: "Route through Tor",
        category: "Network",
        value: "forceTor",
        description: `Send opencode.ai traffic through the bundled Tor proxy.${sourceNote(data.sources.forceTor)}`,
        keywords: "tor proxy socks egress onion",
        footer: onOff(data.settings.forceTor),
        choice: true,
      },
      {
        title: "Reset usage limits",
        category: "Usage",
        value: "resetUsage",
        description: "Clear local usage totals and free-limit cooldowns. Sessions are kept.",
        keywords: "reset usage limits counters spend cooldown",
        footer: "reset",
        open: true,
      },
    )

    for (const dependency of data.dependencies) {
      result.push({
        title: `${dependency.installed ? "" : "! "}${dependency.name}`,
        category: "Dependencies",
        value: `dependency:${dependency.id}`,
        description: dependency.installed ? (dependency.path ?? dependency.hint) : dependency.hint,
        keywords: `${dependency.name} dependency missing install proxy ${dependency.id}`,
        footer: dependency.installed ? "installed" : "missing",
        warning: !dependency.installed,
      })
    }

    result.push(
      {
        title: "Recheck dependencies",
        category: "Dependencies",
        value: "recheck",
        description: "Probe WARP, Tor, curl-impersonate and the proxy again",
        keywords: "recheck refresh dependencies doctor",
        footer: data.proxy.configured ? `proxy ${data.proxy.value}` : "no proxy",
        open: true,
      },
      {
        title: "Full settings",
        category: "Advanced",
        value: "full",
        description: `Everything else, including themes and OpenCode config. RanzCode settings live in ${data.settingsPath}`,
        keywords: "full settings opencode config theme",
        footer: "open",
        open: true,
      },
    )

    return result
  })

  const options = createMemo(() =>
    entries().map((entry) => ({
      title: entry.title,
      category: entry.category,
      searchText: entry.keywords,
      footer:
        newDesigns() && entry.choice ? (
          <DialogSelectChoice value={entry.footer} active={selected() === entry.value} open={entry.open} />
        ) : (
          entry.footer
        ),
      footerOverhang: newDesigns() && entry.choice ? 2 : undefined,
      footerColor: entry.warning ? theme.text.feedback.warning.base : undefined,
      detail: newDesigns() ? entry.description : undefined,
      value: entry.value,
    })),
  )

  const data = () => larpcode.data()

  async function change(direction: number, value = selected()) {
    const current = data()
    if (!current || !value || larpcode.saving()) return
    try {
      if (value === "autoRotate") return void (await larpcode.update({ autoRotate: !current.settings.autoRotate }))
      if (value === "freeFallback")
        return void (await larpcode.update({ freeFallback: !current.settings.freeFallback }))
      if (value === "forceTor") return void (await larpcode.update({ forceTor: !current.settings.forceTor }))
      if (value === "autoRotateMaxPerHour") {
        const next = Math.min(120, Math.max(1, current.settings.autoRotateMaxPerHour + direction * 5))
        if (next !== current.settings.autoRotateMaxPerHour) await larpcode.update({ autoRotateMaxPerHour: next })
      }
    } catch (error) {
      toast.error(error)
    }
  }

  async function toggleAutoJb() {
    const current = data()
    if (!current || larpcode.saving()) return
    const next = !current.autoJb.enabled
    try {
      await larpcode.setAutoJb(next)
      toast.show({ message: `Auto JB ${next ? "enabled" : "disabled"}`, variant: next ? "success" : "info" })
    } catch (error) {
      toast.error(error)
    }
  }

  function describe(dependency: LarpcodeDependency) {
    toast.show({
      title: dependency.name,
      message: dependency.installed ? (dependency.path ?? dependency.hint) : dependency.hint,
      variant: dependency.installed ? "info" : "warning",
    })
  }

  function confirmResetInstructions() {
    const current = data()
    if (!current) return
    if (!current.autoJb.custom) {
      toast.show({ message: "Using the bundled Auto JB instructions", variant: "info" })
      return
    }
    dialog.replace(() => (
      <DialogConfirm
        title="Reset Auto JB instructions"
        message="Replace the custom instruction set with the bundled default?"
        label={{ confirm: "Reset", cancel: "Cancel" }}
        onConfirm={() => {
          void larpcode.resetInstructions().then(
            () => {
              toast.show({ message: "Auto JB instructions reset", variant: "success" })
              dialog.replace(() => <DialogLarpcodeSettings />)
            },
            (error) => toast.error(error),
          )
        }}
      />
    ))
  }

  function confirmResetUsage() {
    dialog.replace(() => (
      <DialogConfirm
        title="Reset usage limits"
        message="Clear local usage totals and free-limit cooldowns? Sessions are kept."
        label={{ confirm: "Reset", cancel: "Cancel" }}
        onConfirm={() => {
          void larpcode.resetLimits().then(
            () => {
              limits.load(true)
              toast.show({ message: "Usage limits reset", variant: "success" })
              dialog.replace(() => <DialogLarpcodeSettings />)
            },
            (error) => toast.error(error),
          )
        }}
      />
    ))
  }

  async function activate(value: string) {
    const current = data()
    if (!current) return
    if (value === "warning") {
      const missing = current.dependencies.filter((dependency) => !dependency.installed)
      toast.show({
        title: "Missing dependencies",
        message: `${missing.map((dependency) => dependency.name).join(", ")}. Open Dependencies for install hints.`,
        variant: "warning",
      })
      return
    }
    if (value === "autoJb") return void toggleAutoJb()
    if (value === "instructions") return confirmResetInstructions()
    if (value === "resetUsage") return confirmResetUsage()
    if (value === "recheck") {
      await larpcode.refresh()
      if (larpcode.error()) return toast.error(larpcode.error())
      toast.show({
        message: larpcode.missing() > 0 ? `${larpcode.missing()} dependencies still missing` : "All dependencies found",
        variant: larpcode.missing() > 0 ? "warning" : "success",
      })
      return
    }
    if (value === "full") return void dialog.replace(() => <DialogConfig />)
    if (value.startsWith("dependency:")) {
      const dependency = current.dependencies.find((item) => `dependency:${item.id}` === value)
      if (dependency) describe(dependency)
      return
    }
    return void change(1, value)
  }

  return (
    <Show
      when={data()}
      fallback={
        <DialogLayout header={<DialogHeader title="RanzCode settings" />}>
          <text fg={larpcode.error() ? theme.text.feedback.error.base : theme.text.muted} wrapMode="word">
            {larpcode.error() ? `Could not load RanzCode settings: ${larpcode.error()}` : "Loading RanzCode settings…"}
          </text>
          <Show when={larpcode.error()}>
            <text fg={theme.text.muted} wrapMode="word">
              Open /larpcode:settings again to retry.
            </text>
          </Show>
        </DialogLayout>
      }
    >
      <DialogSelect
        title="RanzCode settings"
        searchInTitle
        titlePlaceholder="Search RanzCode settings"
        options={options()}
        preserveSelection={newDesigns()}
        filterThreshold={0.7}
        onMove={(option) => setSelected(option.value)}
        onSelect={(option) => void activate(option.value)}
        footerHints={newDesigns() ? [] : [{ title: "change", label: "←/→" }]}
        bindings={[
          {
            bind: "left",
            title: "Previous value",
            group: "RanzCode",
            run: () => void change(-1),
          },
          {
            bind: "right",
            title: "Next value",
            group: "RanzCode",
            run: () => void change(1),
          },
        ]}
      />
    </Show>
  )
}
