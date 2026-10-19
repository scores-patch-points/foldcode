import path from "node:path"
import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.OPENCODE_CHANNEL

export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

const appNames: Record<Channel, string> = {
  local: "foldcode",
  dev: "foldcode",
  beta: "foldcode",
  prod: "foldcode",
}

const appIDs: Record<Channel, string> = {
  local: "ai.opencode.desktop.dev",
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged ? appNames[CHANNEL] : "foldcode"

export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : "ai.opencode.desktop.dev"

// The app's default operating directory. The service (and the CLI under it) inherit this
// process's cwd and PWD, and the server's payload-less session.create defaults to its cwd —
// so the app's own defaults land in ~/Documents/foldcode instead of reaching into
// ~/Downloads and ~/Desktop (2026-10-17: those grants are the recurring TCC friction).
export const DEFAULT_PROJECT_DIR = path.join(app.getPath("documents"), "foldcode")
