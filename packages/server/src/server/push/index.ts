import type pino from "pino";
import type { WebPushSubscription } from "@getpaseo/protocol/messages";

import { PushService, type PushPayload } from "./push-service.js";
import { PushTokenStore } from "./token-store.js";
import { WebPushService } from "./web-push-service.js";
import { WebPushSubscriptionStore } from "./web-subscription-store.js";

export type { PushPayload };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;
const WEB_PUSH_SUBSCRIPTION_LEASE_MS = 24 * 60 * 60 * 1000;

export interface PushNotifications {
  readonly webPushCapability: { vapidPublicKey: string } | null;
  renew(token: string): void;
  revoke(token: string): void;
  renewWeb(subscription: WebPushSubscription, revocationToken?: string): string;
  revokeWeb(endpoint: string, revocationToken: string): void;
  send(payload: PushPayload): Promise<void>;
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  deliver?: (tokens: string[], payload: PushPayload) => Promise<void>;
  webPush?: {
    filePath: string;
    vapidPublicKey: string;
    vapidPrivateKey: string;
    subject: string;
    deliver?: (subscriptions: WebPushSubscription[], payload: PushPayload) => Promise<void>;
  };
}): PushNotifications {
  const now = options.now ?? Date.now;
  const store = new PushTokenStore(options.logger, options.filePath, now, PUSH_TOKEN_LEASE_MS);
  const service = new PushService(options.logger, (token) => store.revokeToken(token));
  const deliver =
    options.deliver ??
    ((tokens: string[], payload: PushPayload) => service.sendPush(tokens, payload));
  let webStore: WebPushSubscriptionStore | null = null;
  let deliverWeb:
    | ((subscriptions: WebPushSubscription[], payload: PushPayload) => Promise<void>)
    | null = null;
  if (options.webPush) {
    try {
      const candidateStore = new WebPushSubscriptionStore(
        options.logger,
        options.webPush.filePath,
        now,
        WEB_PUSH_SUBSCRIPTION_LEASE_MS,
      );
      // Construct the sender even when tests inject delivery so malformed VAPID
      // credentials can never be advertised as a usable browser capability.
      const candidateService = new WebPushService(
        options.logger,
        {
          subject: options.webPush.subject,
          publicKey: options.webPush.vapidPublicKey,
          privateKey: options.webPush.vapidPrivateKey,
        },
        (endpoint) => candidateStore.revokeInvalid(endpoint),
      );
      webStore = candidateStore;
      deliverWeb =
        options.webPush.deliver ??
        ((subscriptions, payload) => candidateService.sendPush(subscriptions, payload));
    } catch (error) {
      options.logger.warn(
        { errorName: error instanceof Error ? error.name : "Error" },
        "Web Push is disabled because VAPID configuration is invalid",
      );
    }
  }

  return {
    webPushCapability:
      options.webPush && webStore ? { vapidPublicKey: options.webPush.vapidPublicKey } : null,
    renew(token) {
      store.renewToken(token);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    renewWeb(subscription, revocationToken) {
      if (!webStore) throw new Error("Web Push is not configured");
      return webStore.renew(subscription, revocationToken);
    },
    revokeWeb(endpoint, revocationToken) {
      if (!webStore) throw new Error("Web Push is not configured");
      webStore.revoke(endpoint, revocationToken);
    },
    async send(payload) {
      const tokens = store.getActiveTokens();
      const webSubscriptions = webStore?.getActive() ?? [];
      options.logger.info(
        {
          tokenCount: tokens.length,
          webSubscriptionCount: webSubscriptions.length,
        },
        "Sending push notification",
      );
      await Promise.all([
        tokens.length > 0 ? deliver(tokens, payload) : Promise.resolve(),
        webSubscriptions.length > 0 && deliverWeb
          ? deliverWeb(webSubscriptions, payload)
          : Promise.resolve(),
      ]);
    },
  };
}
