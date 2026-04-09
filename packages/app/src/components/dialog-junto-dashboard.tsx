import { Component, createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useGlobalSDK } from "@/context/global-sdk"
import { useServer } from "@/context/server"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"

const JUNTO_API_BASE = import.meta.env.VITE_JUNTO_API_BASE ?? "https://juntorouter-api.moonshine-studio.net/api/v1"

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

type UsageRecord = {
  date: string
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costUsd: number
}

type TeamMembership = {
  team: { id: string; name: string; ownerId: string; totalPoolMp: number; sharePoolMp: number; allocatedMp: number } | null
  membership: { role: string; allocationMp: number; usedMp: number }
}

type ApiKeyInfo = {
  id: string
  name: string
  keyValue: string
  maskedKey: string
  tier: string
  teamId: string | null
  createdAt: string
}

type Dashboard = {
  profile?: Profile
  credits?: Credits
  usage?: UsageRecord[]
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
  const end = new Date().toISOString().split("T")[0]
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0]
  const [profile, credits, usageData, teamsData, keysData] = await Promise.all([
    fetchJson<Profile>(`${JUNTO_API_BASE}/me/profile`, apiKey),
    fetchJson<Credits>(`${JUNTO_API_BASE}/me/credits`, apiKey),
    fetchJson<{ records: UsageRecord[] }>(`${JUNTO_API_BASE}/me/usage?start=${start}&end=${end}`, apiKey),
    fetchJson<{ teams: TeamMembership[] }>(`${JUNTO_API_BASE}/me/team`, apiKey),
    fetchJson<{ keys: ApiKeyInfo[] }>(`${JUNTO_API_BASE}/me/keys`, apiKey),
  ])
  return { profile, credits, usage: usageData?.records, teams: teamsData?.teams, keys: keysData?.keys }
}

type MediaModel = { id: string; owned_by: string }
type MediaType = "image" | "audio" | "video"

async function fetchModelsByOutput(output: string): Promise<MediaModel[]> {
  try {
    const res = await fetch(`${JUNTO_API_BASE}/models?output=${output}`)
    if (!res.ok) return []
    const data = (await res.json()) as { data: Array<{ id: string; owned_by: string }> }
    return data.data ?? []
  } catch {
    return []
  }
}

async function fetchMediaModels(): Promise<Record<MediaType, MediaModel[]>> {
  const [image, audio, video] = await Promise.all([
    fetchModelsByOutput("image"),
    fetchModelsByOutput("audio"),
    fetchModelsByOutput("video"),
  ])
  return { image, audio, video }
}

type MediaDefaults = { image?: string; audio?: string; video?: string }
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

  // Cache profile to sidecar storage so sidebar can read it
  createEffect(() => {
    const data = dashboard()
    const http = server.current?.http
    if (!data?.profile || !http) return
    // Cache profile to localStorage so sidebar avatar can read it instantly
    localStorage.setItem("junto-profile", JSON.stringify({ email: data.profile.email, photoURL: data.profile.photoURL }))
  })

  const [tab, setTab] = createSignal<Tab>("overview")
  const [busy, setBusy] = createSignal(false)
  const [mediaModels] = createResource(
    () => apiKey(),
    async (key) => {
      const allMedia = await fetchMediaModels()
      if (!key) return allMedia
      // Filter by team allowlist
      try {
        const teamAllowlist = await fetchJson<{ models: string[] }>(`${JUNTO_API_BASE}/me/team/models`, key)
        const allowed = teamAllowlist?.models
        if (allowed && allowed.length > 0) {
          const allowedSet = new Set(allowed)
          for (const type of Object.keys(allMedia) as MediaType[]) {
            allMedia[type] = allMedia[type].filter((m) => allowedSet.has(m.id))
          }
        }
      } catch { /* fallback: show all */ }
      return allMedia
    },
  )
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
    localStorage.removeItem("junto-profile")
    dialog.close()
    showToast({ variant: "success", title: "Disconnected from JuntoRouter" })
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
    <Dialog title="JuntoRouter Dashboard">
      <div class="flex flex-col gap-4 p-4 min-w-[420px] max-h-[70vh] overflow-y-auto">
        {/* Not connected */}
        <Show when={!apiKey.loading && !apiKey()}>
          <div class="flex flex-col gap-3 items-center py-8">
            <p class="text-14-regular text-text-weaker">Connect to JuntoRouter to get started.</p>
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
                <Show
                  when={data().usage && data().usage!.length > 0}
                  fallback={<p class="text-text-weaker">No usage data in the last 30 days</p>}
                >
                  {(() => {
                    const records = () => (data().usage ?? []).toSorted((a, b) => b.date.localeCompare(a.date))
                    const totalRequests = () => records().reduce((s, r) => s + r.requests, 0)
                    const totalTokens = () => records().reduce((s, r) => s + r.totalTokens, 0)
                    const totalCost = () => records().reduce((s, r) => s + r.costUsd, 0)
                    return (
                      <div class="flex flex-col gap-3">
                        {/* Summary */}
                        <div class="flex gap-4 text-13-regular">
                          <div class="flex flex-col items-center gap-0.5 flex-1 py-2 rounded bg-surface-inset">
                            <span class="text-text-weaker text-11-regular">Requests</span>
                            <span class="text-text font-medium">{totalRequests().toLocaleString()}</span>
                          </div>
                          <div class="flex flex-col items-center gap-0.5 flex-1 py-2 rounded bg-surface-inset">
                            <span class="text-text-weaker text-11-regular">Tokens</span>
                            <span class="text-text font-medium">{totalTokens().toLocaleString()}</span>
                          </div>
                          <div class="flex flex-col items-center gap-0.5 flex-1 py-2 rounded bg-surface-inset">
                            <span class="text-text-weaker text-11-regular">Cost</span>
                            <span class="text-text font-medium">${totalCost().toFixed(4)}</span>
                          </div>
                        </div>

                        {/* Daily table */}
                        <div class="flex flex-col gap-0.5">
                          <div class="flex text-11-regular text-text-weaker py-1 border-b border-border">
                            <span class="flex-1">Date</span>
                            <span class="w-16 text-right">Requests</span>
                            <span class="w-20 text-right">Tokens</span>
                            <span class="w-20 text-right">Cost</span>
                          </div>
                          <For each={records()}>
                            {(r) => (
                              <div class="flex text-12-regular py-1">
                                <span class="flex-1 text-text">{r.date}</span>
                                <span class="w-16 text-right text-text-weaker">{r.requests}</span>
                                <span class="w-20 text-right text-text-weaker">{r.totalTokens.toLocaleString()}</span>
                                <span class="w-20 text-right text-text-weaker">${r.costUsd.toFixed(4)}</span>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    )
                  })()}
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
                    <p class="text-11-regular text-text-weaker">Your API keys. Create a new key below to switch billing context.</p>
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
                                  onClick={() => switchToKey(k.keyValue, k.name)}
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
                      { type: "audio", label: "Audio (TTS)", fallback: "openai/tts-1" },
                      { type: "video", label: "Video Generation", fallback: "google/veo-3.1-fast-generate-preview" },
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
