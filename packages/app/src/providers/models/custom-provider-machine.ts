export type CustomProviderValues = {
  providerID: string
  providerName: string
  baseURL: string
  modelID: string
  modelName: string
}

export type CustomProviderField = keyof CustomProviderValues

export type CustomProviderMode = "new" | "existing"

export type CustomProviderValidationError = "required" | "invalid-id" | "provider-exists" | "invalid-url"

export type CustomProviderErrors = Partial<Record<CustomProviderField, CustomProviderValidationError>>

export type CustomProviderState =
  | { status: "editing"; values: CustomProviderValues; errors: CustomProviderErrors }
  | { status: "saving"; values: CustomProviderValues }
  | { status: "failed"; values: CustomProviderValues; message: string }
  | { status: "saved"; providerID: string }
  | { status: "disposed" }

export type CustomProviderEvent =
  | { type: "field.changed"; field: CustomProviderField; value: string }
  | { type: "field.blurred"; field: CustomProviderField; existingProviderIDs: readonly string[]; mode?: CustomProviderMode }
  | { type: "submit.invalid"; errors: CustomProviderErrors }
  | { type: "submit.requested" }
  | { type: "submit.failed"; message: string }
  | { type: "submit.succeeded"; providerID: string }
  | { type: "disposed" }

export function createCustomProviderState(): CustomProviderState {
  return {
    status: "editing",
    values: { providerID: "", providerName: "", baseURL: "", modelID: "", modelName: "" },
    errors: {},
  }
}

export function validateCustomProvider(
  values: CustomProviderValues,
  existingProviderIDs: readonly string[],
  mode: CustomProviderMode = "new",
): CustomProviderErrors {
  const errors: CustomProviderErrors = {}
  const existing = new Set(existingProviderIDs.map((id) => id.toLowerCase()))

  for (const field of ["providerID", "providerName", "baseURL", "modelID"] as const) {
    const error = validateField(field, values, existing, mode)

    if (error) errors[field] = error
  }

  return errors
}

export function transitionCustomProvider(
  state: CustomProviderState,
  event: CustomProviderEvent,
): CustomProviderState {
  switch (event.type) {
    case "field.changed": {
      if (state.status !== "editing" && state.status !== "failed") return state
      const values = { ...state.values, [event.field]: event.value }

      if (state.status === "failed") return { status: "editing", values, errors: {} }
      const errors = { ...state.errors }
      delete errors[event.field]

      return { status: "editing", values, errors }
    }

    case "field.blurred": {
      if (state.status !== "editing") return state
      const existing = new Set(event.existingProviderIDs.map((id) => id.toLowerCase()))
      const error = validateField(event.field, state.values, existing, event.mode ?? "new")

      if (state.errors[event.field] === error) return state
      const errors = { ...state.errors }

      if (error) errors[event.field] = error
      else delete errors[event.field]

      return { status: "editing", values: state.values, errors }
    }

    case "submit.invalid":
      if (state.status !== "editing" && state.status !== "failed") return state

      return { status: "editing", values: state.values, errors: event.errors }
    case "submit.requested":
      if (state.status !== "editing" && state.status !== "failed") return state

      return { status: "saving", values: state.values }
    case "submit.failed":
      if (state.status !== "saving") return state

      return { status: "failed", values: state.values, message: event.message }
    case "submit.succeeded":
      if (state.status !== "saving") return state

      return { status: "saved", providerID: event.providerID }
    case "disposed":
      if (state.status === "saved" || state.status === "disposed") return state

      return { status: "disposed" }
  }
}

function validateField(
  field: CustomProviderField,
  values: CustomProviderValues,
  existingProviderIDs: ReadonlySet<string>,
  mode: CustomProviderMode,
): CustomProviderValidationError | undefined {
  const value = values[field].trim()

  if (mode === "existing" && (field === "providerName" || field === "baseURL")) return

  if (field === "providerID") {
    if (!value) return "required"

    if (mode === "existing") return

    if (!/^[a-z0-9][a-z0-9-]*$/u.test(value)) return "invalid-id"

    if (existingProviderIDs.has(value.toLowerCase())) return "provider-exists"

    return
  }

  if (field === "baseURL") {
    if (!value) return "required"

    try {
      const url = new URL(value)

      if (url.protocol !== "https:" && url.protocol !== "http:") return "invalid-url"
    } catch {
      return "invalid-url"
    }

    return
  }

  if (field === "providerName" || field === "modelID") return value ? undefined : "required"
}
