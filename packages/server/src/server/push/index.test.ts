import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import webPush from "web-push";
import { afterEach, describe, expect, test } from "vitest";

import { createPushNotifications } from "./index.js";

function createLogger(): pino.Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  return logger as unknown as pino.Logger;
}

describe("push notifications", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an offline device stops receiving notifications after 48 hours", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const filePath = path.join(home, "push-tokens.json");
    let now = Date.parse("2026-08-10T00:00:00.000Z");
    const deliveries: string[][] = [];
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath,
      now: () => now,
      deliver: async (tokens) => deliveries.push(tokens),
    });

    pushNotifications.renew("ExponentPushToken[offline-device]");
    now += 48 * 60 * 60 * 1000;
    await pushNotifications.send({ title: "Agent finished", body: "Done" });

    expect(deliveries).toEqual([]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      subscriptions: [],
    });
  });

  test("online revocation stops notifications immediately", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const deliveries: string[][] = [];
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath: path.join(home, "push-tokens.json"),
      now: () => Date.parse("2026-08-10T00:00:00.000Z"),
      deliver: async (tokens) => deliveries.push(tokens),
    });

    pushNotifications.renew("ExponentPushToken[online-device]");
    pushNotifications.revoke("ExponentPushToken[online-device]");
    await pushNotifications.send({ title: "Agent finished", body: "Done" });

    expect(deliveries).toEqual([]);
  });

  test("delivers one attention payload through Expo and configured Web Push", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const expoDeliveries: string[][] = [];
    const webDeliveries: Array<{ endpoints: string[]; title: string }> = [];
    const vapidKeys = webPush.generateVAPIDKeys();
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath: path.join(home, "push-tokens.json"),
      now: () => Date.parse("2026-09-05T00:00:00.000Z"),
      deliver: async (tokens) => expoDeliveries.push(tokens),
      webPush: {
        filePath: path.join(home, "web-push-subscriptions.json"),
        vapidPublicKey: vapidKeys.publicKey,
        vapidPrivateKey: vapidKeys.privateKey,
        subject: "mailto:operator@example.test",
        deliver: async (subscriptions, payload) => {
          webDeliveries.push({
            endpoints: subscriptions.map(({ endpoint }) => endpoint),
            title: payload.title,
          });
        },
      },
    });

    pushNotifications.renew("ExponentPushToken[native-device]");
    pushNotifications.renewWeb({
      endpoint: "https://fcm.googleapis.com/wp/web-device",
      expirationTime: null,
      keys: { p256dh: "public-key", auth: "auth-secret" },
    });
    await pushNotifications.send({
      title: "Agent needs attention",
      body: "Open the thread",
    });

    expect(pushNotifications.webPushCapability).toEqual({
      vapidPublicKey: vapidKeys.publicKey,
    });
    expect(expoDeliveries).toEqual([["ExponentPushToken[native-device]"]]);
    expect(webDeliveries).toEqual([
      {
        endpoints: ["https://fcm.googleapis.com/wp/web-device"],
        title: "Agent needs attention",
      },
    ]);
  });

  test("does not advertise or accept Web Push when VAPID is not configured", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);
    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath: path.join(home, "push-tokens.json"),
    });

    expect(pushNotifications.webPushCapability).toBeNull();
    expect(() =>
      pushNotifications.renewWeb({
        endpoint: "https://fcm.googleapis.com/wp/web-device",
        expirationTime: null,
        keys: { p256dh: "public-key", auth: "auth-secret" },
      }),
    ).toThrow("Web Push is not configured");
  });

  test("disables malformed complete VAPID configuration without blocking startup", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-push-notifications-"));
    homes.push(home);

    const pushNotifications = createPushNotifications({
      logger: createLogger(),
      filePath: path.join(home, "push-tokens.json"),
      webPush: {
        filePath: path.join(home, "web-push-subscriptions.json"),
        vapidPublicKey: "not-a-valid-public-key",
        vapidPrivateKey: "not-a-valid-private-key",
        subject: "not-a-valid-subject",
      },
    });

    expect(pushNotifications.webPushCapability).toBeNull();
    expect(() =>
      pushNotifications.renewWeb({
        endpoint: "https://fcm.googleapis.com/wp/web-device",
        expirationTime: null,
        keys: { p256dh: "public-key", auth: "auth-secret" },
      }),
    ).toThrow("Web Push is not configured");
  });
});
