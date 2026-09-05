export interface WebPushSubscriptionRecord {
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export interface WebPushRegistration {
  getSubscription(): Promise<WebPushSubscriptionRecord | null>;
  subscribe(vapidPublicKey: string): Promise<WebPushSubscriptionRecord>;
  unsubscribe(): Promise<boolean>;
}

export interface WebPushBrowser {
  isSupported(): boolean;
  getPermission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  registerServiceWorker(): Promise<WebPushRegistration>;
}

export interface WebPushClient {
  readonly isConnected: boolean;
  /** Stable daemon identity used only for this page's in-memory authority cache. */
  getWebPushAuthorityKey(): string | null;
  getWebPushVapidPublicKey(): string | null;
  subscribeWebPush(
    subscription: WebPushSubscriptionRecord,
    revocationToken?: string,
  ): Promise<string>;
  unsubscribeWebPush(endpoint: string, revocationToken: string): Promise<void>;
}

export type WebPushState =
  | { status: "unsupported" }
  | { status: "unavailable" }
  | { status: "selectedElsewhere" }
  | { status: "prompt" }
  | { status: "disabled" }
  | { status: "denied" }
  | { status: "enabled" };

function normalizeVapidPublicKey(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function createWebPushController(browser: WebPushBrowser) {
  // A revocation token is deliberately held only for the life of this web app.
  // On a reload the browser's existing PushSubscription proves possession again
  // to the daemon, which issues a fresh token. Do not put this bearer value in
  // localStorage, IndexedDB, URLs, or logs.
  const authorityByHost = new Map<string, { endpoint: string; token: string }>();
  let activeAuthority: {
    key: string;
    client: WebPushClient;
    endpoint: string;
    token: string;
  } | null = null;

  function authorityKey(client: WebPushClient): string | null {
    const key = client.getWebPushAuthorityKey()?.trim();
    return key || null;
  }

  async function getState(client?: WebPushClient): Promise<WebPushState> {
    if (!browser.isSupported()) return { status: "unsupported" };
    if (client && !normalizeVapidPublicKey(client.getWebPushVapidPublicKey())) {
      return { status: "unavailable" };
    }
    const permission = browser.getPermission();
    if (permission === "denied") return { status: "denied" };
    if (permission !== "granted") return { status: "prompt" };
    const registration = await browser.registerServiceWorker();
    return (await registration.getSubscription()) ? { status: "enabled" } : { status: "disabled" };
  }

  async function subscribe(client: WebPushClient): Promise<WebPushState> {
    const vapidPublicKey = normalizeVapidPublicKey(client.getWebPushVapidPublicKey());
    if (!vapidPublicKey) return { status: "unavailable" };
    const key = authorityKey(client);
    if (activeAuthority && key && activeAuthority.key !== key) {
      // A browser origin has one PushManager subscription. Do not leave the
      // previously selected daemon able to alert through that shared browser
      // subscription while switching Settings to a different host.
      await activeAuthority.client.unsubscribeWebPush(
        activeAuthority.endpoint,
        activeAuthority.token,
      );
      authorityByHost.delete(activeAuthority.key);
      activeAuthority = null;
    }
    const registration = await browser.registerServiceWorker();
    const resolved = await registration.subscribe(vapidPublicKey);
    const existing = key ? authorityByHost.get(key) : undefined;
    const token = await client.subscribeWebPush(
      resolved,
      existing?.endpoint === resolved.endpoint ? existing.token : undefined,
    );
    if (key) {
      authorityByHost.set(key, { endpoint: resolved.endpoint, token });
      activeAuthority = { key, client, endpoint: resolved.endpoint, token };
    }
    return { status: "enabled" };
  }

  return {
    getState,
    getActiveAuthorityKey(): string | null {
      return activeAuthority?.key ?? null;
    },
    async enable(client: WebPushClient): Promise<WebPushState> {
      const state = await getState(client);
      if (
        state.status === "unsupported" ||
        state.status === "unavailable" ||
        state.status === "denied"
      ) {
        return state;
      }
      if (state.status === "prompt" && (await browser.requestPermission()) !== "granted") {
        return getState(client);
      }
      return subscribe(client);
    },
    async renew(client: WebPushClient): Promise<void> {
      if ((await getState(client)).status !== "enabled") return;
      await subscribe(client);
    },
    async disable(client: WebPushClient): Promise<void> {
      if (!browser.isSupported()) return;
      const registration = await browser.registerServiceWorker();
      const current = await registration.getSubscription();
      if (!current) return;

      const key = authorityKey(client);
      const existing = key ? authorityByHost.get(key) : undefined;
      // A reload intentionally leaves no durable bearer token. Re-register the
      // same browser subscription to obtain fresh revocation authority before
      // removing it from the selected daemon.
      const token =
        existing?.endpoint === current.endpoint
          ? existing.token
          : await client.subscribeWebPush(current);
      await client.unsubscribeWebPush(current.endpoint, token);
      if (key) {
        authorityByHost.delete(key);
        if (activeAuthority?.key === key) activeAuthority = null;
      }
    },
    async unsubscribeBrowser(): Promise<void> {
      if (!browser.isSupported()) return;
      const registration = await browser.registerServiceWorker();
      await registration.unsubscribe();
    },
  };
}
