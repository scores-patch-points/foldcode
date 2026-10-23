// @refresh reload

import "@/runtime/polyfills"
import { init } from "@sentry/solid"
import { render } from "solid-js/web"
import { AppBaseProviders, AppInterface } from "@/app"
import { loadInitialLocale } from "@/runtime/i18n/language"
import { PlatformProvider } from "@/runtime/platform/platform"
import { createWebPlatform } from "@/runtime/platform/web"
import { isStandalone, PwaRoutePersistence, restorePwaRoute } from "@/runtime/platform/pwa"
import { KeyboardInsets } from "@/runtime/platform/keyboard"
import en from "@/runtime/i18n/en"
import zh from "@/runtime/i18n/zh"
import { authFromToken } from "@/runtime/server/api"
import pkg from "../package.json"
import { ServerConnection } from "@/runtime/server/registry"

const getLocale = () => {
  if (typeof navigator === "undefined") return "en" as const
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language]

  for (const language of languages) {
    if (!language) continue

    if (language.toLowerCase().startsWith("zh")) return "zh" as const
  }

  return "en" as const
}

const getRootNotFoundError = () => {
  const key = "error.dev.rootNotFound" as const
  const locale = getLocale()

  return locale === "zh" ? (zh[key] ?? en[key]) : en[key]
}

const root = document.getElementById("root")

if (!(root instanceof HTMLElement) && import.meta.env.DEV) {
  throw new Error(getRootNotFoundError())
}

const clearAuthToken = () => {
  const params = new URLSearchParams(location.search)

  if (!params.has("auth_token")) return
  params.delete("auth_token")
  history.replaceState(null, "", location.pathname + (params.size ? `?${params}` : "") + location.hash)
}

// DEV only: the server credential handed over once in the URL (?auth_token=) is kept for this tab, so a hot reload or a
// restart of the dev server does not log the window out and leave every request at 401 (2026-10-23, seen four times in a morning).
// The packaged app never reads this: Electron supplies the password itself.
const DEV_AUTH_KEY = "opencode.dev.auth_token"
const rememberedAuthToken = () => {
  if (!import.meta.env.DEV) return null
  try {
    return sessionStorage.getItem(DEV_AUTH_KEY)
  } catch {
    return null
  }
}
const rememberAuthToken = (token: string | null) => {
  if (!import.meta.env.DEV || !token) return
  try {
    sessionStorage.setItem(DEV_AUTH_KEY, token)
  } catch {
    /* no storage: the token lives for this load only */
  }
}

const web = createWebPlatform(pkg.version)

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"), { once: true })
}

if (import.meta.env.VITE_SENTRY_DSN) {
  init({
    dsn: import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT ?? import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE ?? `web@${pkg.version}`,
    initialScope: {
      tags: {
        platform: "web",
      },
    },
    integrations: (integrations) => {
      return integrations.filter(
        (i) =>
          i.name !== "Breadcrumbs" && !(import.meta.env.OPENCODE_CHANNEL === "prod" && i.name === "GlobalHandlers"),
      )
    },
  })
}

if (root instanceof HTMLElement && root.dataset.opencodeMounted === undefined) {
  // Lazy chunks can import the entry chunk back under a distinct URL, so claim the root before async startup.
  root.dataset.opencodeMounted = ""
  void loadInitialLocale().then((locale) => {
    const token = new URLSearchParams(location.search).get("auth_token") ?? rememberedAuthToken()
    rememberAuthToken(token)
    const auth = authFromToken(token)
    clearAuthToken()
    const standalone = isStandalone()
    root.dataset.standalone = String(standalone)

    if (standalone) restorePwaRoute()

    const server: ServerConnection.Http | undefined = web.currentServerUrl
      ? {
          type: "http",
          authToken: !!auth,
          http: {
            url: web.currentServerUrl,
            ...auth,
          },
        }
      : undefined

    render(
      () => (
        <PlatformProvider value={web.platform}>
          <AppBaseProviders locale={locale}>
            <AppInterface
              canonicalLocalServer={server ? ServerConnection.key(server) : undefined}
              servers={server ? [server] : []}
            >
              <KeyboardInsets />
              {standalone && <PwaRoutePersistence />}
            </AppInterface>
          </AppBaseProviders>
        </PlatformProvider>
      ),
      root,
    )
  })
}
