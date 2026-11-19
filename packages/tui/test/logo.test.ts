import { expect, test } from "bun:test"
import { logo } from "../src/logo"

// Block art uses "_" for a shadowed cell, "^" and "~" for half blocks. Decode
// those the way both the splash and the in-app logo render them so the
// assertion reads the same word a person sees.
const decode = (rows: readonly string[]) =>
  rows.map((row) =>
    [...row]
      .map((char) => {
        if (char === "_") return " "
        if (char === "^" || char === "~") return "▀"
        return char
      })
      .join(""),
  )

test("the startup wordmark reads larpcode and keeps the d ascender", () => {
  const left = decode(logo.left)
  const right = decode(logo.right)

  expect(left).toEqual(["                   ", "█    ▄▀▀▄ █▀▀▄ █▀▀█", "█    █▀▀█ █    █  █", "▀▀▀▀ ▀▀▀▀ ▀    █▀▀▀"])
  expect(right).toEqual(["             ▄     ", "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█    █  █ █  █ █▀▀▀", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"])
  // The right half is "code"; the lone upper-half block marks the d ascender.
  expect(right[0]?.trim()).toBe("▄")
  expect(right.slice(1)).toEqual(["█▀▀▀ █▀▀█ █▀▀█ █▀▀█", "█    █  █ █  █ █▀▀▀", "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀"])
})
