export const INTERNAL_PROMPT_PREFLIGHT_ID_PREFIX = "paseo-internal-preflight:";

export function isInternalPromptPreflightId(id: unknown): id is string {
  return typeof id === "string" && id.startsWith(INTERNAL_PROMPT_PREFLIGHT_ID_PREFIX);
}

export function buildInternalPromptPreflightId(
  targetPromptId: string,
  preflightKey: string,
): string {
  return `${INTERNAL_PROMPT_PREFLIGHT_ID_PREFIX}${encodeURIComponent(targetPromptId)}:${encodeURIComponent(preflightKey)}`;
}
