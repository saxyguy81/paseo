import type { WebPushSubscription } from "@getpaseo/protocol/messages";
import type pino from "pino";
import webPush from "web-push";

import type { PushPayload } from "./push-service.js";
import { assertAllowedWebPushEndpoint } from "./web-push-endpoint.js";

const GONE_STATUS_CODES = new Set([404, 410]);
const WEB_PUSH_DELIVERY_TIMEOUT_MS = 10_000;
const MAX_WEB_PUSH_DELIVERIES = 32;

export interface WebPushVapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export class WebPushService {
  private readonly logger: pino.Logger;
  private readonly vapidDetails: WebPushVapidConfig;

  constructor(
    logger: pino.Logger,
    config: WebPushVapidConfig,
    private readonly revokeSubscription: (endpoint: string) => void,
  ) {
    this.logger = logger.child({ component: "web-push-service" });
    // Validate once without mutating web-push's module-global defaults. Every
    // delivery carries this service instance's credentials explicitly so a
    // canary or second daemon cannot change another sender's signing key.
    webPush.getVapidHeaders(
      "https://fcm.googleapis.com",
      config.subject,
      config.publicKey,
      config.privateKey,
      "aes128gcm",
    );
    this.vapidDetails = config;
  }

  async sendPush(subscriptions: WebPushSubscription[], payload: PushPayload): Promise<void> {
    await Promise.all(
      subscriptions
        .slice(0, MAX_WEB_PUSH_DELIVERIES)
        .map((subscription) => this.sendOne(subscription, payload)),
    );
  }

  private async sendOne(subscription: WebPushSubscription, payload: PushPayload): Promise<void> {
    try {
      assertAllowedWebPushEndpoint(subscription.endpoint);
    } catch {
      this.logger.warn("Skipped Web Push delivery to an unsupported endpoint");
      return;
    }

    try {
      await webPush.sendNotification(subscription, JSON.stringify(payload), {
        TTL: 60 * 60,
        urgency: "normal",
        timeout: WEB_PUSH_DELIVERY_TIMEOUT_MS,
        vapidDetails: this.vapidDetails,
      });
    } catch (error) {
      const statusCode = readStatusCode(error);
      if (statusCode !== null && GONE_STATUS_CODES.has(statusCode)) {
        try {
          this.revokeSubscription(subscription.endpoint);
        } catch (revokeError) {
          this.logger.warn(
            { errorName: readErrorName(revokeError) },
            "Failed to remove expired Web Push subscription",
          );
        }
      }
      this.logger.warn({ errorName: readErrorName(error), statusCode }, "Web Push delivery failed");
    }
  }
}

function readErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}

function readStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}
