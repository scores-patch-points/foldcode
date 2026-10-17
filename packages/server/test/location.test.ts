import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

// macOS Files-and-Folders answers EPERM for a protected directory (~/Downloads after a rebuild
// invalidates the app's grant); a mode bit answers EACCES. Both must arrive as the typed
// ServiceUnavailableError — the cause (the path) disclosed — never a bare 500 that swallows it.
it.live("an unreadable workspace answers a typed 503 with its cause, never a bare 500", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const locked = path.join(tmp.path, "locked")
    const workspace = path.join(locked, "workspace")
    yield* Effect.promise(async () => {
      await fs.mkdir(workspace, { recursive: true })
      await fs.chmod(locked, 0o000) // no search bit on the parent: realPath(workspace) fails EACCES
    })
    try {
      const server = yield* startServer(path.join(tmp.path, "config"))
      const response = yield* Effect.promise(async () => {
        const url = new URL("/api/location", server.base)
        url.searchParams.set("location[directory]", workspace)
        return fetch(url, { headers: server.headers })
      })
      expect(response.status).toBe(503)
      const body = yield* Effect.promise(() => response.json() as Promise<{ _tag?: string; service?: string; message?: string }>)
      expect(body._tag).toBe("ServiceUnavailableError")
      expect(body.service).toBe("location")
      expect(body.message).toContain("workspace") // the cause names the directory it could not reach
    } finally {
      yield* Effect.promise(() => fs.chmod(locked, 0o700))
    }
  }),
)
