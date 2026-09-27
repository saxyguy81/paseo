import { describe, expect, test } from "vitest";

import { assertAllowedWebPushEndpoint } from "./web-push-endpoint.js";

describe("assertAllowedWebPushEndpoint", () => {
  test.each([
    "https://fcm.googleapis.com/wp/current-chrome-token",
    "https://fcm.googleapis.com/fcm/send/legacy-chrome-token",
    "https://web.push.apple.com/current-safari-token",
    "https://region.push.apple.com/current-safari-token",
  ])("accepts a documented browser push-service endpoint: %s", (endpoint) => {
    expect(assertAllowedWebPushEndpoint(endpoint)).toBe(endpoint);
  });

  test.each([
    "http://fcm.googleapis.com/wp/token",
    "https://fcm.googleapis.com:444/wp/token",
    "https://user:pass@fcm.googleapis.com/wp/token",
    "https://fcm.googleapis.com/v1/projects/internal/messages:send",
    "https://evil-fcm.googleapis.com/wp/token",
    "https://push.apple.com.evil.example/token",
    "https://localhost/token",
    "https://127.0.0.1/token",
    "https://[::1]/token",
    "https://fcm.googleapis.com/wp/token?redirect=https://127.0.0.1",
    "https://web.push.apple.com/token#fragment",
  ])("rejects an unsupported or ambiguous destination: %s", (endpoint) => {
    expect(() => assertAllowedWebPushEndpoint(endpoint)).toThrow("Unsupported Web Push endpoint");
  });
});
