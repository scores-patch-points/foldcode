import { expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder.js"
import { FoldPlugin } from "../src/plugin/fold.js"
import { WebSearch } from "../src/websearch.js"
import { Bus } from "../src/bus.js"
import { KV } from "../src/kv.js"
import { LayerNode } from "@opencode/util/effect/layer-node"
import type { Plugin } from "@opencode/plugin/effect"
import { host, webSearchHost } from "./plugin/host.js"

const layer = AppNodeBuilder.build(LayerNode.group([Bus.node, KV.node, WebSearch.node]))

type ModelEditor = Parameters<Plugin.Context["model"]["transform"]>[0] extends (editor: infer E) => void ? E : never
type ToolEditor = Parameters<Plugin.Context["tool"]["transform"]>[0] extends (editor: infer E) => void ? E : never

const registration = { dispose: Effect.void }
const modelEditor = {
  list: () => [],
  get: () => undefined,
  update: () => {},
  remove: () => {},
  default: { get: () => undefined, set: () => {} },
  provider: { list: () => [], get: () => undefined },
} as unknown as ModelEditor
const toolEditor = {
  list: () => [],
  get: () => undefined,
  namespace: () => {},
  add: () => {},
  update: () => {},
  remove: () => {},
} as unknown as ToolEditor

const context = (websearch: WebSearch.Interface) =>
  host({
    model: {
      list: () => Effect.die("unused model.list"),
      default: () => Effect.die("unused model.default"),
      transform: (callback) => Effect.sync(() => callback(modelEditor)).pipe(Effect.as(registration)),
      reload: () => Effect.die("unused model.reload"),
    },
    command: {
      list: () => Effect.die("unused command.list"),
      transform: (callback) => Effect.sync(() => callback({ add: () => {} })).pipe(Effect.as(registration)),
      reload: () => Effect.die("unused command.reload"),
    },
    tool: {
      transform: (callback) => Effect.sync(() => callback(toolEditor)).pipe(Effect.as(registration)),
      reload: () => Effect.die("unused tool.reload"),
      list: () => Effect.die("unused tool.list"),
      hook: () => Effect.die("unused tool.hook"),
    },
    websearch: webSearchHost(websearch),
    event: { subscribe: () => Stream.empty },
    session: { hook: () => Effect.succeed(registration) },
  })

// SAFETY: the doorway's provider calls global fetch (the file's idiom for the door and heimdall);
// this test is the one place that must stand in for that machine-local engine.
const withHeimdall = <A>(body: string, run: () => Promise<A>) => {
  const original = globalThis.fetch
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    )) as unknown as typeof fetch
  return run().finally(() => {
    globalThis.fetch = original
  })
}

const heimdall = JSON.stringify({
  scope: "web",
  q: "effect typescript",
  engine: "Brave Search",
  count: 1,
  results: [{ title: "Effect", url: "https://effect.website", snippet: "Effect docs", source: "effect.website" }],
  via: "this machine",
})

test("the doorway registers a native keyless web search provider alongside the built-ins", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const websearch = yield* WebSearch.Service
      yield* FoldPlugin.Plugin.effect(context(websearch))
      expect(yield* websearch.providers()).toContainEqual({
        id: WebSearch.ID.make("this-machine"),
        name: "This machine",
      })
      // The doorway never forces a default: the upstream first-search flow still selects and remembers.
      expect(yield* websearch.default()).toBeUndefined()
    }).pipe(Effect.provide(layer), Effect.scoped),
  ))

test("the native provider maps heimdall's own results", () =>
  withHeimdall(heimdall, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const websearch = yield* WebSearch.Service
        yield* FoldPlugin.Plugin.effect(context(websearch))
        const providerID = WebSearch.ID.make("this-machine")
        expect(yield* websearch.query({ query: "effect typescript", providerID })).toEqual(
          new WebSearch.Response({
            providerID,
            results: [{ url: "https://effect.website", title: "Effect", content: "Effect docs", time: {} }],
          }),
        )
      }).pipe(Effect.provide(layer), Effect.scoped),
    ),
  ))
