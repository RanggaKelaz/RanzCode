import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { TextField } from "@opencode/ui/text-field"
import { createSignal, onCleanup, Show, type Component } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { formatServerError } from "@/runtime/server/errors"
import { showToast } from "@/shell/notifications/toast"
import {
  createCustomProviderState,
  transitionCustomProvider,
  validateCustomProvider,
  type CustomProviderField,
  type CustomProviderMode,
  type CustomProviderState,
  type CustomProviderValues,
  type CustomProviderValidationError,
} from "./custom-provider-machine"

const EMPTY_VALUES: CustomProviderValues = {
  providerID: "",
  providerName: "",
  baseURL: "",
  modelID: "",
  modelName: "",
}

const FIELD_ORDER: CustomProviderField[] = ["providerID", "providerName", "baseURL", "modelID", "modelName"]

export const DialogCustomModel: Component<{
  existingProviderIDs: () => readonly string[]
  onAdded?: (providerID: string, openConnect: boolean) => void | Promise<void>
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const [state, setState] = createSignal<CustomProviderState>(createCustomProviderState())
  const [mode, setMode] = createSignal<CustomProviderMode>("new")
  let providerIDInput: HTMLInputElement | undefined
  let providerNameInput: HTMLInputElement | undefined
  let baseURLInput: HTMLInputElement | undefined
  let modelIDInput: HTMLInputElement | undefined
  let modelNameInput: HTMLInputElement | undefined

  const dispatch = (event: Parameters<typeof transitionCustomProvider>[1]) => {
    const current = state()
    const next = transitionCustomProvider(current, event)

    if (next !== current) setState(next)

    return next
  }

  const values = () => {
    const current = state()

    return "values" in current ? current.values : EMPTY_VALUES
  }

  const errors = () => {
    const current = state()

    return current.status === "editing" ? current.errors : {}
  }

  const saving = () => state().status === "saving"

  const requestError = () => {
    const current = state()

    return current.status === "failed" ? current.message : undefined
  }

  const errorMessage = (error?: CustomProviderValidationError) => {
    if (error === "required") return language.t("settings.providers.custom.error.required")

    if (error === "invalid-id") return language.t("settings.providers.custom.error.invalidID")

    if (error === "provider-exists") return language.t("settings.providers.custom.error.providerExists")

    if (error === "invalid-url") return language.t("settings.providers.custom.error.invalidURL")
  }

  const fieldError = (field: CustomProviderField) => errorMessage(errors()[field])

  const focusInvalidField = (field: CustomProviderField) => {
    const input: Partial<Record<CustomProviderField, HTMLInputElement | undefined>> = {
      providerID: providerIDInput,
      providerName: providerNameInput,
      baseURL: baseURLInput,
      modelID: modelIDInput,
      modelName: modelNameInput,
    }

    input[field]?.focus()
  }

  onCleanup(() => dispatch({ type: "disposed" }))

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const current = state()

    if (current.status !== "editing" && current.status !== "failed") return

    const validation = validateCustomProvider(current.values, props.existingProviderIDs(), mode())

    if (Object.keys(validation).length > 0) {
      dispatch({ type: "submit.invalid", errors: validation })
      const firstInvalidField = FIELD_ORDER.find((field) => validation[field])

      if (firstInvalidField) focusInvalidField(firstInvalidField)

      return
    }

    const normalized = {
      providerID: current.values.providerID.trim(),
      providerName: current.values.providerName.trim(),
      baseURL: current.values.baseURL.trim(),
      modelID: current.values.modelID.trim(),
      modelName: current.values.modelName.trim(),
    }

    const next = dispatch({ type: "submit.requested" })

    if (next.status !== "saving") return

    const newProvider = mode() === "new"
    const model = { [normalized.modelID]: { name: normalized.modelName || normalized.modelID } }

    const patch = newProvider
      ? {
        providers: {
          [normalized.providerID]: {
            name: normalized.providerName,
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: normalized.baseURL },
            models: model,
          },
        },
      }
      : { providerModels: { [normalized.providerID]: model } }

    void serverSdk.api.experimental.config
      .update(patch, { signal: AbortSignal.timeout(30_000) })
      .then(async () => {
        const activeDialog = state().status === "saving"
        dispatch({ type: "submit.succeeded", providerID: normalized.providerID })

        if (activeDialog) {
          showToast({
            variant: "success",
            icon: "circle-check",
            title: language.t("settings.providers.custom.saved.title"),
            description: newProvider
              ? language.t("settings.providers.custom.saved.description", { provider: normalized.providerName })
              : language.t("settings.providers.custom.saved.existing", { provider: normalized.providerID }),
          })
          dialog.close()
        }

        await Promise.try(() => props.onAdded?.(normalized.providerID, activeDialog && newProvider)).catch((error) =>
          showToast({
            title: language.t("common.requestFailed"),
            description: formatServerError(error, language.t),
          }),
        )
      })
      .catch(async (error) => {
        const openDialog = state().status === "saving"
        dispatch({ type: "submit.failed", message: formatServerError(error, language.t) })

        if (!openDialog) {
          await Promise.try(() => props.onAdded?.(normalized.providerID, false)).catch(() => undefined)

          return
        }
      })
  }

  return (
    <Dialog
      size="large"
      variant="settings"
      preventBackdropDismiss={saving()}
      class="settings-custom-model-dialog"
      containerClass="settings-custom-model-container"
    >
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitleGroup
          title={language.t("settings.providers.custom.title")}
          description={language.t("settings.providers.custom.description")}
        />
      </DialogHeader>
      <DialogBody>
        <form id="custom-model-form" class="flex flex-col gap-4" onSubmit={submit}>
          <fieldset class="settings-custom-model-mode" disabled={saving()}>
            <legend>{language.t("settings.providers.custom.mode.label")}</legend>
            <label>
              <input type="radio" name="custom-provider-mode" checked={mode() === "new"} onChange={() => {
                setMode("new")
                dispatch({ type: "field.changed", field: "providerID", value: values().providerID })
              }} />
              {language.t("settings.providers.custom.mode.new")}
            </label>
            <label>
              <input type="radio" name="custom-provider-mode" checked={mode() === "existing"} onChange={() => {
                setMode("existing")
                dispatch({ type: "field.changed", field: "providerID", value: values().providerID })
              }} />
              {language.t("settings.providers.custom.mode.existing")}
            </label>
          </fieldset>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              ref={(input: HTMLInputElement) => (providerIDInput = input)}
              label={language.t("settings.providers.custom.field.id")}
              description={mode() === "new" ? language.t("settings.providers.custom.id.help") : language.t("settings.providers.custom.id.existingHelp")}
              required
              value={values().providerID}
              onInput={(event) => dispatch({ type: "field.changed", field: "providerID", value: event.currentTarget.value })}
              onBlur={() =>
                dispatch({ type: "field.blurred", field: "providerID", existingProviderIDs: props.existingProviderIDs(), mode: mode() })
              }
              error={fieldError("providerID")}
              validationState={fieldError("providerID") ? "invalid" : "valid"}
              disabled={saving()}
              autocomplete="off"
              spellcheck={false}
            />
            <Show when={mode() === "new"}>
            <TextField
              ref={(input: HTMLInputElement) => (providerNameInput = input)}
              label={language.t("settings.providers.custom.field.name")}
              required
              value={values().providerName}
              onInput={(event) =>
                dispatch({ type: "field.changed", field: "providerName", value: event.currentTarget.value })
              }
              onBlur={() => dispatch({ type: "field.blurred", field: "providerName", existingProviderIDs: [] })}
              error={fieldError("providerName")}
              validationState={fieldError("providerName") ? "invalid" : "valid"}
              disabled={saving()}
              autocomplete="off"
            />
            </Show>
          </div>
          <Show when={mode() === "new"}>
          <TextField
            ref={(input: HTMLInputElement) => (baseURLInput = input)}
            label={language.t("settings.providers.custom.field.baseURL")}
            description={language.t("settings.providers.custom.baseURL.help")}
            required
            value={values().baseURL}
            onInput={(event) => dispatch({ type: "field.changed", field: "baseURL", value: event.currentTarget.value })}
            onBlur={() => dispatch({ type: "field.blurred", field: "baseURL", existingProviderIDs: [] })}
            error={fieldError("baseURL")}
            validationState={fieldError("baseURL") ? "invalid" : "valid"}
            disabled={saving()}
            autocomplete="url"
            spellcheck={false}
          />
          </Show>
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField
              ref={(input: HTMLInputElement) => (modelIDInput = input)}
              label={language.t("settings.providers.custom.field.modelID")}
              description={language.t("settings.providers.custom.modelID.help")}
              required
              value={values().modelID}
              onInput={(event) => dispatch({ type: "field.changed", field: "modelID", value: event.currentTarget.value })}
              onBlur={() => dispatch({ type: "field.blurred", field: "modelID", existingProviderIDs: [] })}
              error={fieldError("modelID")}
              validationState={fieldError("modelID") ? "invalid" : "valid"}
              disabled={saving()}
              autocomplete="off"
              spellcheck={false}
            />
            <TextField
              ref={(input: HTMLInputElement) => (modelNameInput = input)}
              label={language.t("settings.providers.custom.field.modelName")}
              description={language.t("settings.providers.custom.modelName.help")}
              value={values().modelName}
              onInput={(event) =>
                dispatch({ type: "field.changed", field: "modelName", value: event.currentTarget.value })
              }
              disabled={saving()}
              autocomplete="off"
            />
          </div>
          <Show when={requestError()}>
            {(message) => (
              <p class="text-12-regular text-v2-state-fg-danger" role="alert">
                {message()}
              </p>
            )}
          </Show>
        </form>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="ghost-muted" disabled={saving()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button type="submit" form="custom-model-form" variant="neutral" disabled={saving()}>
          {saving() ? language.t("settings.providers.custom.saving") : language.t("settings.providers.custom.submit")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
