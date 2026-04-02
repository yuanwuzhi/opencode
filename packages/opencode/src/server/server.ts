import { Log } from "../util/log"
import { describeRoute, generateSpecs, validator, resolver, openAPIRouteHandler } from "hono-openapi"
import { Hono, type Context } from "hono"
import { compress } from "hono/compress"
import { cors } from "hono/cors"
import { proxy } from "hono/proxy"
import { basicAuth } from "hono/basic-auth"
import z from "zod"
import { Auth } from "../auth"
import { Flag } from "../flag/flag"
import { ProviderID } from "../provider/schema"
import { WorkspaceRouterMiddleware } from "./router"
import { websocket } from "hono/bun"
import { errors } from "./error"
import { GlobalRoutes } from "./routes/global"
import { MDNS } from "./mdns"
import { lazy } from "@/util/lazy"
import { errorHandler } from "./middleware"
import { InstanceRoutes } from "./instance"
import { initProjectors } from "./projectors"
import { normalizeBasePath, rewriteCssForBasePath, rewriteHtmlForBasePath, rewriteJsForBasePath } from "../util/base-path"

// @ts-ignore This global is needed to prevent ai-sdk from logging warnings to stdout https://github.com/vercel/ai/blob/2dc67e0ef538307f21368db32d5a12345d98831b/packages/ai/src/logger/log-warnings.ts#L85
globalThis.AI_SDK_LOG_WARNINGS = false

const embeddedUIPromise = Flag.OPENCODE_DISABLE_EMBEDDED_WEB_UI
  ? Promise.resolve(null)
  : // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null)

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".map": "application/json",
  ".wasm": "application/wasm",
}

function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf(".")).toLowerCase()
  return MIME_TYPES[ext] || "application/octet-stream"
}

initProjectors()

export namespace Server {
  const log = Log.create({ service: "server" })
  let _url: URL | undefined
  let _basePath = ""
  let _corsWhitelist: string[] = []

  const zipped = compress()

  const skipCompress = (path: string, method: string) => {
    if (path === "/event" || path === "/global/event" || path === "/global/sync-event") return true
    if (method === "POST" && /\/session\/[^/]+\/(message|prompt_async)$/.test(path)) return true
    return false
  }

  export const Default = lazy(() => ControlPlaneRoutes())

  const currentURL = () => {
    const base = _url ?? new URL("http://localhost:4096")
    return _basePath ? new URL(`${_basePath}/`, base) : base
  }

  const deprecatedUrl = new Proxy((() => currentURL()) as unknown as ((() => URL) & URL), {
    apply() {
      return currentURL()
    },
    get(_target, property, receiver) {
      const value = Reflect.get(currentURL(), property, receiver)
      return typeof value === "function" ? value.bind(currentURL()) : value
    },
  }) as unknown as ((() => URL) & URL)

  /** @deprecated do not use this dumb shit */
  export const url = deprecatedUrl

  export function basePath(): string {
    return _basePath
  }

