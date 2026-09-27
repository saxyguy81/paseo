const GOOGLE_PUSH_HOST = "fcm.googleapis.com";
const GOOGLE_PUSH_PATH_PREFIXES = ["/wp/", "/fcm/send/"] as const;
const APPLE_PUSH_DOMAIN = "push.apple.com";

export const DOCUMENTED_WEB_PUSH_DESTINATIONS = [
  "https://fcm.googleapis.com/wp/<opaque-subscription>",
  "https://fcm.googleapis.com/fcm/send/<opaque-subscription>",
  "https://*.push.apple.com/<opaque-subscription>",
] as const;

export class UnsupportedWebPushEndpointError extends Error {
  constructor() {
    super("Unsupported Web Push endpoint");
    this.name = "UnsupportedWebPushEndpointError";
  }
}

/**
 * Validate a browser-supplied PushSubscription destination before persistence
 * or network access. The list intentionally contains only the current Chrome
 * and Safari Web Push services supported by Paseo.
 */
export function assertAllowedWebPushEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new UnsupportedWebPushEndpointError();
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    endpoint.length > 4096
  ) {
    throw new UnsupportedWebPushEndpointError();
  }

  const hostname = url.hostname.toLowerCase();
  const hasOpaquePath = url.pathname.length > 1;
  const isGooglePush =
    hostname === GOOGLE_PUSH_HOST &&
    GOOGLE_PUSH_PATH_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
  const isApplePush =
    hostname.endsWith(`.${APPLE_PUSH_DOMAIN}`) && hostname.length > APPLE_PUSH_DOMAIN.length + 1;

  if (!hasOpaquePath || (!isGooglePush && !isApplePush)) {
    throw new UnsupportedWebPushEndpointError();
  }

  return url.href;
}
