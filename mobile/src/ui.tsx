import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";

/** OpenTrade's dark palette (matches the desktop and web app). */
export const colors = {
  bg: "#05060a",
  panel: "#0d0f16",
  panelHi: "#141826",
  line: "#1c2030",
  text: "#e7e9f0",
  muted: "#8a90a6",
  accent: "#4ade80",
  accentInk: "#04110a",
  danger: "#f87171",
  warn: "#fbbf24",
};

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

export function Button({
  label,
  onPress,
  kind = "default",
  busy,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  kind?: "default" | "primary" | "danger";
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const primary = kind === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        primary && styles.buttonPrimary,
        kind === "danger" && styles.buttonDanger,
        (pressed || disabled) && { opacity: 0.6 },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? colors.accentInk : colors.text} />
      ) : (
        <Text
          style={[
            styles.buttonText,
            primary && { color: colors.accentInk },
            kind === "danger" && { color: colors.danger },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Muted style={{ textAlign: "center" }}>{body}</Muted>
    </View>
  );
}

export const money = (n: number | null | undefined) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: "700", marginBottom: 4 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  text: { color: colors.text, fontSize: 15 },
  button: {
    minHeight: 46,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.panelHi,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  buttonPrimary: { backgroundColor: colors.accent, borderColor: colors.accent },
  buttonDanger: { backgroundColor: "transparent", borderColor: "#f8717155" },
  buttonText: { color: colors.text, fontSize: 16, fontWeight: "600" },
  input: {
    minHeight: 48,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "#07080d",
    color: colors.text,
    paddingHorizontal: 14,
    fontSize: 16,
  },
  label: { color: colors.muted, fontSize: 13, marginTop: 14, marginBottom: 6 },
  empty: { alignItems: "center", paddingVertical: 48, paddingHorizontal: 24, gap: 8 },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
});
