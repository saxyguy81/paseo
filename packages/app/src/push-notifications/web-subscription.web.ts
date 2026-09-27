import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  createWebPushController,
  type WebPushBrowser,
  type WebPushClient,
  type WebPushState,
  type WebPushSubscriptionRecord,
} from "./web-subscription-controller";

interface BrowserPushSubscription extends PushSubscription {
  toJSON(): {
    endpoint?: string;
    expirationTime?: number | null;
    keys?: { p256dh?: string; auth?: string };
  };
}

function toSubscriptionRecord(subscription: BrowserPushSubscription): WebPushSubscriptionRecord {
  const value = subscription.toJSON();
  if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth) {
    throw new Error("The browser returned an incomplete Push subscription");
  }
  return {
    endpoint: value.endpoint,
    expirationTime: value.expirationTime ?? null,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
  };
}

function decodeBase64Url(value: string): ArrayBuffer {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = globalThis.atob(padded);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encodeBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const browser: WebPushBrowser = {
  isSupported: () =>
    "Notification" in globalThis &&
    "navigator" in globalThis &&
    "serviceWorker" in navigator &&
    "PushManager" in globalThis,
  getPermission: () => Notification.permission,
  requestPermission: () => Notification.requestPermission(),
  async registerServiceWorker() {
    const registration = await navigator.serviceWorker.register("/paseo-push-sw.js", {
      scope: "/",
    });
    await navigator.serviceWorker.ready;
    return {
      async getSubscription() {
        const subscription = await registration.pushManager.getSubscription();
        return subscription ? toSubscriptionRecord(subscription as BrowserPushSubscription) : null;
      },
      async subscribe(vapidPublicKey: string) {
        const current = await registration.pushManager.getSubscription();
        const currentKey = current?.options.applicationServerKey;
        if (current && (!currentKey || encodeBase64Url(currentKey) === vapidPublicKey)) {
          return toSubscriptionRecord(current as BrowserPushSubscription);
        }
        if (current) await current.unsubscribe();
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeBase64Url(vapidPublicKey),
        });
        return toSubscriptionRecord(subscription as BrowserPushSubscription);
      },
      async unsubscribe() {
        const subscription = await registration.pushManager.getSubscription();
        return subscription ? subscription.unsubscribe() : false;
      },
    };
  },
};

const controller = createWebPushController(browser);
const SELECTED_WEB_PUSH_HOST_KEY = "@paseo:web-push-selected-host";

function readSelectedWebPushHost(): string | null {
  try {
    return globalThis.localStorage?.getItem(SELECTED_WEB_PUSH_HOST_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

function writeSelectedWebPushHost(serverId: string | null): void {
  try {
    if (serverId) globalThis.localStorage?.setItem(SELECTED_WEB_PUSH_HOST_KEY, serverId);
    else globalThis.localStorage?.removeItem(SELECTED_WEB_PUSH_HOST_KEY);
  } catch {
    // Selection is non-secret preference state. If browser storage is blocked,
    // this page can still enable notifications until its next reload.
  }
}

function daemonId(client: DaemonClient): string | null {
  return client.getLastServerInfoMessage()?.serverId?.trim() || null;
}

export function isWebPushNotificationHostSelected(serverId: string): boolean {
  return readSelectedWebPushHost() === serverId;
}

function asWebPushClient(client: DaemonClient): WebPushClient {
  return {
    get isConnected() {
      return client.isConnected;
    },
    getWebPushVapidPublicKey() {
      return (
        client.getLastServerInfoMessage()?.features?.webPushNotifications?.vapidPublicKey ?? null
      );
    },
    getWebPushAuthorityKey() {
      return client.getLastServerInfoMessage()?.serverId ?? null;
    },
    async subscribeWebPush(subscription, revocationToken) {
      return client.subscribeWebPush(subscription, revocationToken);
    },
    async unsubscribeWebPush(endpoint, revocationToken) {
      await client.unsubscribeWebPush(endpoint, revocationToken);
    },
  };
}

export function getWebPushNotificationState(client: DaemonClient): Promise<WebPushState> {
  const selected = readSelectedWebPushHost();
  const target = daemonId(client);
  if (selected && target && selected !== target) {
    return Promise.resolve({ status: "selectedElsewhere" });
  }
  return controller.getState(asWebPushClient(client));
}

export async function enableWebPushNotifications(client: DaemonClient): Promise<WebPushState> {
  const selected = readSelectedWebPushHost();
  const target = daemonId(client);
  if (!target) return { status: "unavailable" };
  if (selected && selected !== target && controller.getActiveAuthorityKey() !== selected) {
    return { status: "selectedElsewhere" };
  }
  const state = await controller.enable(asWebPushClient(client));
  if (state.status === "enabled") writeSelectedWebPushHost(target);
  return state;
}

export function renewWebPushNotifications(client: DaemonClient): Promise<void> {
  return controller.renew(asWebPushClient(client));
}

export function disableWebPushNotifications(client: DaemonClient): Promise<void> {
  const target = daemonId(client);
  if (!target || readSelectedWebPushHost() !== target) return Promise.resolve();
  return controller.disable(asWebPushClient(client)).then(() => writeSelectedWebPushHost(null));
}

export function clearSelectedWebPushNotificationHost(serverId: string): void {
  if (readSelectedWebPushHost() === serverId) writeSelectedWebPushHost(null);
}

export function unsubscribeBrowserWebPush(): Promise<void> {
  return controller.unsubscribeBrowser();
}
