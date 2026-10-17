import { FileSystem } from "@opencode/core/filesystem"
import { Location } from "@opencode/core/location"
import { Plugin } from "@opencode/core/plugin"
import { LocationServiceMap } from "@opencode/core/location-services"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { LocationNotFoundError, InvalidRequestError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { Effect, Layer, Schema } from "effect"
import { HttpServerRequest } from "effect/http"
import { HttpApiMiddleware } from "effect/http-api"
import { missingSession } from "./handlers/session-error"

export type LocationServices = Layer.Success<ReturnType<(typeof LocationServiceMap.Service)["get"]>>

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@opencode/HttpApiLocation",
  { error: [LocationNotFoundError, ServiceUnavailableError] },
) {}

export function locationErrors<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return effect.pipe(
    Effect.catchIf(
      (error): error is Extract<E, FileSystem.DirectoryNotFoundError> =>
        error instanceof FileSystem.DirectoryNotFoundError,
      (error) =>
        Effect.fail(
          new LocationNotFoundError({
            location: { directory: error.directory },
            message: `Location not found: ${error.directory}`,
          }),
        ),
    ),
    // An unreadable directory — macOS Files-and-Folders answers EPERM (a rebuild of the app invalidates
    // its grant), a mode bit answers EACCES — dies in the resolution layer (FSUtil.resolve's orDie) and
    // must arrive as a typed 503 with its cause disclosed, never a bare 500 that swallows it.
    Effect.catchDefect((defect) =>
      Effect.fail(
        new ServiceUnavailableError({
          message: defect instanceof Error ? defect.message : String(defect),
          service: "location",
        }),
      ),
    ),
  )
}

export const awaitPlugins = Plugin.awaitActivation.pipe(
  Effect.timeoutOrElse({
    duration: "5 seconds",
    orElse: () =>
      Effect.fail(
        new ServiceUnavailableError({
          message: "Location plugins did not finish activating",
          service: "plugin",
        }),
      ),
  }),
)

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

const decodeSessionID = Schema.decodeUnknownEffect(Session.ID)

export const sessionInfo = Effect.fnUntraced(function* (sessions: Session.Interface, sessionID: unknown) {
  const id = yield* decodeSessionID(sessionID).pipe(
    Effect.mapError(() => new InvalidRequestError({ message: "Invalid session ID", field: "sessionID" })),
  )
  return yield* sessions.get(id).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
})

export function requestRef(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  const query = new URL(request.url, "http://localhost").searchParams
  const directory =
    query.get("location[directory]") ||
    (request.headers["x-opencode-directory"] ? decode(request.headers["x-opencode-directory"]) : process.cwd())
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
  })
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

// Location resolution is a local syscall in the normal case. When macOS holds that syscall on a
// Files-and-Folders consent dialog (a rebuilt app has no recorded decision yet), it waits on a human
// indefinitely — and every request behind it waits too. Bound the WAIT, never the route: a resolution
// that has not answered in ten seconds answers the same typed 503 the denial path does, remedy named.
const RESOLUTION_BOUND = "10 seconds"
const bounded = <A, E, R>(step: Effect.Effect<A, E, R>) =>
  step.pipe(
    Effect.timeoutOrElse({
      duration: RESOLUTION_BOUND,
      orElse: () =>
        Effect.fail(
          new ServiceUnavailableError({
            message: `Location did not resolve within ${RESOLUTION_BOUND}: a Files-and-Folders consent dialog may be waiting for an answer — grant this app access to the workspace's folder, or keep the workspace outside a protected folder (Downloads, Desktop, Documents)`,
            service: "location",
          }),
        ),
    }),
  )

export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const services = yield* bounded(Layer.build(locations.get(requestRef(request))))
            return yield* effect.pipe(Effect.provideContext(services))
          }),
        )
      }).pipe(locationErrors),
    )
  }),
)
