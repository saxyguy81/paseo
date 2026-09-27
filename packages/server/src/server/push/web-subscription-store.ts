import { WebPushSubscriptionSchema, type WebPushSubscription } from "@getpaseo/protocol/messages";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type pino from "pino";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";
import { assertAllowedWebPushEndpoint } from "./web-push-endpoint.js";

const DEFAULT_MAX_SUBSCRIPTIONS = 32;
const MAX_REVOCATION_AUTHORITIES_PER_SUBSCRIPTION = 8;

interface StoredWebPushSubscription {
  subscription: WebPushSubscription;
  expiresAt: number;
  revocationTokenHashes: string[];
}

export class InvalidWebPushSubscriptionAuthorityError extends Error {
  constructor() {
    super("Web Push subscription authority is invalid");
    this.name = "InvalidWebPushSubscriptionAuthorityError";
  }
}

export class WebPushSubscriptionLimitError extends Error {
  constructor() {
    super("Web Push subscription limit reached");
    this.name = "WebPushSubscriptionLimitError";
  }
}

/** Durable leased Web Push subscriptions, keyed by browser push endpoint. */
export class WebPushSubscriptionStore {
  private readonly logger: pino.Logger;
  private readonly subscriptions = new Map<string, StoredWebPushSubscription>();

  constructor(
    logger: pino.Logger,
    private readonly filePath: string,
    private readonly now: () => number,
    private readonly leaseMs: number,
    private readonly write: typeof writePrivateFileAtomicSync = writePrivateFileAtomicSync,
    private readonly maxSubscriptions: number = DEFAULT_MAX_SUBSCRIPTIONS,
  ) {
    this.logger = logger.child({ component: "web-push-subscription-store" });
    this.loadFromDisk();
  }

  renew(subscription: WebPushSubscription, revocationToken?: string): string {
    const parsed = WebPushSubscriptionSchema.parse(subscription);
    const normalized = {
      ...parsed,
      endpoint: assertAllowedWebPushEndpoint(parsed.endpoint),
    };
    const now = this.now();
    const current = this.subscriptions.get(normalized.endpoint);
    const next = new Map(this.subscriptions);

    let nextRevocationToken: string;
    if (current) {
      if (
        revocationToken !== undefined &&
        tokenMatches(revocationToken, current.revocationTokenHashes)
      ) {
        nextRevocationToken = revocationToken;
      } else if (
        revocationToken === undefined &&
        subscriptionsEqual(current.subscription, normalized)
      ) {
        // A browser can recover after a page reload from its full PushSubscription.
        // Rotate rather than persisting the bearer credential in browser storage.
        nextRevocationToken = createRevocationToken();
      } else {
        throw new InvalidWebPushSubscriptionAuthorityError();
      }
    } else {
      if (revocationToken !== undefined) {
        // A stale tab must not recreate a subscription that another tab (or a
        // push-service rejection) explicitly revoked.
        throw new InvalidWebPushSubscriptionAuthorityError();
      }
      if (next.size >= this.maxSubscriptions) {
        const oldestExpired = Array.from(next.entries())
          .filter(([, value]) => value.expiresAt <= now)
          .sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0];
        if (!oldestExpired) throw new WebPushSubscriptionLimitError();
        next.delete(oldestExpired[0]);
      }
      nextRevocationToken = createRevocationToken();
    }

    if (
      current &&
      current.expiresAt - now > this.leaseMs / 2 &&
      subscriptionsEqual(current.subscription, normalized) &&
      revocationToken !== undefined
    ) {
      return nextRevocationToken;
    }

