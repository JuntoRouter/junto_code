import { Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"

const JUNTO_API_BASE = "https://us-central1-ms-junto.cloudfunctions.net/juntoRouter/api/v1"

type Profile = {
  uid: string
  email: string
  photoURL?: string | null
  tier: string
  limits: { rpm: number | null; tpm: number | null; rpd: number | null }
}

type Credits = {
  balancePoints: number
  balanceMp: number
  balanceTwd: number
}

type DailyUsage = {
  date: string
  totalRequests: number
  totalTokens: number
  totalCostUsd: number
  byModel: Array<{ model: string; requests: number; tokens: number; cost: number }>
}

type TeamMembership = {
  team: { id: string; name: string; ownerId: string; totalPoolMp: number; sharePoolMp: number; allocatedMp: number } | null
  membership: { role: string; allocationMp: number; usedMp: number }
}

type ApiKeyInfo = {
  id: string
  name: string
  maskedKey: string
  tier: string
  teamId: string | null
  createdAt: string
}

type Dashboard = {
  profile?: Profile
  credits?: Credits
  usage?: DailyUsage
  teams?: TeamMembership[]
  keys?: ApiKeyInfo[]
}

async function fetchJson<T>(url: string, apiKey: string): Promise<T | undefined> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    })
    if (!res.ok) return undefined
    return (await res.json()) as T
  } catch {
    return undefined
  }
}

async function postJson<T>(url: string, apiKey: string, body: Record<string, unknown>): Promise<T | undefined> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) return undefined
    return (await res.json()) as T
  } catch {
    return undefined
  }
}

async function fetchDashboard(apiKey: string): Promise<Dashboard> {
  const date = new Date().toISOString().split("T")[0]
  const [profile, credits, usage, teamsData, keysData] = await Promise.all([
    fetchJson<Profile>(`${JUNTO_API_BASE}/me/profile`, apiKey),
    fetchJson<Credits>(`${JUNTO_API_BASE}/me/credits`, apiKey),
    fetchJson<DailyUsage>(`${JUNTO_API_BASE}/me/usage/daily?date=${date}`, apiKey),
    fetchJson<{ teams: TeamMembership[] }>(`${JUNTO_API_BASE}/me/team`, apiKey),
    fetchJson<{ keys: ApiKeyInfo[] }>(`${JUNTO_API_BASE}/me/keys`, apiKey),
  ])
  return { profile, credits, usage, teams: teamsData?.teams, keys: keysData?.keys }
}

type MediaModel = { id: string; owned_by: string }
type MediaType = "image" | "audio_tts" | "audio_stt" | "video"

const MEDIA_MODEL_PATTERNS: Record<MediaType, RegExp[]> = {
  image: [/dall-e/i, /gpt-image/i, /flux/i, /gemini.*image/i, /stable-diffusion/i],
  audio_tts: [/tts/i, /gemini.*tts/i],
  audio_stt: [/whisper/i],
  video: [/veo/i],
}

function classifyMediaModel(modelId: string): MediaType | undefined {
  for (const [type, patterns] of Object.entries(MEDIA_MODEL_PATTERNS) as [MediaType, RegExp[]][]) {
    if (patterns.some((p) => p.test(modelId))) return type
  }
  return undefined
}

async function fetchMediaModels(): Promise<Record<MediaType, MediaModel[]>> {
  const result: Record<MediaType, MediaModel[]> = { image: [], audio_tts: [], audio_stt: [], video: [] }
  try {
    const res = await fetch(`${JUNTO_API_BASE}/models`)
    if (!res.ok) return result
    const data = (await res.json()) as { data: Array<{ id: string; owned_by: string }> }
    for (const m of data.data ?? []) {
      const type = classifyMediaModel(m.id)
      if (type) result[type].push({ id: m.id, owned_by: m.owned_by })
    }
  } catch {}
  return result
}

type MediaDefaults = { image?: string; audio_tts?: string; audio_stt?: string; video?: string }
const MEDIA_DEFAULTS_KEY = "junto-media-defaults"

