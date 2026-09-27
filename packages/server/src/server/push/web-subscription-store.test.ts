import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";

import { WebPushSubscriptionStore } from "./web-subscription-store.js";

const LEASE_MS = 48 * 60 * 60 * 1000;
const subscription = {
  endpoint: "https://fcm.googleapis.com/wp/device-1",
  expirationTime: null,
  keys: { p256dh: "public-key", auth: "auth-secret" },
};

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

describe("WebPushSubscriptionStore", () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("keeps expired authority so an offline browser can renew after the lease", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-web-push-store-"));
    homes.push(home);
    const filePath = path.join(home, "web-push-subscriptions.json");
    let now = Date.parse("2026-09-05T00:00:00.000Z");
    const store = new WebPushSubscriptionStore(createLogger(), filePath, () => now, LEASE_MS);

    const revocationToken = store.renew(subscription);

    expect(store.getActive()).toEqual([subscription]);
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toEqual({
      subscriptions: [
        {
          subscription,
          expiresAt: "2026-09-07T00:00:00.000Z",
          revocationTokenHashes: [expect.stringMatching(/^[a-f0-9]{64}$/)],
        },
      ],
    });

    now += LEASE_MS;
    expect(store.getActive()).toEqual([]);
    expect(JSON.parse(readFileSync(filePath, "utf8")).subscriptions).toHaveLength(1);

    const reloaded = new WebPushSubscriptionStore(createLogger(), filePath, () => now, LEASE_MS);
    expect(reloaded.renew(subscription, revocationToken)).toBe(revocationToken);
    expect(reloaded.getActive()).toEqual([subscription]);

    reloaded.revoke(subscription.endpoint, revocationToken);
    expect(() => reloaded.renew(subscription, revocationToken)).toThrow(
      "Web Push subscription authority is invalid",
    );
  });

  test("does not apply a revocation until the updated file is durable", () => {
    let rejectWrites = false;
    let persisted = "";
    const store = new WebPushSubscriptionStore(
      createLogger(),
      "/unused/web-push-subscriptions.json",
      () => Date.parse("2026-09-05T00:00:00.000Z"),
      LEASE_MS,
      (_filePath, payload) => {
        if (rejectWrites) throw new Error("disk full");
        persisted = String(payload);
      },
    );

    const revocationToken = store.renew(subscription);
    rejectWrites = true;

    expect(() => store.revoke(subscription.endpoint, revocationToken)).toThrow("disk full");
    expect(store.getActive()).toEqual([subscription]);
    expect(JSON.parse(persisted).subscriptions).toHaveLength(1);
  });

  test("requires an opaque per-subscription credential to renew, replace, or revoke", () => {
    let persisted = "";
    const store = new WebPushSubscriptionStore(
      createLogger(),
      "/unused/web-push-subscriptions.json",
      () => Date.parse("2026-09-05T00:00:00.000Z"),
      LEASE_MS,
      (_filePath, payload) => {
        persisted = String(payload);
      },
    );

    const revocationToken = store.renew(subscription);
    expect(revocationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(persisted).not.toContain(revocationToken);

    expect(() =>
      store.renew({
        ...subscription,
        keys: { ...subscription.keys, auth: "other" },
      }),
    ).toThrow("Web Push subscription authority is invalid");
    expect(() => store.revoke(subscription.endpoint, "x".repeat(43))).toThrow(
      "Web Push subscription authority is invalid",
    );
    expect(store.getActive()).toEqual([subscription]);

    expect(store.renew(subscription, revocationToken)).toBe(revocationToken);
    store.revoke(subscription.endpoint, revocationToken);
    expect(store.getActive()).toEqual([]);
  });

  test("issues independent authorities to tabs sharing the unchanged browser subscription", () => {
    const store = new WebPushSubscriptionStore(
      createLogger(),
      "/unused/web-push-subscriptions.json",
      () => Date.parse("2026-09-05T00:00:00.000Z"),
      LEASE_MS,
      () => undefined,
    );

    const first = store.renew(subscription);
    const recovered = store.renew(subscription);

    expect(recovered).not.toBe(first);
    expect(store.renew(subscription, first)).toBe(first);
    expect(store.renew(subscription, recovered)).toBe(recovered);
    store.revoke(subscription.endpoint, first);
    expect(() => store.renew(subscription, recovered)).toThrow(
      "Web Push subscription authority is invalid",
    );
  });

  test("fails closed for unsupported destinations and bounds active registrations", () => {
    const store = new WebPushSubscriptionStore(
      createLogger(),
      "/unused/web-push-subscriptions.json",
      () => Date.parse("2026-09-05T00:00:00.000Z"),
      LEASE_MS,
      () => undefined,
      2,
    );

    expect(() => store.renew({ ...subscription, endpoint: "https://127.0.0.1/internal" })).toThrow(
      "Unsupported Web Push endpoint",
    );
    store.renew(subscription);
    store.renew({
      ...subscription,
      endpoint: "https://web.push.apple.com/device-2",
    });
    expect(() =>
      store.renew({
        ...subscription,
        endpoint: "https://fcm.googleapis.com/wp/device-3",
      }),
    ).toThrow("Web Push subscription limit reached");
  });

  test("evicts only the oldest expired authority when the bounded store is full", () => {
    let now = Date.parse("2026-09-05T00:00:00.000Z");
    const store = new WebPushSubscriptionStore(
      createLogger(),
      "/unused/web-push-subscriptions.json",
      () => now,
      LEASE_MS,
      () => undefined,
      2,
    );
    const oldest = { ...subscription, endpoint: "https://fcm.googleapis.com/wp/oldest" };
    const newer = { ...subscription, endpoint: "https://fcm.googleapis.com/wp/newer" };
    const fresh = { ...subscription, endpoint: "https://web.push.apple.com/fresh" };

    store.renew(oldest);
    now += 1;
    const newerToken = store.renew(newer);
    now += LEASE_MS;

    store.renew(fresh);
    expect(store.getActive()).toEqual([fresh]);
    expect(store.renew(newer, newerToken)).toBe(newerToken);
    expect(store.getActive()).toEqual([newer, fresh]);
  });

  test("drops a persisted unsupported destination before it can be delivered", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-web-push-store-"));
    homes.push(home);
    const filePath = path.join(home, "web-push-subscriptions.json");
    writeFileSync(
      filePath,
      JSON.stringify({
        subscriptions: [
          {
            subscription: { ...subscription, endpoint: "https://127.0.0.1/internal" },
            expiresAt: "2026-09-07T00:00:00.000Z",
            revocationTokenHashes: ["a".repeat(64)],
          },
        ],
      }),
    );

    const store = new WebPushSubscriptionStore(
      createLogger(),
      filePath,
      () => Date.parse("2026-09-05T00:00:00.000Z"),
      LEASE_MS,
    );

    expect(store.getActive()).toEqual([]);
  });

  test("does not include malformed subscription contents in startup warnings", () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-web-push-store-"));
    homes.push(home);
    const filePath = path.join(home, "web-push-subscriptions.json");
    const sensitiveFragment = "private-endpoint-and-key-material";
    writeFileSync(filePath, `{"subscriptions":["${sensitiveFragment}`);
    const warn = vi.fn();
    const logger = {
      child: () => logger,
      debug: () => undefined,
      info: () => undefined,
      warn,
      error: () => undefined,
    } as unknown as pino.Logger;

    const store = new WebPushSubscriptionStore(
      logger,
      filePath,
      () => Date.parse("2026-09-05T00:00:00.000Z"),
      LEASE_MS,
    );

    expect(store.getActive()).toEqual([]);

    expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitiveFragment);
  });
});
