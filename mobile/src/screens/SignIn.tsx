import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { GATEWAY_URL, signIn } from "../api";
import { Button, Card, colors, Muted, styles, Title } from "../ui";

export function SignInScreen({ onSignedIn }: { onSignedIn: () => void }) {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await signIn(mode, email.trim(), password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign in.");
    } finally {
      setBusy(false);
    }
  };

  const signup = mode === "signup";
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 72 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 28 }}>
          <Image source={require("../../assets/icon.png")} style={{ width: 34, height: 34, borderRadius: 8 }} />
          <Text style={{ color: colors.text, fontSize: 20, fontWeight: "700" }}>OpenTrade</Text>
        </View>
        <Card>
          <Title>{signup ? "Create your account" : "Sign in"}</Title>
          <Muted>
            {signup
              ? "Your trading agents in the cloud. Every order waits for your approval."
              : "Approve your agents' orders and keep an eye on them from anywhere."}
          </Muted>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            placeholderTextColor={colors.muted}
            accessibilityLabel="Email"
          />
          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete={signup ? "new-password" : "current-password"}
            textContentType={signup ? "newPassword" : "password"}
            placeholderTextColor={colors.muted}
            accessibilityLabel="Password"
            onSubmitEditing={submit}
          />
          {error && <Text style={{ color: colors.danger, marginTop: 12 }}>{error}</Text>}
          <Button
            label={signup ? "Create account" : "Sign in"}
            kind="primary"
            busy={busy}
            disabled={!email || !password}
            onPress={submit}
            style={{ marginTop: 18 }}
          />
          {signup && (
            <Muted style={{ fontSize: 12, marginTop: 12 }}>
              By creating an account you agree to the{" "}
              <Text style={{ color: colors.accent }} onPress={() => WebBrowser.openBrowserAsync(`${GATEWAY_URL}/terms`)}>
                Terms
              </Text>{" "}
              and{" "}
              <Text style={{ color: colors.accent }} onPress={() => WebBrowser.openBrowserAsync(`${GATEWAY_URL}/privacy`)}>
                Privacy Policy
              </Text>
              . OpenTrade is software, not a broker or adviser.
            </Muted>
          )}
        </Card>
        <Pressable onPress={() => setMode(signup ? "login" : "signup")} style={{ padding: 12 }}>
          <Muted style={{ textAlign: "center" }}>
            {signup ? "Already have an account? " : "New to OpenTrade? "}
            <Text style={{ color: colors.accent }}>{signup ? "Sign in" : "Create an account"}</Text>
          </Muted>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
