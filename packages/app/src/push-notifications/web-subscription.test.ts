import { describe, expect, it, vi } from "vitest";
import {
  createWebPushController,
  type WebPushBrowser,
  type WebPushClient,
} from "./web-subscription-controller";

const subscription = {
  endpoint: "https://push.example/subscription",
  expirationTime: null,
  keys: { p256dh: "public", auth: "auth" },
};

function browser(overrides: Partial<WebPushBrowser> = {}): WebPushBrowser {
  return {
    isSupported: () => true,
    getPermission: () => "default",
    requestPermission: vi.fn(async () => "granted" as NotificationPermission),
    registerServiceWorker: vi.fn(async () => ({
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(async () => subscription),
      unsubscribe: vi.fn(async () => true),
    })),
    ...overrides,
  };
}

function client(vapidPublicKey = "vapid-public-key", authorityKey = "test-daemon"): WebPushClient {
  return {
    isConnected: true,
    getWebPushAuthorityKey: () => authorityKey,
    getWebPushVapidPublicKey: () => vapidPublicKey,
    subscribeWebPush: vi.fn(async () => "opaque-revocation-token"),
    unsubscribeWebPush: vi.fn(async () => undefined),
  };
}

describe("Web Push subscription", () => {
  it("never requests permission while checking initial state", async () => {
    const webPushBrowser = browser();
    const controller = createWebPushController(webPushBrowser);

    await expect(controller.getState()).resolves.toMatchObject({ status: "prompt" });

    expect(webPushBrowser.requestPermission).not.toHaveBeenCalled();
    expect(webPushBrowser.registerServiceWorker).not.toHaveBeenCalled();
  });

  it("requests permission only from enable and registers the subscription", async () => {
    const webPushBrowser = browser();
    const webPushClient = client();
    const controller = createWebPushController(webPushBrowser);

    await expect(controller.enable(webPushClient)).resolves.toMatchObject({ status: "enabled" });

    expect(webPushBrowser.requestPermission).toHaveBeenCalledOnce();
    expect(webPushClient.subscribeWebPush).toHaveBeenCalledWith(subscription, undefined);
  });

  it("renews an existing granted subscription without prompting", async () => {
    const getSubscription = vi.fn().mockResolvedValue(subscription);
    const subscribe = vi.fn().mockResolvedValue(subscription);
    const webPushBrowser = browser({
      getPermission: () => "granted",
      registerServiceWorker: vi.fn().mockResolvedValue({
        getSubscription,
        subscribe,
        unsubscribe: vi.fn().mockResolvedValue(true),
      }),
    });
    const webPushClient = client();
    const controller = createWebPushController(webPushBrowser);

    await controller.renew(webPushClient);

    expect(webPushBrowser.requestPermission).not.toHaveBeenCalled();
    expect(webPushClient.subscribeWebPush).toHaveBeenCalledWith(subscription, undefined);
  });

  it("reports granted permission without a subscription as disabled", async () => {
    const webPushBrowser = browser({
      getPermission: () => "granted",
      registerServiceWorker: vi.fn().mockResolvedValue({
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: vi.fn().mockResolvedValue(subscription),
        unsubscribe: vi.fn().mockResolvedValue(false),
      }),
    });

    await expect(createWebPushController(webPushBrowser).getState(client())).resolves.toEqual({
      status: "disabled",
    });
    expect(webPushBrowser.requestPermission).not.toHaveBeenCalled();
  });

  it("removes the browser subscription after daemon leases are revoked", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const webPushBrowser = browser({
      getPermission: () => "granted",
      registerServiceWorker: vi.fn().mockResolvedValue({
        getSubscription: vi.fn().mockResolvedValue(subscription),
        subscribe: vi.fn().mockResolvedValue(subscription),
        unsubscribe,
      }),
    });
    const controller = createWebPushController(webPushBrowser);
    const webPushClient = client();

    await controller.disable(webPushClient);
    await controller.unsubscribeBrowser();

    expect(webPushClient.unsubscribeWebPush).toHaveBeenCalledWith(
      subscription.endpoint,
      "opaque-revocation-token",
    );
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("does not touch browser APIs when a host does not advertise Web Push", async () => {
    const webPushBrowser = browser();
    const controller = createWebPushController(webPushBrowser);

    await expect(controller.enable(client(""))).resolves.toMatchObject({ status: "unavailable" });

    expect(webPushBrowser.requestPermission).not.toHaveBeenCalled();
    expect(webPushBrowser.registerServiceWorker).not.toHaveBeenCalled();
  });

  it("keeps a returned revocation token in memory for renew and never asks browser storage to hold it", async () => {
    const getSubscription = vi.fn().mockResolvedValue(subscription);
    const webPushBrowser = browser({
      getPermission: () => "granted",
      registerServiceWorker: vi.fn().mockResolvedValue({
        getSubscription,
        subscribe: vi.fn().mockResolvedValue(subscription),
        unsubscribe: vi.fn().mockResolvedValue(true),
      }),
    });
    const webPushClient = client();
    const controller = createWebPushController(webPushBrowser);

    await controller.renew(webPushClient);
    await controller.renew(webPushClient);

    expect(webPushClient.subscribeWebPush).toHaveBeenNthCalledWith(1, subscription, undefined);
    expect(webPushClient.subscribeWebPush).toHaveBeenNthCalledWith(
      2,
      subscription,
      "opaque-revocation-token",
    );
  });

  it("recovers revocation authority from the current browser subscription after a reload", async () => {
    const webPushBrowser = browser({
      getPermission: () => "granted",
      registerServiceWorker: vi.fn().mockResolvedValue({
        getSubscription: vi.fn().mockResolvedValue(subscription),
        subscribe: vi.fn().mockResolvedValue(subscription),
        unsubscribe: vi.fn().mockResolvedValue(true),
      }),
    });
    const freshController = createWebPushController(webPushBrowser);
    const webPushClient = client();

    await freshController.disable(webPushClient);

    expect(webPushClient.subscribeWebPush).toHaveBeenCalledWith(subscription);
    expect(webPushClient.unsubscribeWebPush).toHaveBeenCalledWith(
      subscription.endpoint,
      "opaque-revocation-token",
    );
  });

  it("revokes the previously selected daemon before registering the origin subscription to another host", async () => {
    const webPushBrowser = browser({
      getPermission: () => "granted",
      registerServiceWorker: vi.fn().mockResolvedValue({
        getSubscription: vi.fn().mockResolvedValue(subscription),
        subscribe: vi.fn().mockResolvedValue(subscription),
        unsubscribe: vi.fn().mockResolvedValue(true),
      }),
    });
    const controller = createWebPushController(webPushBrowser);
    const first = client("first-vapid", "first-host");
    const second = client("second-vapid", "second-host");

    await controller.renew(first);
    await controller.renew(second);

    expect(first.unsubscribeWebPush).toHaveBeenCalledWith(
      subscription.endpoint,
      "opaque-revocation-token",
    );
    expect(second.subscribeWebPush).toHaveBeenCalledWith(subscription, undefined);
  });

  it("keeps independent tabs authorized for one shared browser subscription", async () => {
    const webPushBrowser = browser({
      getPermission: () => "granted",
      registerServiceWorker: vi.fn().mockResolvedValue({
        getSubscription: vi.fn().mockResolvedValue(subscription),
        subscribe: vi.fn().mockResolvedValue(subscription),
        unsubscribe: vi.fn().mockResolvedValue(true),
      }),
    });
    const authorities = new Set<string>();
    let nextToken = 0;
    let exists = false;
    const tabClient = (): WebPushClient => ({
      isConnected: true,
      getWebPushAuthorityKey: () => "shared-host",
      getWebPushVapidPublicKey: () => "vapid-public-key",
      async subscribeWebPush(_subscription, revocationToken) {
        if (!exists) {
          if (revocationToken) throw new Error("stale authority");
          exists = true;
        } else if (revocationToken && !authorities.has(revocationToken)) {
          throw new Error("invalid authority");
        }
        if (revocationToken) return revocationToken;
        const token = `tab-${++nextToken}`;
        authorities.add(token);
        return token;
      },
      async unsubscribeWebPush(_endpoint, revocationToken) {
        if (!authorities.has(revocationToken)) throw new Error("invalid authority");
        exists = false;
        authorities.clear();
      },
    });
    const firstController = createWebPushController(webPushBrowser);
    const secondController = createWebPushController(webPushBrowser);
    const firstClient = tabClient();
    const secondClient = tabClient();

    await firstController.renew(firstClient);
    await secondController.renew(secondClient);

    await expect(firstController.renew(firstClient)).resolves.toBeUndefined();
    await expect(secondController.renew(secondClient)).resolves.toBeUndefined();
  });
});
