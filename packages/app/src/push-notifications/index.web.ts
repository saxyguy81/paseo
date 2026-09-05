import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./internal/types";
import {
  clearSelectedWebPushNotificationHost,
  isWebPushNotificationHostSelected,
  renewWebPushNotifications,
} from "./web-subscription.web";

export function startPushNotifications(input: StartPushNotificationsInput): () => void {
  let stopped = false;
  const renew = () => {
    if (
      stopped ||
      !input.client.isConnected ||
      !isWebPushNotificationHostSelected(input.serverId)
    ) {
      return;
    }
    void renewWebPushNotifications(input.client).catch(() => {
      // Browser/daemon errors can contain a subscription endpoint. Keep those
      // details out of the console and let Settings offer a user-safe retry.
      console.warn("[PushNotifications] Failed to renew Web Push subscription");
    });
  };

  renew();
  const unsubscribe = input.client.subscribeConnectionStatus((state) => {
    if (state.status === "connected") renew();
  });

  return () => {
    stopped = true;
    unsubscribe();
  };
}

export async function revokePushNotifications(input: RevokePushNotificationsInput): Promise<void> {
  if (input.client?.isConnected) {
    const { disableWebPushNotifications } = await import("./web-subscription.web");
    await disableWebPushNotifications(input.client).catch(() => {
      console.warn("[PushNotifications] Failed to remove Web Push subscription");
    });
  }
  clearSelectedWebPushNotificationHost(input.serverId);
}
