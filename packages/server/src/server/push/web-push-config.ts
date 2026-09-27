import path from "node:path";

export interface WebPushConfig {
  filePath: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  subject: string;
}

const WEB_PUSH_ENV_NAMES = [
  "PASEO_WEB_PUSH_VAPID_PUBLIC_KEY",
  "PASEO_WEB_PUSH_VAPID_PRIVATE_KEY",
  "PASEO_WEB_PUSH_VAPID_SUBJECT",
] as const;

export function resolveWebPushConfig(
  env: NodeJS.ProcessEnv,
  paseoHome: string,
): { config: WebPushConfig | null; warning: string | null } {
  const values = Object.fromEntries(
    WEB_PUSH_ENV_NAMES.map((name) => [name, env[name]?.trim() ?? ""]),
  ) as Record<(typeof WEB_PUSH_ENV_NAMES)[number], string>;
  const configured = WEB_PUSH_ENV_NAMES.filter((name) => values[name].length > 0);
  if (configured.length === 0) return { config: null, warning: null };

  const missing = WEB_PUSH_ENV_NAMES.filter((name) => values[name].length === 0);
  if (missing.length > 0) {
    return {
      config: null,
      warning: `Web Push is disabled because VAPID configuration is incomplete: missing ${missing.join(", ")}`,
    };
  }

  return {
    config: {
      filePath: path.join(paseoHome, "web-push-subscriptions.json"),
      vapidPublicKey: values.PASEO_WEB_PUSH_VAPID_PUBLIC_KEY,
      vapidPrivateKey: values.PASEO_WEB_PUSH_VAPID_PRIVATE_KEY,
      subject: values.PASEO_WEB_PUSH_VAPID_SUBJECT,
    },
    warning: null,
  };
}
