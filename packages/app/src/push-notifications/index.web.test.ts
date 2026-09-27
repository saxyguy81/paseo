import { beforeEach, describe, expect, it, vi } from "vitest";

const pushMocks = vi.hoisted(() => ({
  clearSelectedWebPushNotificationHost: vi.fn(),
  disableWebPushNotifications: vi.fn(async () => undefined),
  isWebPushNotificationHostSelected: vi.fn((_serverId: string) => false),
  renewWebPushNotifications: vi.fn(async () => undefined),
}));

vi.mock("./web-subscription.web", () => pushMocks);

import { revokePushNotifications, startPushNotifications } from "./index.web";

function client() {
  let listener: ((state: { status: string }) => void) | null = null;
  return {
    client: {
      isConnected: true,
      subscribeConnectionStatus(callback: (state: { status: string }) => void) {
        listener = callback;
        return () => {
          listener = null;
        };
      },
    },
    reconnect() {
      listener?.({ status: "connected" });
    },
  };
}

describe("web push lifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renews only the explicitly selected notification host", async () => {
    const first = client();
    const second = client();
    pushMocks.isWebPushNotificationHostSelected.mockImplementation(
      (serverId: string) => serverId === "selected-host",
    );

    const stopFirst = startPushNotifications({
      client: first.client as never,
      serverId: "selected-host",
    });
    const stopSecond = startPushNotifications({
      client: second.client as never,
      serverId: "other-host",
    });
    first.reconnect();
    second.reconnect();
    await vi.waitFor(() => expect(pushMocks.renewWebPushNotifications).toHaveBeenCalledTimes(2));

    expect(pushMocks.renewWebPushNotifications).toHaveBeenCalledWith(first.client);
    stopFirst();
    stopSecond();
  });

  it("clears selected-host preference when a host is removed even while disconnected", async () => {
    await revokePushNotifications({ client: null, serverId: "removed-host" });

    expect(pushMocks.disableWebPushNotifications).not.toHaveBeenCalled();
    expect(pushMocks.clearSelectedWebPushNotificationHost).toHaveBeenCalledWith("removed-host");
  });
});
