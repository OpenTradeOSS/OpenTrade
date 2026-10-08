import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { registerPush } from "./api";

/**
 * Push for orders that need the user. The gateway sends one when an agent's order hits
 * the approval gate; tapping it opens the Approvals tab. Approving always happens in
 * the app (behind Face ID), never from the lock screen.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Ask for permission (once) and register this device with the gateway. */
export async function enablePush(): Promise<"granted" | "denied" | "unavailable"> {
  if (!Device.isDevice) return "unavailable";
  const current = await Notifications.getPermissionsAsync();
  let status = current.status;
  if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return "denied";
  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
  const { data } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  await registerPush(data);
  return "granted";
}

/** Call `fn` when the user taps an OpenTrade notification (including the one that launched the app). */
export function onNotificationTap(fn: (data: Record<string, unknown>) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener((r) =>
    fn((r.notification.request.content.data ?? {}) as Record<string, unknown>),
  );
  const last = Notifications.getLastNotificationResponse();
  if (last) fn((last.notification.request.content.data ?? {}) as Record<string, unknown>);
  return () => sub.remove();
}
