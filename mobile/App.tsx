import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { adoptSessionToken, loadToken, setSignedOutHandler } from "./src/api";
import { usePoll } from "./src/hooks";
import { enablePush, onNotificationTap } from "./src/push";
import { AccountScreen } from "./src/screens/Account";
import { ActivityScreen, AgentsScreen } from "./src/screens/Agents";
import { ApprovalsScreen } from "./src/screens/Approvals";
import { PortfolioScreen } from "./src/screens/Portfolio";
import { SignInScreen } from "./src/screens/SignIn";
import { colors } from "./src/ui";

type Tab = "approvals" | "agents" | "portfolio" | "activity" | "account";

const TABS: Array<{ id: Tab; label: string; glyph: string }> = [
  { id: "approvals", label: "Approvals", glyph: "✓" },
  { id: "agents", label: "Agents", glyph: "◎" },
  { id: "portfolio", label: "Portfolio", glyph: "◔" },
  { id: "activity", label: "Activity", glyph: "≡" },
  { id: "account", label: "Account", glyph: "◯" },
];

const TITLES: Record<Tab, string> = {
  approvals: "Approvals",
  agents: "Agents",
  portfolio: "Portfolio",
  activity: "Activity",
  account: "Account",
};

function PendingBadge() {
  const { data } = usePoll<unknown[]>("approvals.listPending", 6000);
  const n = data?.length ?? 0;
  if (!n) return null;
  return (
    <View
      style={{
        position: "absolute",
        top: -2,
        right: -12,
        minWidth: 18,
        height: 18,
        borderRadius: 9,
        backgroundColor: colors.danger,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: 4,
      }}
    >
      <Text style={{ color: "white", fontSize: 11, fontWeight: "700" }}>{n}</Text>
    </View>
  );
}

// Screenshot runs only (see README): start on a given tab. Unset in every build.
const START_TAB = (process.env.EXPO_PUBLIC_SCREENSHOT_TAB as Tab | undefined) ?? "approvals";

function Main({ onSignedOut }: { onSignedOut: () => void }) {
  const [tab, setTab] = useState<Tab>(START_TAB);

  useEffect(() => {
    // Ask for notification permission once signed in; a tap on an order alert opens Approvals.
    enablePush().catch(() => {});
    return onNotificationTap((data) => {
      if (data.type === "approval") setTab("approvals");
    });
  }, []);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["top"]}>
      <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 }}>
        <Text style={{ color: colors.text, fontSize: 28, fontWeight: "700" }}>{TITLES[tab]}</Text>
      </View>
      <View style={{ flex: 1 }}>
        {tab === "approvals" && <ApprovalsScreen />}
        {tab === "agents" && <AgentsScreen />}
        {tab === "portfolio" && <PortfolioScreen />}
        {tab === "activity" && <ActivityScreen />}
        {tab === "account" && <AccountScreen onSignedOut={onSignedOut} />}
      </View>
      <SafeAreaView edges={["bottom"]} style={{ backgroundColor: colors.panel, borderTopWidth: 1, borderTopColor: colors.line }}>
        <View style={{ flexDirection: "row" }}>
          {TABS.map((t) => {
            const active = t.id === tab;
            return (
              <Pressable
                key={t.id}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={t.label}
                onPress={() => setTab(t.id)}
                style={{ flex: 1, alignItems: "center", paddingVertical: 8, gap: 2 }}
              >
                <View>
                  <Text style={{ color: active ? colors.accent : colors.muted, fontSize: 18 }}>{t.glyph}</Text>
                  {t.id === "approvals" && <PendingBadge />}
                </View>
                <Text style={{ color: active ? colors.text : colors.muted, fontSize: 11 }}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </SafeAreaView>
    </SafeAreaView>
  );
}

export default function App() {
  const [state, setState] = useState<"loading" | "signedOut" | "signedIn">("loading");

  useEffect(() => {
    setSignedOutHandler(() => setState("signedOut"));
    loadToken().then(async (t) => {
      // Screenshot runs only: sign in with a session token from the environment.
      const preset = process.env.EXPO_PUBLIC_SCREENSHOT_SESSION;
      if (!t && preset) {
        await adoptSessionToken(preset);
        t = preset;
      }
      setState(t ? "signedIn" : "signedOut");
    });
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {state === "loading" && (
        <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={colors.muted} />
        </View>
      )}
      {state === "signedOut" && <SignInScreen onSignedIn={() => setState("signedIn")} />}
      {state === "signedIn" && <Main onSignedOut={() => setState("signedOut")} />}
    </SafeAreaProvider>
  );
}
