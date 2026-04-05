import { TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { For, Show, createSignal, createResource, createMemo } from "solid-js"
import { JuntoApi } from "@/plugin/junto/junto-api"

export function DialogJunto() {
  const sync = useSync()
  const { theme } = useTheme()
  const dialog = useDialog()

  const juntoProvider = createMemo(() => sync.data.provider.find((p) => p.id === "junto"))
  const apiKey = createMemo(() => juntoProvider()?.key)

  const [dashboard] = createResource(apiKey, async (key) => {
    if (!key) return undefined
    return JuntoApi.getDashboard(key)
  })

  const [activeTab, setActiveTab] = createSignal<"overview" | "usage">("overview")

  const formatPoints = (mp: number) => {
    if (mp >= 1_000_000) return `${(mp / 1_000_000).toFixed(1)}M`
    if (mp >= 1_000) return `${(mp / 1_000).toFixed(1)}K`
    return mp.toString()
  }

  const formatCost = (usd: number) => `$${usd.toFixed(4)}`

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Junto Dashboard
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <Show when={!apiKey()} fallback={null}>
        <text fg={theme.warning}>Not connected — run /connect and select Junto</text>
      </Show>

      <Show when={apiKey()}>
        <Show when={dashboard.loading}>
          <text fg={theme.textMuted}>Loading...</text>
        </Show>

        <Show when={dashboard()}>
          {(data) => (
            <>
              {/* Tab bar */}
              <box flexDirection="row" gap={2}>
                <text
                  fg={activeTab() === "overview" ? theme.primary : theme.textMuted}
                  attributes={activeTab() === "overview" ? TextAttributes.BOLD : 0}
                  onMouseUp={() => setActiveTab("overview")}
                >
                  Overview
                </text>
                <text
                  fg={activeTab() === "usage" ? theme.primary : theme.textMuted}
                  attributes={activeTab() === "usage" ? TextAttributes.BOLD : 0}
                  onMouseUp={() => setActiveTab("usage")}
                >
                  Usage
                </text>
              </box>

              <Show when={activeTab() === "overview"}>
                {/* Profile */}
                <Show when={data().profile}>
                  {(profile) => (
                    <box>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>
                        Profile
                      </text>
                      <box flexDirection="row" gap={1}>
                        <text fg={theme.textMuted}>Email:</text>
                        <text fg={theme.text}>{profile().email || "—"}</text>
                      </box>
                      <box flexDirection="row" gap={1}>
                        <text fg={theme.textMuted}>Tier:</text>
                        <text fg={theme.text}>{profile().tier}</text>
                      </box>
                    </box>
                  )}
                </Show>

                {/* Credits */}
                <Show when={data().credits}>
                  {(credits) => (
                    <box>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>
                        Credits
                      </text>
                      <box flexDirection="row" gap={1}>
                        <text fg={theme.textMuted}>Balance:</text>
                        <text fg={credits().balancePoints > 0 ? theme.success : theme.warning}>
                          {formatPoints(credits().balancePoints)} pts
                        </text>
                        <text fg={theme.textMuted}>
                          (NT${credits().balanceTwd?.toFixed(0) ?? "0"})
                        </text>
                      </box>
                    </box>
                  )}
                </Show>

                {/* Teams */}
                <Show when={data().teams && data().teams!.length > 0}>
                  <box>
                    <text fg={theme.text} attributes={TextAttributes.BOLD}>
                      Teams
                    </text>
                    <For each={data().teams}>
                      {(tm) => (
                        <Show when={tm.team}>
                          {(team) => (
                            <box>
                              <box flexDirection="row" gap={1}>
                                <text flexShrink={0} fg={theme.success}>
                                  •
                                </text>
                                <text fg={theme.text}>
                                  <b>{team().name}</b>
                                  <span style={{ fg: theme.textMuted }}> ({tm.membership.role})</span>
                                </text>
                              </box>
                              <box paddingLeft={3} flexDirection="row" gap={2}>
                                <text fg={theme.textMuted}>
                                  Pool: {formatPoints(team().totalPoolMp)}
                                </text>
                                <text fg={theme.textMuted}>
                                  Allocated: {formatPoints(tm.membership.allocationMp)}
                                </text>
                                <text fg={theme.textMuted}>
                                  Used: {formatPoints(tm.membership.usedMp)}
                                </text>
                              </box>
                            </box>
                          )}
                        </Show>
                      )}
                    </For>
                  </box>
                </Show>
              </Show>

              <Show when={activeTab() === "usage"}>
                {/* Today's Usage */}
                <Show
                  when={data().usage}
                  fallback={<text fg={theme.textMuted}>No usage data</text>}
                >
                  {(usage) => (
                    <box>
                      <text fg={theme.text} attributes={TextAttributes.BOLD}>
                        Today ({usage().date})
                      </text>
                      <box flexDirection="row" gap={2}>
                        <text fg={theme.textMuted}>
                          Requests: <span style={{ fg: theme.text }}>{usage().totalRequests}</span>
                        </text>
                        <text fg={theme.textMuted}>
                          Tokens: <span style={{ fg: theme.text }}>{usage().totalTokens.toLocaleString()}</span>
                        </text>
                        <text fg={theme.textMuted}>
                          Cost: <span style={{ fg: theme.text }}>{formatCost(usage().totalCostUsd)}</span>
                        </text>
                      </box>

                      <Show when={usage().byModel.length > 0}>
                        <box marginTop={1}>
                          <text fg={theme.text} attributes={TextAttributes.BOLD}>
                            By Model
                          </text>
                          <For each={usage().byModel}>
                            {(m) => (
                              <box flexDirection="row" gap={1}>
                                <text flexShrink={0} fg={theme.primary}>
                                  •
                                </text>
                                <text fg={theme.text} wrapMode="word">
                                  <b>{m.model}</b>
                                  <span style={{ fg: theme.textMuted }}>
                                    {" "}
                                    {m.requests} req · {m.tokens.toLocaleString()} tok · {formatCost(m.cost)}
                                  </span>
                                </text>
                              </box>
                            )}
                          </For>
                        </box>
                      </Show>
                    </box>
                  )}
                </Show>
              </Show>
            </>
          )}
        </Show>

        <Show when={dashboard.error}>
          <text fg={theme.error}>Failed to load dashboard data</text>
        </Show>
      </Show>
    </box>
  )
}
