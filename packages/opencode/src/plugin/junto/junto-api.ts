import { Log } from "../../util/log"

const log = Log.create({ service: "junto.api" })

const JUNTO_API_BASE = "https://us-central1-ms-junto.cloudfunctions.net/juntoRouter/api/v1"

export namespace JuntoApi {
  export type Profile = {
    uid: string
    email: string
    photoURL?: string | null
    tier: string
    limits: {
      rpm: number | null
      tpm: number | null
      rpd: number | null
    }
  }

  export type Credits = {
    balancePoints: number
    balanceMp: number
    balanceTwd: number
  }

  export type DailyUsage = {
    date: string
    totalRequests: number
    totalTokens: number
    totalCostUsd: number
    byModel: Array<{
      model: string
      requests: number
      tokens: number
      cost: number
    }>
  }

  export type TeamMembership = {
    team: {
      id: string
      name: string
      ownerId: string
      totalPoolMp: number
      sharePoolMp: number
      allocatedMp: number
    } | null
    membership: {
      role: string
      allocationMp: number
      usedMp: number
    }
  }

  export type Dashboard = {
    profile?: Profile
    credits?: Credits
    usage?: DailyUsage
    teams?: TeamMembership[]
  }

  function headers(apiKey: string): Record<string, string> {
    return {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    }
  }

  async function fetchJson<T>(url: string, apiKey: string): Promise<T | undefined> {
    try {
      const res = await fetch(url, { headers: headers(apiKey) })
      if (!res.ok) {
        log.warn("Junto API error", { url, status: res.status })
        return undefined
      }
      return (await res.json()) as T
    } catch (err) {
      log.warn("Junto API fetch failed", { url, error: err })
      return undefined
    }
  }

  export async function getProfile(apiKey: string): Promise<Profile | undefined> {
    return fetchJson<Profile>(`${JUNTO_API_BASE}/me/profile`, apiKey)
  }

  export async function getCredits(apiKey: string): Promise<Credits | undefined> {
    return fetchJson<Credits>(`${JUNTO_API_BASE}/me/credits`, apiKey)
  }

  export async function getDailyUsage(apiKey: string, date?: string): Promise<DailyUsage | undefined> {
    const d = date ?? new Date().toISOString().split("T")[0]
    return fetchJson<DailyUsage>(`${JUNTO_API_BASE}/me/usage/daily?date=${d}`, apiKey)
  }

  export async function getTeams(apiKey: string): Promise<TeamMembership[] | undefined> {
    const data = await fetchJson<{ teams: TeamMembership[] }>(`${JUNTO_API_BASE}/me/team`, apiKey)
    return data?.teams
  }

  export async function getDashboard(apiKey: string): Promise<Dashboard> {
    const [profile, credits, usage, teams] = await Promise.all([
      getProfile(apiKey),
      getCredits(apiKey),
      getDailyUsage(apiKey),
      getTeams(apiKey),
    ])
    return { profile, credits, usage, teams }
  }

  // ── Media Models ──

  export type MediaModel = {
    id: string
    owned_by: string
    pricing?: Record<string, unknown>
  }

  export type MediaType = "image" | "audio_tts" | "audio_stt" | "video"

  const MEDIA_MODEL_PATTERNS: Record<MediaType, RegExp[]> = {
    image: [/dall-e/i, /gpt-image/i, /flux/i, /gemini.*image/i, /stable-diffusion/i],
    audio_tts: [/tts/i, /gemini.*tts/i],
    audio_stt: [/whisper/i],
    video: [/veo/i],
  }

  export function classifyMediaModel(modelId: string): MediaType | undefined {
    for (const [type, patterns] of Object.entries(MEDIA_MODEL_PATTERNS) as [MediaType, RegExp[]][]) {
      if (patterns.some((p) => p.test(modelId))) return type
    }
    return undefined
  }

  export async function getMediaModels(): Promise<Record<MediaType, MediaModel[]>> {
    const result: Record<MediaType, MediaModel[]> = { image: [], audio_tts: [], audio_stt: [], video: [] }
    try {
      const res = await fetch(`${JUNTO_API_BASE}/models`)
      if (!res.ok) return result
      const data = (await res.json()) as { data: Array<{ id: string; owned_by: string; pricing?: Record<string, unknown> }> }
      for (const m of data.data ?? []) {
        const type = classifyMediaModel(m.id)
        if (type) {
          result[type].push({ id: m.id, owned_by: m.owned_by, pricing: m.pricing })
        }
      }
    } catch (err) {
      log.warn("Failed to fetch media models", { error: err })
    }
    return result
  }

  // ── Media Default Config ──

  export type MediaDefaults = {
    image?: string
    audio_tts?: string
    audio_stt?: string
    video?: string
  }
}
