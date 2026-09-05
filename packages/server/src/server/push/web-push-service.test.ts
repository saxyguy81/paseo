import type pino from "pino";
import { beforeEach, describe, expect, test, vi } from "vitest";

const webPushMocks = vi.hoisted(() => ({
  getVapidHeaders: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("web-push", () => ({ default: webPushMocks }));

import { WebPushService } from "./web-push-service.js";

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

describe("WebPushService", () => {
  beforeEach(() => vi.clearAllMocks());

  test("configures VAPID and sends the shared attention payload", async () => {
    webPushMocks.sendNotification.mockResolvedValue(undefined);
    const service = new WebPushService(
      createLogger(),
      {
        subject: "mailto:operator@example.test",
        publicKey: "public",
        privateKey: "private",
      },
      vi.fn(),
    );

    await service.sendPush([subscription], {
      title: "Agent needs attention",
      body: "Encountered an error.",
      data: {
        serverId: "server-1",
        workspaceId: "workspace-1",
        agentId: "agent-1",
      },
    });

    expect(webPushMocks.getVapidHeaders).toHaveBeenCalledWith(
      "https://fcm.googleapis.com",
      "mailto:operator@example.test",
      "public",
      "private",
      "aes128gcm",
    );
    expect(webPushMocks.sendNotification).toHaveBeenCalledWith(
      subscription,
      JSON.stringify({
        title: "Agent needs attention",
        body: "Encountered an error.",
        data: {
          serverId: "server-1",
          workspaceId: "workspace-1",
          agentId: "agent-1",
        },
      }),
      {
        TTL: 3_600,
        urgency: "normal",
        timeout: 10_000,
        vapidDetails: {
          subject: "mailto:operator@example.test",
          publicKey: "public",
          privateKey: "private",
        },
      },
    );
  });

  test("revokes only subscriptions rejected as gone by the push service", async () => {
    const revoke = vi.fn();
    const service = new WebPushService(
      createLogger(),
      {
        subject: "mailto:operator@example.test",
        publicKey: "public",
        privateKey: "private",
      },
      revoke,
    );
    webPushMocks.sendNotification
      .mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }))
      .mockRejectedValueOnce(Object.assign(new Error("temporary"), { statusCode: 503 }));

    await service.sendPush(
      [subscription, { ...subscription, endpoint: "https://fcm.googleapis.com/wp/device-2" }],
      { title: "Agent finished", body: "Done" },
    );

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(subscription.endpoint);
  });

  test("refuses an unsupported destination before making an outbound request", async () => {
    const service = new WebPushService(
      createLogger(),
      {
        subject: "mailto:operator@example.test",
        publicKey: "public",
        privateKey: "private",
      },
      vi.fn(),
    );

    await service.sendPush([{ ...subscription, endpoint: "https://127.0.0.1/internal" }], {
      title: "Agent finished",
      body: "Done",
    });

    expect(webPushMocks.sendNotification).not.toHaveBeenCalled();
  });

  test("bounds each delivery batch", async () => {
    webPushMocks.sendNotification.mockResolvedValue(undefined);
    const service = new WebPushService(
      createLogger(),
      { subject: "mailto:operator@example.test", publicKey: "public", privateKey: "private" },
      vi.fn(),
    );
    const subscriptions = Array.from({ length: 40 }, (_, index) => ({
      ...subscription,
      endpoint: `https://fcm.googleapis.com/wp/device-${index}`,
    }));

    await service.sendPush(subscriptions, { title: "Agent finished", body: "Done" });

    expect(webPushMocks.sendNotification).toHaveBeenCalledTimes(32);
  });

  test("never logs endpoint-bearing push-service errors", async () => {
    const warn = vi.fn();
    const logger = {
      child: () => logger,
      debug: () => undefined,
      info: () => undefined,
      warn,
      error: () => undefined,
    } as unknown as pino.Logger;
    const service = new WebPushService(
      logger,
      { subject: "mailto:operator@example.test", publicKey: "public", privateKey: "private" },
      vi.fn(),
    );
    webPushMocks.sendNotification.mockRejectedValue(
      new Error(`request to ${subscription.endpoint} failed`),
    );

    await service.sendPush([subscription], { title: "Agent finished", body: "Done" });

    expect(JSON.stringify(warn.mock.calls)).not.toContain(subscription.endpoint);
  });
});