function loadMediaDefaults(): MediaDefaults {
  try { return JSON.parse(localStorage.getItem(MEDIA_DEFAULTS_KEY) || "{}") } catch { return {} }
}

function persistMediaDefaults(defaults: MediaDefaults, server?: { url: string; username?: string; password?: string }) {
  localStorage.setItem(MEDIA_DEFAULTS_KEY, JSON.stringify(defaults))
  // Sync to sidecar filesystem so CLI tools can read it
  if (server?.url) {
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (server.password) {
      headers["Authorization"] = `Basic ${btoa(`${server.username ?? "opencode"}:${server.password}`)}`
    }
    void fetch(`${server.url}/storage/junto-media-defaults`, {
      method: "PUT",
      headers,
      body: JSON.stringify(defaults),
    }).catch(() => {})
  }
}

type Tab = "overview" | "usage" | "keys" | "models"

export const DialogJuntoDashboard: Component = () => {
  const globalSDK = useGlobalSDK()
  const server = useServer()
  const dialog = useDialog()

  const [apiKey, { refetch: refetchKey }] = createResource(async () => {
    const res = await globalSDK.client.config.providers()
    const providers = res.data?.providers ?? []
    const junto = providers.find((p) => p.id === "junto")
    return junto?.key
  })

  const [dashboard, { refetch: refetchDashboard }] = createResource(
    () => apiKey(),
    async (key) => {
      if (!key) return undefined
      return fetchDashboard(key)
    },
  )

  const [tab, setTab] = createSignal<Tab>("overview")
  const [busy, setBusy] = createSignal(false)
  const [mediaModels] = createResource(async () => fetchMediaModels())
  const [mediaDefaults, setMediaDefaults] = createSignal<MediaDefaults>(loadMediaDefaults())

  const updateMediaDefault = (type: MediaType, modelId: string) => {
    const next = { ...mediaDefaults(), [type]: modelId }
    setMediaDefaults(next)
    persistMediaDefaults(next, server.current?.http)
    showToast({ variant: "success", title: `Default ${type} model updated` })
  }

  const formatPoints = (mp: number) => {
    if (mp >= 1_000_000) return `${(mp / 1_000_000).toFixed(1)}M`
    if (mp >= 1_000) return `${(mp / 1_000).toFixed(1)}K`
    return mp.toString()
  }
  const formatCost = (usd: number) => `$${usd.toFixed(4)}`
  const loading = createMemo(() => apiKey.loading || dashboard.loading)

  // Derive current key's masked prefix from the full key
  const currentMaskedPrefix = createMemo(() => {
    const key = apiKey()
    if (!key) return undefined
    // maskedKey format: "sk-j...XXXX" — match last 4 chars
    return key.slice(-4)
  })

  const isCurrentKey = (k: ApiKeyInfo) => {
    const suffix = currentMaskedPrefix()
    if (!suffix) return false
    return k.maskedKey.endsWith(suffix)
  }

  // Group keys: current first, then personal, then team
  const sortedKeys = createMemo(() => {
    const keys = dashboard()?.keys
    if (!keys) return []
    return [...keys].sort((a, b) => {
      const aCurrent = isCurrentKey(a) ? 0 : 1
      const bCurrent = isCurrentKey(b) ? 0 : 1
      if (aCurrent !== bCurrent) return aCurrent - bCurrent
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
  })

  const openDashboard = () => {
    void import("./dialog-junto-dashboard").then((x) => {
      dialog.show(() => <x.DialogJuntoDashboard />)
    })
  }

  const handleConnect = () => {
    void import("./dialog-connect-provider").then((x) => {
      dialog.show(() => <x.DialogConnectProvider provider="junto" onBack={openDashboard} />)
    })
  }

  const handleDisconnect = async () => {
    await globalSDK.client.auth.remove({ providerID: "junto" })
    await globalSDK.client.global.dispose()
    dialog.close()
    showToast({ variant: "success", title: "Disconnected from Junto" })
  }

  const switchToKey = async (keyValue: string, label: string) => {
    setBusy(true)
    try {
      await globalSDK.client.auth.set({
        providerID: "junto",
        auth: { type: "api", key: keyValue },
      })
      await globalSDK.client.global.dispose()
      showToast({ variant: "success", title: `Switched to: ${label}` })
      refetchKey()
    } finally {
      setBusy(false)
    }
  }

  const createAndSwitch = async (name: string, teamId?: string) => {
    const key = apiKey()
    if (!key) return
    setBusy(true)
    try {
      const body: Record<string, unknown> = { name }
      if (teamId) body.teamId = teamId
      const result = await postJson<{ key: { value: string } }>(`${JUNTO_API_BASE}/me/keys`, key, body)
      if (!result?.key?.value) {
        showToast({ variant: "error", title: "Failed to create API key" })
        return
      }
      await switchToKey(result.key.value, name)
      refetchDashboard()
    } finally {
      setBusy(false)
    }
  }

  const keyLabel = (k: ApiKeyInfo) => {
    if (k.teamId) return `${k.name} (team)`
    return k.name
  }

  function TabButton(props: { id: Tab; label: string }) {
    return (
      <button
        class={`text-13-medium pb-1 ${tab() === props.id ? "text-text border-b-2 border-brand" : "text-text-weaker hover:text-text"}`}
        onClick={() => setTab(props.id)}
      >
        {props.label}
      </button>
    )
  }

  return (
    <Dialog title="Junto Dashboard">
      <div class="flex flex-col gap-4 p-4 min-w-[420px] max-h-[70vh] overflow-y-auto">
        {/* Not connected */}
        <Show when={!apiKey.loading && !apiKey()}>
          <div class="flex flex-col gap-3 items-center py-8">
            <p class="text-14-regular text-text-weaker">Connect to Junto Router to get started.</p>
            <Button variant="primary" size="large" onClick={handleConnect}>
              Login with Google
            </Button>
          </div>
        </Show>

        <Show when={loading()}>
          <div class="flex items-center gap-2 py-4">
            <Spinner />
            <p class="text-text-weaker">Loading...</p>
          </div>
        </Show>

        <Show when={dashboard()}>
          {(data) => (
            <>
              {/* Tabs */}
              <div class="flex gap-4 border-b border-border pb-2">
                <TabButton id="overview" label="Overview" />
                <TabButton id="usage" label="Usage" />
                <TabButton id="keys" label="API Keys" />
                <TabButton id="models" label="Models" />
              </div>

              {/* ── Overview ── */}
              <Show when={tab() === "overview"}>
                <Show when={data().profile}>
                  {(profile) => (
                    <div class="flex flex-col gap-1">
                      <h3 class="text-13-medium text-text">Profile</h3>
                      <div class="flex gap-2 text-13-regular">
                        <span class="text-text-weaker">Email:</span>
                        <span class="text-text">{profile().email || "—"}</span>
                      </div>
                      <div class="flex gap-2 text-13-regular">
                        <span class="text-text-weaker">Tier:</span>
                        <span class="text-text">{profile().tier}</span>
                      </div>
                    </div>
                  )}
                </Show>

                <Show when={data().credits}>
                  {(credits) => (
                    <div class="flex flex-col gap-1">
                      <h3 class="text-13-medium text-text">Credits</h3>
                      <div class="flex gap-2 text-13-regular items-center">
                        <span class="text-text-weaker">Balance:</span>
                        <span class={credits().balancePoints > 0 ? "text-fill-positive" : "text-fill-caution"}>
                          {formatPoints(credits().balancePoints)} pts
                        </span>
                        <span class="text-text-weaker">(NT${credits().balanceTwd?.toFixed(0) ?? "0"})</span>
                      </div>
                    </div>
                  )}
                </Show>

                <Show when={data().teams && data().teams!.length > 0}>
                  <div class="flex flex-col gap-2">
                    <h3 class="text-13-medium text-text">Teams</h3>
                    <For each={data().teams}>
                      {(tm) => (
                        <Show when={tm.team}>
                          {(team) => (
                            <div class="flex flex-col gap-0.5 pl-2 border-l-2 border-border">
                              <div class="flex items-center gap-2 text-13-regular">
                                <span class="text-text font-medium">{team().name}</span>
                                <span class="text-text-weaker">({tm.membership.role})</span>
                              </div>
                              <div class="flex gap-3 text-11-regular text-text-weaker">
                                <span>Pool: {formatPoints(team().totalPoolMp)}</span>
                                <span>Allocated: {formatPoints(tm.membership.allocationMp)}</span>
                                <span>Used: {formatPoints(tm.membership.usedMp)}</span>
                              </div>
                            </div>
                          )}
                        </Show>
                      )}
                    </For>
                  </div>
                </Show>

                {/* Footer actions */}
                <div class="pt-3 border-t border-border">
                  <Button variant="ghost" size="small" onClick={handleDisconnect}>
                    Disconnect
                  </Button>
                </div>
              </Show>

              {/* ── Usage ── */}
              <Show when={tab() === "usage"}>
                <Show when={data().usage} fallback={<p class="text-text-weaker">No usage data for today</p>}>
                  {(usage) => (
                    <div class="flex flex-col gap-3">
                      <h3 class="text-13-medium text-text">Today ({usage().date})</h3>
                      <div class="flex gap-4 text-13-regular">
                        <div class="flex gap-1">
                          <span class="text-text-weaker">Requests:</span>
                          <span class="text-text">{usage().totalRequests}</span>
                        </div>
                        <div class="flex gap-1">
                          <span class="text-text-weaker">Tokens:</span>
                          <span class="text-text">{usage().totalTokens.toLocaleString()}</span>
                        </div>
                        <div class="flex gap-1">
                          <span class="text-text-weaker">Cost:</span>
                          <span class="text-text">{formatCost(usage().totalCostUsd)}</span>
                        </div>
                      </div>
                      <Show when={usage().byModel.length > 0}>
                        <div class="flex flex-col gap-1">
                          <h4 class="text-13-medium text-text">By Model</h4>
                          <For each={usage().byModel}>
                            {(m) => (
                              <div class="flex items-center gap-2 text-13-regular pl-2">
                                <span class="text-brand">•</span>
                                <span class="text-text font-medium">{m.model}</span>
                                <span class="text-text-weaker">
                                  {m.requests} req · {m.tokens.toLocaleString()} tok · {formatCost(m.cost)}
                                </span>
                              </div>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  )}
                </Show>
              </Show>

              {/* ── API Keys ── */}
              <Show when={tab() === "keys"}>
                {/* Existing keys */}
                <Show
                  when={sortedKeys().length > 0}
                  fallback={<p class="text-text-weaker">No API keys found</p>}
                >
                  <div class="flex flex-col gap-1">
                    <h3 class="text-13-medium text-text">Existing Keys</h3>
                    <p class="text-11-regular text-text-weaker">Select a key to use, or create a new one below.</p>
                    <div class="flex flex-col gap-0.5 mt-1">
                      <For each={sortedKeys()}>
                        {(k) => {
                          const current = () => isCurrentKey(k)
                          return (
                            <div
                              class={`flex items-center justify-between py-1.5 px-2 rounded ${current() ? "bg-surface-inset" : "hover:bg-surface-inset/50"}`}
                            >
                              <div class="flex flex-col gap-0">
                                <div class="flex items-center gap-2">
                                  <span class="text-12-regular font-mono text-text">{k.maskedKey}</span>
                                  <Show when={current()}>
                                    <span class="text-10-regular text-fill-positive font-medium px-1 py-0.5 rounded bg-surface-positive/10">
                                      active
                                    </span>
                                  </Show>
                                </div>
                                <div class="flex items-center gap-1.5 text-11-regular text-text-weaker">
                                  <span>{k.name}</span>
                                  <Show when={k.teamId}>
                                    <span>· team</span>
                                  </Show>
                                </div>
                              </div>
                              <Show when={!current()}>
                                <Button
                                  variant="secondary"
                                  size="small"
                                  disabled={busy()}
                                  onClick={() => {
                                    // Can't switch to masked key — need to recreate
                                    // For now, create a new key with same name/team
                                    if (k.teamId) {
                                      createAndSwitch(k.name, k.teamId)
                                    } else {
                                      createAndSwitch(k.name)
                                    }
                                  }}
                                >
                                  Use
                                </Button>
                              </Show>
                            </div>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                </Show>

                {/* Create new key */}
                <div class="flex flex-col gap-2 pt-3 border-t border-border">
                  <h3 class="text-13-medium text-text">Create New Key</h3>
                  <div class="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={busy()}
                      onClick={() => createAndSwitch("opencode-personal")}
                    >
                      {busy() ? "Creating..." : "Personal Key"}
                    </Button>
                    <Show when={data().teams && data().teams!.length > 0}>
                      <For each={data().teams}>
                        {(tm) => (
                          <Show when={tm.team}>
                            {(team) => (
                              <Button
                                variant="secondary"
                                size="small"
                                disabled={busy()}
                                onClick={() => createAndSwitch(`opencode-team-${team().id.slice(0, 8)}`, team().id)}
                              >
                                {busy() ? "Creating..." : `${team().name} Key`}
                              </Button>
                            )}
                          </Show>
                        )}
                      </For>
                    </Show>
                  </div>
                </div>
              </Show>

              {/* ── Models ── */}
              <Show when={tab() === "models"}>
                <Show when={mediaModels.loading}>
                  <div class="flex items-center gap-2">
                    <Spinner />
                    <p class="text-text-weaker">Loading models...</p>
                  </div>
                </Show>
                <Show when={mediaModels()}>
                  {(models) => {
                    const sections: { type: MediaType; label: string; fallback: string }[] = [
                      { type: "image", label: "Image Generation", fallback: "openai/gpt-image-1" },
                      { type: "audio_tts", label: "Text-to-Speech", fallback: "openai/tts-1" },
                      { type: "video", label: "Video Generation", fallback: "google/veo-3.1-fast-generate-preview" },
                      { type: "audio_stt", label: "Speech-to-Text", fallback: "openai/whisper-1" },
                    ]
                    return (
                      <div class="flex flex-col gap-4">
                        <p class="text-11-regular text-text-weaker">
                          Set default models for media generation tools. Agent will use these when no model is specified.
                        </p>
                        <For each={sections}>
                          {(section) => {
                            const available = () => models()[section.type] ?? []
                            const current = () => mediaDefaults()[section.type] || section.fallback
                            return (
                              <Show when={available().length > 0}>
                                <div class="flex flex-col gap-1">
                                  <h3 class="text-13-medium text-text">{section.label}</h3>
                                  <div class="flex flex-col gap-0.5">
                                    <For each={available()}>
                                      {(m) => {
                                        const active = () => current() === m.id
                                        return (
                                          <button
                                            class={`flex items-center justify-between py-1.5 px-2 rounded text-left ${active() ? "bg-surface-inset" : "hover:bg-surface-inset/50"}`}
                                            onClick={() => updateMediaDefault(section.type, m.id)}
                                          >
                                            <div class="flex items-center gap-2 text-13-regular">
                                              <span class="text-text">{m.id}</span>
                                              <Show when={active()}>
                                                <span class="text-10-regular text-fill-positive font-medium px-1 py-0.5 rounded bg-surface-positive/10">
                                                  default
                                                </span>
                                              </Show>
                                            </div>
                                            <span class="text-11-regular text-text-weaker">{m.owned_by}</span>
                                          </button>
                                        )
                                      }}
                                    </For>
                                  </div>
                                </div>
                              </Show>
                            )
                          }}
                        </For>
                      </div>
                    )
                  }}
                </Show>
              </Show>
            </>
          )}
        </Show>

        <Show when={dashboard.error}>
          <p class="text-fill-negative">Failed to load dashboard data</p>
        </Show>
      </div>
    </Dialog>
  )
}
