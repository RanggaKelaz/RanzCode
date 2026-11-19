import { describe, expect, test } from "bun:test"
import {
  createCustomProviderState,
  transitionCustomProvider,
  validateCustomProvider,
  type CustomProviderValues,
} from "./custom-provider-machine"

const validValues: CustomProviderValues = {
  providerID: "custom-router",
  providerName: "Custom Router",
  baseURL: "https://api.example.com/v1",
  modelID: "example-model",
  modelName: "Example Model",
}

describe("custom provider form", () => {
  test("reports required fields, malformed IDs, unsupported URLs, and existing providers", () => {
    expect(validateCustomProvider({ ...validValues, providerID: "", providerName: "", baseURL: "", modelID: "" }, [])).toEqual({
      providerID: "required",
      providerName: "required",
      baseURL: "required",
      modelID: "required",
    })
    expect(validateCustomProvider({ ...validValues, providerID: "Bad ID" }, [])).toMatchObject({
      providerID: "invalid-id",
    })
    expect(validateCustomProvider({ ...validValues, baseURL: "file:///tmp/model" }, [])).toMatchObject({
      baseURL: "invalid-url",
    })
    expect(validateCustomProvider(validValues, ["CUSTOM-ROUTER"])).toMatchObject({
      providerID: "provider-exists",
    })
    expect(validateCustomProvider(validValues, [])).toEqual({})
  })

  test("validates an existing provider without requesting a new name or URL", () => {
    expect(
      validateCustomProvider(
        { ...validValues, providerID: "9router", providerName: "", baseURL: "" },
        ["9router"],
        "existing",
      ),
    ).toEqual({})
    expect(validateCustomProvider({ ...validValues, providerID: "" }, [], "existing")).toMatchObject({
      providerID: "required",
    })
  })

  test("keeps values after a failed save, then accepts success and ignores late results after disposal", () => {
    let state = createCustomProviderState()
    state = transitionCustomProvider(state, { type: "field.changed", field: "providerID", value: validValues.providerID })
    state = transitionCustomProvider(state, { type: "field.changed", field: "providerName", value: validValues.providerName })
    state = transitionCustomProvider(state, { type: "field.changed", field: "baseURL", value: validValues.baseURL })
    state = transitionCustomProvider(state, { type: "field.changed", field: "modelID", value: validValues.modelID })
    state = transitionCustomProvider(state, { type: "field.changed", field: "modelName", value: validValues.modelName })
    state = transitionCustomProvider(state, { type: "submit.requested" })
    state = transitionCustomProvider(state, { type: "submit.failed", message: "Request failed" })

    expect(state).toEqual({ status: "failed", values: validValues, message: "Request failed" })

    const retry = transitionCustomProvider(state, { type: "submit.requested" })
    expect(retry).toEqual({ status: "saving", values: validValues })

    state = transitionCustomProvider(state, { type: "field.changed", field: "modelName", value: "Updated Name" })
    expect(state).toMatchObject({ status: "editing", values: { ...validValues, modelName: "Updated Name" } })

    state = transitionCustomProvider(state, { type: "submit.requested" })
    state = transitionCustomProvider(state, { type: "submit.succeeded", providerID: validValues.providerID })
    expect(state).toEqual({ status: "saved", providerID: validValues.providerID })

    const disposed = transitionCustomProvider(createCustomProviderState(), { type: "disposed" })
    expect(transitionCustomProvider(disposed, { type: "submit.failed", message: "Late response" })).toBe(disposed)
    expect(transitionCustomProvider(state, { type: "disposed" })).toBe(state)
  })
})
