import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

/** Return true only for provider failures that mean the current context is exhausted. */
export function isContextOverflowFailureText(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  return /(?:\bprompt (?:is )?too long\b|\bcontext (?:window|length) (?:is )?(?:too (?:large|long)|exceeded|overflow(?:ed)?)|\bmaximum context (?:length|window)\b|\bcontext length exceeded\b)/i.test(
    value,
  );
}

/** Read a context overflow only when it is the terminal hydrated timeline item. */
export function readTerminalContextOverflowFailure(
  rows: readonly AgentTimelineRow[],
): string | null {
  const item = rows.at(-1)?.item;
  let text: string | null = null;
  if (item?.type === "assistant_message") {
    text = item.text;
  } else if (item?.type === "error") {
    text = item.message;
  }
  return isContextOverflowFailureText(text) ? text : null;
}
