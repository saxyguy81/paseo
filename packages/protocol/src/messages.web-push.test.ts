import { describe, expect, it } from "vitest";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  StatusMessageSchema,
} from "./messages.js";

const subscription = {
  endpoint: "https://fcm.googleapis.com/wp/subscription-1",
  expirationTime: null,
  keys: {
    p256dh: "public-key",
    auth: "auth-secret",
  },
};

describe("web push protocol", () => {
  it("advertises Web Push configuration as an optional daemon capability", () => {
    const current = StatusMessageSchema.parse({
      type: "status",
      payload: {
        status: "server_info",
        serverId: "host-1",
        features: {
          webPushNotifications: {
            vapidPublicKey: "vapid-public-key",
          },
        },
      },
    });
    const older = StatusMessageSchema.parse({
      type: "status",
      payload: { status: "server_info", serverId: "host-1" },
    });

    expect(current.payload.features?.webPushNotifications).toEqual({
      vapidPublicKey: "vapid-public-key",
    });
    expect(older.payload.features?.webPushNotifications).toBeUndefined();
  });

  it("uses capability-gated subscribe and possession-bound unsubscribe RPCs", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "push.web.subscribe.request",
        requestId: "subscribe-1",
        subscription,
        revocationToken: "a".repeat(43),
      }),
    ).toEqual({
      type: "push.web.subscribe.request",
      requestId: "subscribe-1",
      subscription,
      revocationToken: "a".repeat(43),
    });
    expect(
      SessionInboundMessageSchema.parse({
        type: "push.web.unsubscribe.request",
        requestId: "unsubscribe-1",
        endpoint: subscription.endpoint,
        revocationToken: "b".repeat(43),
      }).type,
    ).toBe("push.web.unsubscribe.request");
    expect(
      SessionOutboundMessageSchema.parse({
        type: "push.web.subscribe.response",
        payload: { requestId: "subscribe-1", revocationToken: "c".repeat(43) },
      }).type,
    ).toBe("push.web.subscribe.response");
    expect(
      SessionOutboundMessageSchema.parse({
        type: "push.web.unsubscribe.response",
        payload: { requestId: "unsubscribe-1" },
      }).type,
    ).toBe("push.web.unsubscribe.response");

    expect(() =>
      SessionInboundMessageSchema.parse({
        type: "push.web.unsubscribe.request",
        requestId: "unsubscribe-without-proof",
        endpoint: subscription.endpoint,
      }),
    ).toThrow();
  });
});
