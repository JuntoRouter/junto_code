import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Model } from "@opencode-ai/sdk/v2"
import { Log } from "../../util/log"
import { createServer } from "node:http"
import { URL } from "node:url"
import { junto_generate_image, junto_generate_audio, junto_generate_video } from "./media-tools"

const log = Log.create({ service: "plugin.junto" })

import { JUNTO_API_BASE, JUNTO_AUTH_URL } from "./constants"
import { JuntoApi } from "./junto-api"

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === "object") {
        const port = addr.port
        server.close(() => resolve(port))
      } else {
        reject(new Error("Failed to find free port"))
      }
    })
  })
}

async function fetchModels(apiKey?: string): Promise<Record<string, Model>> {
  try {
    const headers: Record<string, string> = {}
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`
    const res = await fetch(`${JUNTO_API_BASE}/models`, { headers })
    if (!res.ok) return {}
    const data = (await res.json()) as { data: Array<{ id: string; context_length?: number; max_output_tokens?: number; capabilities?: any; pricing?: any; providers?: string[] }> }
    const models: Record<string, Model> = {}
    for (const m of data.data ?? []) {
      models[m.id] = {
        id: m.id,
        name: m.id,
        api: {
          id: m.id,
          url: JUNTO_API_BASE,
          npm: "@ai-sdk/openai-compatible",
        },
        providerID: "junto" as any,
        status: "active",
        headers: {},
        options: {},
        cost: {
          input: parseFloat(m.pricing?.prompt ?? "0") * 1_000_000,
          output: parseFloat(m.pricing?.completion ?? "0") * 1_000_000,
          cache: { read: 0, write: 0 },
        },
        limit: {
          context: m.context_length ?? 128000,
          output: m.max_output_tokens ?? 8192,
        },
        capabilities: {
          temperature: true,
          reasoning: m.capabilities?.reasoning ?? false,
          attachment: m.capabilities?.vision ?? false,
          toolcall: m.capabilities?.tool_calling ?? true,
          input: { text: true, audio: false, image: m.capabilities?.vision ?? false, video: false, pdf: m.capabilities?.pdf ?? false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        variants: {},
        release_date: "",
      }
    }
    // Filter by team allowlist if available
    if (apiKey) {
      try {
        const teamModels = await JuntoApi.getTeamModels(apiKey)
        if (teamModels.length > 0) {
          const allowed = new Set(teamModels)
          for (const id of Object.keys(models)) {
            if (!allowed.has(id)) delete models[id]
          }
          log.info("Filtered models by team allowlist", { total: Object.keys(models).length, allowed: teamModels.length })
        }
      } catch {
        // Allowlist fetch failed — show all models
      }
    }

    return models
  } catch (err) {
    log.error("Failed to fetch junto models", { error: err })
    return {}
  }
}

async function ensureApiKey(token: string, teamId?: string): Promise<string> {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
  const keyName = teamId ? `opencode-team-${teamId.slice(0, 8)}` : "opencode-personal"
  const body: Record<string, unknown> = { name: keyName }
  if (teamId) body.teamId = teamId

  const res = await fetch(`${JUNTO_API_BASE}/me/keys`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => "")
    log.error("Failed to create API key", { status: res.status, body: err })
    throw new Error(`Failed to create API key: ${res.status}`)
  }
  const created = (await res.json()) as { key: { value: string } }
  return created.key.value
}

export async function JuntoAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    tool: {
      junto_generate_image,
      junto_generate_audio,
      junto_generate_video,
    },
    provider: {
      id: "junto",
      async models(provider, ctx) {
        const apiKey = ctx.auth?.type === "api" ? ctx.auth.key : undefined
        const fetched = await fetchModels(apiKey)
        if (Object.keys(fetched).length > 0) return fetched
        return provider.models
      },
    },
    auth: {
      provider: "junto",
      async loader(getAuth) {
        const info = await getAuth()
        if (!info) return {}
        if (info.type === "api" && info.key) return { apiKey: info.key }
        return {}
      },
      methods: [
        {
          type: "oauth" as const,
          label: "Login with JuntoRouter",
          async authorize() {
            const port = await findFreePort()
            let resolveToken: (token: string) => void
            let rejectToken: (err: Error) => void
            const tokenPromise = new Promise<string>((resolve, reject) => {
              resolveToken = resolve
              rejectToken = reject
            })

            const httpServer = createServer((req, res) => {
              const url = new URL(req.url ?? "/", `http://localhost:${port}`)
              // Only accept tokens on the /callback path
              if (url.pathname !== "/callback") {
                res.writeHead(404)
                res.end("Not found")
                return
              }
              const token = url.searchParams.get("token")
              if (token) {
                res.writeHead(200, { "Content-Type": "text/html" })
                res.end("<html><body><h2>Login successful!</h2><p>You can close this tab and return to JuntoCode.</p></body></html>")
                resolveToken!(token)
              } else {
                res.writeHead(400)
                res.end("Missing token")
              }
            })

            httpServer.listen(port)

            // Timeout: close server after 5 minutes if no callback received
            const timeout = setTimeout(() => {
              httpServer.close()
              rejectToken!(new Error("OAuth login timed out after 5 minutes"))
            }, 5 * 60 * 1000)

            const callbackUrl = `http://localhost:${port}/callback`
            const authUrl = `${JUNTO_AUTH_URL}?callback=${encodeURIComponent(callbackUrl)}`

            return {
              url: authUrl,
              instructions: "Sign in with your Google account in the browser",
              method: "auto" as const,
              async callback() {
                try {
                  const token = await tokenPromise
                  clearTimeout(timeout)
                  httpServer.close()

                  log.info("Token received, creating personal API key...")
                  const apiKey = await ensureApiKey(token)
                  log.info("API key created successfully")

                  return { type: "success" as const, key: apiKey }
                } catch (err) {
                  clearTimeout(timeout)
                  log.error("Auth callback failed", { error: err })
                  httpServer.close()
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
      ],
    },
  }
}
