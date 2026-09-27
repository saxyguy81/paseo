import path from "node:path";
import { describe, expect, test } from "vitest";

import { resolveWebPushConfig } from "./web-push-config.js";

describe("resolveWebPushConfig", () => {
  test("returns no configuration when Web Push is intentionally disabled", () => {
    expect(resolveWebPushConfig({}, "/srv/paseo")).toEqual({ config: null, warning: null });
  });

  test("resolves VAPID credentials without exposing the private key as a capability", () => {
    expect(
      resolveWebPushConfig(
        {
          PASEO_WEB_PUSH_VAPID_PUBLIC_KEY: " public-key ",
          PASEO_WEB_PUSH_VAPID_PRIVATE_KEY: " private-key ",
          PASEO_WEB_PUSH_VAPID_SUBJECT: " mailto:operator@example.test ",
        },
        "/srv/paseo",
      ),
    ).toEqual({
      config: {
        filePath: path.join("/srv/paseo", "web-push-subscriptions.json"),
        vapidPublicKey: "public-key",
        vapidPrivateKey: "private-key",
        subject: "mailto:operator@example.test",
      },
      warning: null,
    });
  });

  test("disables Web Push and reports missing fields for a partial configuration", () => {
    expect(
      resolveWebPushConfig({ PASEO_WEB_PUSH_VAPID_PUBLIC_KEY: "public-key" }, "/srv/paseo"),
    ).toEqual({
      config: null,
      warning:
        "Web Push is disabled because VAPID configuration is incomplete: missing PASEO_WEB_PUSH_VAPID_PRIVATE_KEY, PASEO_WEB_PUSH_VAPID_SUBJECT",
    });
  });
});
