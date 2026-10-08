import { RefreshControl, ScrollView, Text, View } from "react-native";
import type { Portfolio, Position } from "../api";
import { usePoll } from "../hooks";
import { Card, colors, Empty, Muted, money } from "../ui";

type Cached<T> = { value: T; fetchedAt: number } | null;

export function PortfolioScreen() {
  const portfolio = usePoll<Cached<Portfolio>>("broker.portfolio", 15000);
  const positions = usePoll<Cached<Position[]>>("broker.positions", 15000);
  const p = portfolio.data?.value;
  const rows = positions.data?.value ?? [];
  const refreshing = portfolio.refreshing || positions.refreshing;
  const refresh = () => {
    portfolio.refresh();
    positions.refresh();
  };

  return (
    <ScrollView
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.muted} />}
    >
      {!p ? (
        <Empty
          title="No broker connected"
          body="Connect Robinhood from OpenTrade on a computer to see your portfolio here."
        />
      ) : (
        <>
          <Card>
            <Muted>Account value</Muted>
            <Text style={{ color: colors.text, fontSize: 32, fontWeight: "700", fontVariant: ["tabular-nums"] }}>
              {money(p.equity)}
            </Text>
            {p.dayChange != null && (
              <Text style={{ color: p.dayChange >= 0 ? colors.accent : colors.danger, fontVariant: ["tabular-nums"] }}>
                {p.dayChange >= 0 ? "+" : ""}
                {money(p.dayChange)}
                {p.dayChangePct != null ? ` (${(p.dayChangePct * 100).toFixed(2)}%)` : ""} today
              </Text>
            )}
            <View style={{ flexDirection: "row", gap: 24, marginTop: 12 }}>
              <View>
                <Muted>Buying power</Muted>
                <Text style={{ color: colors.text }}>{money(p.buyingPower)}</Text>
              </View>
              <View>
                <Muted>Cash</Muted>
                <Text style={{ color: colors.text }}>{money(p.cash)}</Text>
              </View>
            </View>
          </Card>
          {rows.map((r) => (
            <View
              key={r.symbol}
              style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.line }}
            >
              <View>
                <Text style={{ color: colors.text, fontWeight: "600" }}>{r.symbol}</Text>
                <Muted>{r.quantity} shares</Muted>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <Text style={{ color: colors.text, fontVariant: ["tabular-nums"] }}>{money(r.marketValue)}</Text>
                {r.unrealizedPnl != null && (
                  <Text style={{ color: r.unrealizedPnl >= 0 ? colors.accent : colors.danger, fontVariant: ["tabular-nums"] }}>
                    {r.unrealizedPnl >= 0 ? "+" : ""}
                    {money(r.unrealizedPnl)}
                  </Text>
                )}
              </View>
            </View>
          ))}
        </>
      )}
    </ScrollView>
  );
}
