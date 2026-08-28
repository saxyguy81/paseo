/** Return true only for provider failures that mean the current context is exhausted. */
export function isContextOverflowFailureText(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  return /(?:\bprompt (?:is )?too long\b|\bcontext (?:window|length) (?:is )?(?:too (?:large|long)|exceeded|overflow(?:ed)?)|\bmaximum context (?:length|window)\b|\bcontext length exceeded\b)/i.test(
    value,
  );
}
