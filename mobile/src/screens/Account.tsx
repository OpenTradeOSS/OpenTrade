import { useCallback, useEffect, useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { deleteAccount, type Me, me, signOut } from "../api";
import { enablePush } from "../push";
import { Button, Card, colors, Muted } from "../ui";

/**
 * Account: plan, credits and usage are shown read-only. Plans and credits are bought on
 * the web (the app sells nothing). Account deletion is here, as the App Store requires.
 */
export function AccountScreen({ onSignedOut }: { onSignedOut: () => void }) {
  const [data, setData] = useState<Me | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pushState, setPushState] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setData(await me());
    } catch {}
    setRefreshing(false);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const plan = data?.plans.find((p) => p.id === data.user.plan);

  const confirmDelete = () =>
    Alert.alert(
      "Delete your account?",
      "This stops your agents, deletes your cloud workspace and all its data, and cancels any subscription. It can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteAccount();
              onSignedOut();
            } catch (err) {
              Alert.alert("Couldn't delete the account", err instanceof Error ? err.message : "Try again.");
            }
          },
        },
      ],
    );

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.muted} />}
    >
      <Card>
        <Muted>Signed in as</Muted>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>{data?.user.email ?? "…"}</Text>
      </Card>
      <Card>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <View>
            <Muted>Plan</Muted>
            <Text style={{ color: colors.text, fontSize: 18, fontWeight: "600" }}>{plan?.name ?? "—"}</Text>
            <Muted>Up to {data?.limits.maxAgents ?? "—"} agents</Muted>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Muted>Credits</Muted>
            <Text style={{ color: colors.text, fontSize: 24, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
              {data ? Math.floor(data.credits).toLocaleString() : "—"}
            </Text>
          </View>
        </View>
      </Card>
      <Card>
        <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600", marginBottom: 4 }}>Notifications</Text>
        <Muted>Get a notification when an agent's order needs your approval.</Muted>
        <Button
          label={pushState === "granted" ? "Notifications on" : "Turn on notifications"}
          onPress={async () => setPushState(await enablePush().catch(() => "unavailable"))}
          style={{ marginTop: 12 }}
        />
        {pushState === "denied" && (
          <Muted style={{ marginTop: 8 }}>Notifications are off for OpenTrade in iOS Settings.</Muted>
        )}
      </Card>
      {data && data.usage.length > 0 && (
        <Card>
          <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600", marginBottom: 8 }}>Usage, last 30 days</Text>
          {data.usage.map((u) => (
            <View key={`${u.agentId}-${u.model}`} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 }}>
              <Muted>{u.agentName ?? u.agentId ?? "—"}</Muted>
              <Text style={{ color: colors.text }}>{u.byok ? "your key" : `${Math.ceil(u.credits)} credits`}</Text>
            </View>
          ))}
        </Card>
      )}
      <Button
        label="Sign out"
        onPress={async () => {
          await signOut();
          onSignedOut();
        }}
        style={{ marginBottom: 12 }}
      />
      <Button label="Delete account" kind="danger" onPress={confirmDelete} />
    </ScrollView>
  );
}