  export const ControlPlaneRoutes = (opts?: { cors?: string[] }): Hono => {
    const app = new Hono()
    return app
      .onError(errorHandler(log))
      .use((c, next) => {
        // Allow CORS preflight requests to succeed without auth.
        // Browser clients sending Authorization headers will preflight with OPTIONS.
        if (c.req.method === "OPTIONS") return next()
        const password = Flag.OPENCODE_SERVER_PASSWORD
        if (!password) return next()
        const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
        return basicAuth({ username, password })(c, next)
      })
      .use(async (c, next) => {
        const skip = c.req.path === "/log"
        if (!skip) {
          log.info("request", {
            method: c.req.method,
            path: c.req.path,
          })
        }
        const timer = log.time("request", {
          method: c.req.method,
          path: c.req.path,
        })
        await next()
        if (!skip) {
          timer.stop()
        }
      })
      .use(
        cors({
          maxAge: 86_400,
          origin(input) {
            if (!input) return

            if (input.startsWith("http://localhost:")) return input
            if (input.startsWith("http://127.0.0.1:")) return input
            if (
              input === "tauri://localhost" ||
              input === "http://tauri.localhost" ||
              input === "https://tauri.localhost"
            )
              return input

            // *.opencode.ai (https only, adjust if needed)
            if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) {
              return input
            }
            if (opts?.cors?.includes(input)) {
              return input
            }

            return
          },
        }),
      )
      .use((c, next) => {
        if (skipCompress(c.req.path, c.req.method)) return next()
        return zipped(c, next)
      })
      .route("/global", GlobalRoutes())
      .put(
        "/auth/:providerID",
        describeRoute({
          summary: "Set auth credentials",
          description: "Set authentication credentials",
          operationId: "auth.set",
          responses: {
            200: {
              description: "Successfully set authentication credentials",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: ProviderID.zod,
          }),
        ),
        validator("json", Auth.Info.zod),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          const info = c.req.valid("json")
          await Auth.set(providerID, info)
          return c.json(true)
        },
      )
      .delete(
        "/auth/:providerID",
        describeRoute({
          summary: "Remove auth credentials",
          description: "Remove authentication credentials",
          operationId: "auth.remove",
          responses: {
            200: {
              description: "Successfully removed authentication credentials",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "param",
          z.object({
            providerID: ProviderID.zod,
          }),
        ),
        async (c) => {
          const providerID = c.req.valid("param").providerID
          await Auth.remove(providerID)
          return c.json(true)
        },
      )
      .get(
        "/doc",
        openAPIRouteHandler(app, {
          documentation: {
            info: {
              title: "opencode",
              version: "0.0.3",
              description: "opencode api",
            },
            openapi: "3.1.1",
          },
        }),
      )
      .use(
        validator(
          "query",
          z.object({
            directory: z.string().optional(),
            workspace: z.string().optional(),
          }),
        ),
      )
      .post(
        "/log",
        describeRoute({
          summary: "Write log",
          description: "Write a log entry to the server logs with specified level and metadata.",
          operationId: "app.log",
          responses: {
            200: {
              description: "Log entry written successfully",
              content: {
                "application/json": {
                  schema: resolver(z.boolean()),
                },
              },
            },
            ...errors(400),
          },
        }),
        validator(
          "json",
          z.object({
            service: z.string().meta({ description: "Service name for the log entry" }),
            level: z.enum(["debug", "info", "error", "warn"]).meta({ description: "Log level" }),
            message: z.string().meta({ description: "Log message" }),
            extra: z
              .record(z.string(), z.any())
              .optional()
              .meta({ description: "Additional metadata for the log entry" }),
          }),
        ),
        async (c) => {
          const { service, level, message, extra } = c.req.valid("json")
          const logger = Log.create({ service })

          switch (level) {
            case "debug":
              logger.debug(message, extra)
              break
            case "info":
              logger.info(message, extra)
              break
            case "error":
              logger.error(message, extra)
              break
            case "warn":
              logger.warn(message, extra)
              break
          }

          return c.json(true)
        },
      )
      .use(WorkspaceRouterMiddleware)
  }

  export function createApp(opts: { cors?: string[] }) {
    return ControlPlaneRoutes(opts)
  }

  export async function openapi() {
    // Build a fresh app with all routes registered directly so
    // hono-openapi can see describeRoute metadata (`.route()` wraps
    // handlers when the sub-app has a custom errorHandler, which
    // strips the metadata symbol).
    const app = ControlPlaneRoutes()
    InstanceRoutes(app)
    const result = await generateSpecs(app, {
      documentation: {
        info: {
          title: "opencode",
          version: "1.0.0",
          description: "opencode api",
        },
        openapi: "3.1.1",
      },
    })
    return result
  }

  export function listen(opts: {
    port: number
    hostname: string
    mdns?: boolean
    mdnsDomain?: string
    cors?: string[]
    basePath?: string
  }) {
    _basePath = normalizeBasePath(opts.basePath)
    _corsWhitelist = opts.cors ?? []

    const mainApp = ControlPlaneRoutes({ cors: _corsWhitelist })
    const baseApp = new Hono()

    if (_basePath) {
      const basePathHandler = async (c: Context) => {
        let path = c.req.path
        if (path.startsWith(_basePath)) {
          path = path.slice(_basePath.length) || "/"
        }

        const url = new URL(c.req.url)
        url.pathname = path

        const rewrittenRequest = new Request(url, c.req.raw)
        const isControlPlane =
          path === "/doc" ||
          path === "/log" ||
          path.startsWith("/global") ||
          path.startsWith("/auth/") ||
          path.startsWith("/event") ||
          path.startsWith("/session") ||
          path.startsWith("/project") ||
          path.startsWith("/pty") ||
          path.startsWith("/config") ||
          path.startsWith("/experimental") ||
          path.startsWith("/permission") ||
          path.startsWith("/question") ||
          path.startsWith("/provider") ||
          path.startsWith("/find") ||
          path.startsWith("/file") ||
          path.startsWith("/mcp") ||
          path.startsWith("/tui") ||
          path.startsWith("/path") ||
          path.startsWith("/vcs") ||
          path.startsWith("/command") ||
          path.startsWith("/agent") ||
          path.startsWith("/skill") ||
          path.startsWith("/lsp") ||
          path.startsWith("/formatter") ||
          path.startsWith("/instance/")

        if (isControlPlane) {
          return mainApp.fetch(rewrittenRequest, c.env)
        }

        const embeddedWebUI = await embeddedUIPromise
        if (embeddedWebUI) {
          const assetKey = path.replace(/^\//, "")
          const match = embeddedWebUI[assetKey] ?? embeddedWebUI["index.html"] ?? null
          if (match) {
            const file = Bun.file(match)
            if (await file.exists()) {
              const contentType = getMimeType(assetKey || "index.html")
              const headers = new Headers()
              headers.set("Content-Type", contentType)

              if (contentType.includes("text/html")) {
                const html = rewriteHtmlForBasePath(await file.text(), _basePath)
                return new Response(html, { status: 200, headers })
              }

              if (contentType.includes("javascript") || assetKey.endsWith(".js")) {
                const js = rewriteJsForBasePath(await file.text(), _basePath)
                return new Response(js, { status: 200, headers })
              }

              if (contentType.includes("text/css") || assetKey.endsWith(".css")) {
                const css = rewriteCssForBasePath(await file.text(), _basePath)
                return new Response(css, { status: 200, headers })
              }

              return new Response(await file.arrayBuffer(), { status: 200, headers })
            }
          }
        }

        const response = await proxy(`https://app.opencode.ai${path}`, {
          headers: {
            ...Object.fromEntries(c.req.raw.headers),
            host: "app.opencode.ai",
          },
        })

        const contentType = response.headers.get("content-type") || ""

        if (contentType.includes("text/html")) {
          const html = rewriteHtmlForBasePath(await response.text(), _basePath)
          const headers = new Headers(response.headers)
          headers.delete("content-length")
          return new Response(html, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        }

        if (contentType.includes("javascript") || path.endsWith(".js")) {
          const js = rewriteJsForBasePath(await response.text(), _basePath)
          const headers = new Headers(response.headers)
          headers.delete("content-length")
          return new Response(js, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        }

        if (contentType.includes("text/css") || path.endsWith(".css")) {
          const css = rewriteCssForBasePath(await response.text(), _basePath)
          const headers = new Headers(response.headers)
          headers.delete("content-length")
          return new Response(css, {
            status: response.status,
            statusText: response.statusText,
            headers,
          })
        }

        return response
      }

      baseApp.all(_basePath, basePathHandler)
      baseApp.all(`${_basePath}/*`, basePathHandler)
    }

    const app = _basePath ? baseApp : mainApp

    const args = {
      hostname: opts.hostname,
      idleTimeout: 0,
      fetch: app.fetch,
      websocket: websocket,
    } as const
    const tryServe = (port: number) => {
      try {
        return Bun.serve({ ...args, port })
      } catch {
        return undefined
      }
    }
    const server = opts.port === 0 ? (tryServe(4096) ?? tryServe(0)) : tryServe(opts.port)
    if (!server) throw new Error(`Failed to start server on port ${opts.port}`)

    _url = new URL(`http://${server.hostname}:${server.port}`)

    const shouldPublishMDNS =
      opts.mdns &&
      server.port &&
      opts.hostname !== "127.0.0.1" &&
      opts.hostname !== "localhost" &&
      opts.hostname !== "::1"
    if (shouldPublishMDNS) {
      MDNS.publish(server.port!, opts.mdnsDomain)
    } else if (opts.mdns) {
      log.warn("mDNS enabled but hostname is loopback; skipping mDNS publish")
    }

    const originalStop = server.stop.bind(server)
    server.stop = async (closeActiveConnections?: boolean) => {
      if (shouldPublishMDNS) MDNS.unpublish()
      return originalStop(closeActiveConnections)
    }

    return server
  }
}
