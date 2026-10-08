import { RefreshControl, ScrollView, Text, View } from "react-native";
import type { Agent, AuditEntry } from "../api";
import { usePoll } from "../hooks";
import { Card, colors, Empty, Muted } from "../ui";

const STATUS_COLOR: Record<string, string> = {
  working: colors.accent,
  idle: colors.muted,
  "needs-input": colors.warn,
  "awaiting-approval": colors.warn,
};

const STATUS_LABEL: Record<string, string> = {
  working: "Working",
  idle: "Idle",
  "needs-input": "Needs input",
  "awaiting-approval": "Waiting for your approval",
};

const EXECUTION_LABEL: Record<string, string> = {
  offline: "not running",
  headless: "running in the background",
  interactive: "open in a terminal",
  broken: "stopped, needs attention",
};

export function AgentsScreen() {
  const { data, refreshing, refresh } = usePoll<Agent[]>("agents.list", 8000);
  const agents = data ?? [];
  return (
    <ScrollView
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
    >
      {agents.length === 0 ? (
        <Empty
          title="No agents yet"
          body="Create agents and give them a strategy on opentrade-gateway.fly.dev from a computer. They'll show up here."
        />
      ) : (
        agents.map((a) => (
          <Card key={a.id}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: STATUS_COLOR[a.status] ?? colors.muted }} />
              <Text style={{ color: colors.text, fontSize: 17, fontWeight: "600", flex: 1 }}>{a.name}</Text>
              <Muted>{a.approvalMode === "approve" ? "Asks first" : "Auto"}</Muted>
            </View>
            <Muted style={{ marginTop: 4 }}>
              {a.harness === "codex" ? "Codex" : "Claude Code"} · {STATUS_LABEL[a.status] ?? a.status} ·{" "}
              {EXECUTION_LABEL[a.executionState] ?? a.executionState}
            </Muted>
          </Card>
        ))
      )}
    </ScrollView>
  );
}

const KIND_LABEL: Record<string, string> = {
  order_intent: "Wants to trade",
  approval_decision: "Decision",
  order_observed: "Order placed",
  order_filled: "Order filled",
  session_started: "Session started",
  session_ended: "Session ended",
  broker_connected: "Broker connected",
};

function describe(e: AuditEntry): string {
  const p = (e.payload ?? {}) as Record<string, any>;
  if (e.kind === "approval_decision") {
    const by = p.decidedBy === "timeout" ? " (timed out)" : p.decidedBy === "auto" ? " (auto)" : "";
    return `${String(p.status ?? "decided").replace(/^./, (c: string) => c.toUpperCase())}${by}`;
  }
  return String(p.summary ?? p.parsed?.summary ?? p.symbol ?? p.message ?? "");
}

export function ActivityScreen() {
  const { data, refreshing, refresh } = usePoll<AuditEntry[]>("activity.feed", 10000, { limit: 50 });
  const feed = data ?? [];
  return (
    <ScrollView
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
    >
      {feed.length === 0 ? (
        <Empty title="No activity yet" body="Orders, decisions and fills from your agents will appear here." />
      ) : (
        feed.map((e) => (
          <View key={e.id} style={{ paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ color: colors.text, fontWeight: "600" }}>{KIND_LABEL[e.kind] ?? e.kind}</Text>
              <Muted>{new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</Muted>
            </View>
            <Muted>
              {e.agentName ? `${e.agentName} · ` : ""}
              {describe(e)}
            </Muted>
          </View>
        ))
      )}
    </ScrollView>
  );
}