    next.set(normalized.endpoint, {
      subscription: normalized,
      expiresAt: now + this.leaseMs,
      revocationTokenHashes:
        current && revocationToken === undefined
          ? [...current.revocationTokenHashes, hashToken(nextRevocationToken)].slice(
              -MAX_REVOCATION_AUTHORITIES_PER_SUBSCRIPTION,
            )
          : (current?.revocationTokenHashes ?? [hashToken(nextRevocationToken)]),
    });
    this.persist(next);
    this.replace(next);
    this.logger.debug({ total: this.subscriptions.size }, "Renewed Web Push subscription");
    return nextRevocationToken;
  }

  revoke(endpoint: string, revocationToken: string): void {
    const normalized = assertAllowedWebPushEndpoint(endpoint.trim());
    const current = this.subscriptions.get(normalized);
    if (!current || !tokenMatches(revocationToken, current.revocationTokenHashes)) {
      throw new InvalidWebPushSubscriptionAuthorityError();
    }
    this.revokeTrusted(normalized);
  }

  /** Remove a push-service-rejected endpoint from trusted server delivery code. */
  revokeInvalid(endpoint: string): void {
    let normalized: string;
    try {
      normalized = assertAllowedWebPushEndpoint(endpoint.trim());
    } catch {
      return;
    }
    this.revokeTrusted(normalized);
  }

  private revokeTrusted(endpoint: string): void {
    if (!this.subscriptions.has(endpoint)) return;
    const next = new Map(this.subscriptions);
    next.delete(endpoint);
    this.persist(next);
    this.replace(next);
    this.logger.debug({ total: this.subscriptions.size }, "Revoked Web Push subscription");
  }

  getActive(): WebPushSubscription[] {
    const now = this.now();
    const retained = new Map(this.subscriptions);
    const active: WebPushSubscription[] = [];
    for (const [endpoint, value] of this.subscriptions) {
      try {
        assertAllowedWebPushEndpoint(endpoint);
      } catch {
        retained.delete(endpoint);
        continue;
      }
      if (value.expiresAt > now) active.push(value.subscription);
    }
    if (retained.size !== this.subscriptions.size) {
      try {
        this.persist(retained);
        this.replace(retained);
      } catch {
        // A later delivery retries pruning. Unsupported subscriptions stay excluded now.
      }
    }
    return active;
  }

  private replace(next: ReadonlyMap<string, StoredWebPushSubscription>): void {
    this.subscriptions.clear();
    for (const [endpoint, value] of next) this.subscriptions.set(endpoint, value);
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) return;
      ensurePrivateFile(this.filePath);
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as {
        subscriptions?: unknown;
      };
      if (!Array.isArray(parsed.subscriptions)) return;

      for (const value of parsed.subscriptions) {
        if (!value || typeof value !== "object") continue;
        const candidate = value as {
          subscription?: unknown;
          expiresAt?: unknown;
          revocationTokenHash?: unknown;
          revocationTokenHashes?: unknown;
        };
        const subscription = WebPushSubscriptionSchema.safeParse(candidate.subscription);
        const expiresAt =
          typeof candidate.expiresAt === "string" ? Date.parse(candidate.expiresAt) : Number.NaN;
        if (subscription.success && Number.isFinite(expiresAt)) {
          let endpoint: string;
          try {
            endpoint = assertAllowedWebPushEndpoint(subscription.data.endpoint);
          } catch {
            continue;
          }
          if (this.subscriptions.size >= this.maxSubscriptions) break;
          this.subscriptions.set(endpoint, {
            subscription: { ...subscription.data, endpoint },
            expiresAt,
            revocationTokenHashes: parseRevocationTokenHashes(candidate),
          });
        }
      }
      this.logger.info({ total: this.subscriptions.size }, "Loaded Web Push subscriptions");
    } catch (error) {
      this.logger.warn(
        { errorName: readErrorName(error) },
        "Failed to load Web Push subscriptions",
      );
    }
  }

  private persist(subscriptions: ReadonlyMap<string, StoredWebPushSubscription>): void {
    try {
      const payload = `${JSON.stringify(
        {
          subscriptions: Array.from(
            subscriptions.values(),
            ({ subscription, expiresAt, revocationTokenHashes }) => ({
              subscription,
              expiresAt: new Date(expiresAt).toISOString(),
              revocationTokenHashes,
            }),
          ),
        },
        null,
        2,
      )}\n`;
      this.write(this.filePath, payload);
    } catch (error) {
      this.logger.warn(
        { errorName: readErrorName(error) },
        "Failed to persist Web Push subscriptions",
      );
      throw error;
    }
  }
}

function createRevocationToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token: string, expectedHashes: readonly string[]): boolean {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  return expectedHashes.some((expectedHash) => {
    const expected = Buffer.from(expectedHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

function subscriptionsEqual(left: WebPushSubscription, right: WebPushSubscription): boolean {
  return (
    left.endpoint === right.endpoint &&
    left.expirationTime === right.expirationTime &&
    left.keys.p256dh === right.keys.p256dh &&
    left.keys.auth === right.keys.auth
  );
}

function parseRevocationTokenHashes(candidate: {
  revocationTokenHash?: unknown;
  revocationTokenHashes?: unknown;
}): string[] {
  const values = Array.isArray(candidate.revocationTokenHashes)
    ? candidate.revocationTokenHashes
    : [candidate.revocationTokenHash];
  return values
    .filter((value): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
    .slice(-MAX_REVOCATION_AUTHORITIES_PER_SUBSCRIPTION);
}

function readErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "Error";
}
