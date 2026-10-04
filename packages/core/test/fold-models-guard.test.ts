import { describe, expect, it } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// The Fold fork guard: when OPENCODE_MODELS_PATH is set, that file is the WHOLE
// catalog — the bundled models.dev snapshot and the network are never consulted.
// This is what makes the fork advertise only the providers heimdall serves. Kept
// in its own file so the Flag mutation cannot leak into the core suite.

const foldCatalog = {
  heimdall: {
    id: "heimdall",
    name: "The Fold · heimdall",
    api: "http://localhost:8790/v1",
    npm: "@ai-sdk/openai-compatible",
    env: [],
    models: {
      "qwen2.5-coder:1.5b": {
        id: "qwen2.5-coder:1.5b",
        name: "qwen2.5-coder:1.5b (local)",
        release_date: "2024-01-01",
        attachment: false,
        reasoning: false,
        temperature: true,
        tool_call: true,
        limit: { context: 32768, output: 8192 },
      },
    },
  },
}

describe("ModelsDev fork guard", () => {
  it("a set OPENCODE_MODELS_PATH is authoritative — no snapshot, no network", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fold-models-"))
    const pinned = path.join(dir, "models.dev.json")
    writeFileSync(pinned, JSON.stringify(foldCatalog))

    const calls: string[] = []
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        calls.push(request.url)
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ upstream: { id: "upstream" } }), { status: 200 }))
      }),
    )
    const layer = Layer.fresh(
      AppNodeBuilder.build(ModelsDev.node, [
        [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, client)],
      ]),
    )

    const originalPath = Flag.OPENCODE_MODELS_PATH
    const originalFetch = Flag.OPENCODE_DISABLE_MODELS_FETCH
    try {
      Flag.OPENCODE_MODELS_PATH = pinned
      Flag.OPENCODE_DISABLE_MODELS_FETCH = false
      const result = await Effect.runPromise(
        Effect.provide(
          ModelsDev.Service.use((s) => s.get()),
          layer,
        ),
      )
      expect(result).toEqual(foldCatalog)
      expect(calls).toEqual([])
    } finally {
      Flag.OPENCODE_MODELS_PATH = originalPath
      Flag.OPENCODE_DISABLE_MODELS_FETCH = originalFetch
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
