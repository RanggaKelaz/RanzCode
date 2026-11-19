#!/usr/bin/env node
// LarpCode: thin shim over the opencode CLI loader. Keeps the binary name
// "larpcode" on PATH, forwards to the normal cached launcher.
require("./opencode.cjs")
