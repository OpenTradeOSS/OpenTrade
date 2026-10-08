import * as Haptics from "expo-haptics";
import * as LocalAuthentication from "expo-local-authentication";
import { useEffect, useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { type Approval, mutate } from "../api";
import { usePoll } from "../hooks";
import { Button, Card, colors, Empty, Muted, money } from "../ui";

/** Seconds left before an approval times out (and the order is refused). */
function useSecondsLeft(a: Approval): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.round((a.requestedAt + a.timeoutSec * 1000 - now) / 1000));
}

async function confirmWithBiometrics(summary: string): Promise<boolean> {
  const has = await LocalAuthentication.hasHardwareAsync();
  const enrolled = has && (await LocalAuthentication.isEnrolledAsync());
  if (!enrolled) return true; // device passcode isn't set up; the in-app tap is the confirmation
  const res = await LocalAuthentication.authenticateAsync({
    promptMessage: `Approve: ${summary}`,
    fallbackLabel: "Use passcode",
  });
  return res.success;
}

function ApprovalCard({ a, onDone }: { a: Approval; onDone: () => void }) {
  const left = useSecondsLeft(a);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const summary = a.parsed?.summary ?? a.toolName;

  const decide = async (approve: boolean) => {
    if (approve && !(await confirmWithBiometrics(summary))) return;
    setBusy(approve ? "approve" : "reject");
    try {
      await mutate("approvals.decide", { id: a.id, approve });
      await Haptics.notificationAsync(
        approve ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning,
      );
      onDone();
    } catch (err) {
      Alert.alert("Couldn't send your decision", err instanceof Error ? err.message : "Try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 6 }}>
        <Muted>{a.agentName ?? "Agent"}</Muted>
        <Text style={{ color: left < 30 ? colors.danger : colors.warn, fontVariant: ["tabular-nums"] }}>
          {left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} left` : "Expiring"}
        </Text>
      </View>
      <Text style={{ color: colors.text, fontSize: 18, fontWeight: "600", marginBottom: 6 }}>{summary}</Text>
      {a.parsed && (
        <View style={{ gap: 2, marginBottom: 14 }}>
          {a.parsed.orderType && <Muted>Type: {a.parsed.orderType}</Muted>}
          {a.parsed.limitPrice != null && <Muted>Limit: {money(a.parsed.limitPrice)}</Muted>}
          {a.parsed.estCost != null && <Muted>Estimated cost: {money(a.parsed.estCost)}</Muted>}
        </View>
      )}
      <View style={{ flexDirection: "row", gap: 10 }}>
        <Button label="Reject" kind="danger" busy={busy === "reject"} onPress={() => decide(false)} style={{ flex: 1 }} />
        <Button label="Approve" kind="primary" busy={busy === "approve"} onPress={() => decide(true)} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

export function ApprovalsScreen() {
  const { data, refreshing, refresh } = usePoll<Approval[]>("approvals.listPending", 4000);
  const pending = data ?? [];
  return (
    <ScrollView
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
    >
      {pending.length === 0 ? (
        <Empty
          title="Nothing to approve"
          body="When an agent wants to place an order, it waits here for you. You'll get a notification."
        />
      ) : (
        pending.map((a) => <ApprovalCard key={a.id} a={a} onDone={refresh} />)
      )}
    </ScrollView>
  );
}
