import path from "node:path"
import { roots } from "./global-roots.js"

export function larpcodeDataPath(...parts: string[]) {
  return path.join(roots("opencode").data, ...parts)
}
