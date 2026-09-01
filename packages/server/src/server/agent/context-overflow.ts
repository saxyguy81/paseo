import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

export type ConversationRolloverFailureKind =
  | "context_overflow"
  | "conversation_unresolved"
  | "resume_model_unavailable";

/** Return true only for provider failures that mean the current context is exhausted. */
export function isContextOverflowFailureText(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  return /(?:\bprompt (?:is )?too long\b|\bcontext (?:window|length) (?:is )?(?:too (?:large|long)|exceeded|overflow(?:ed)?)|\bmaximum context (?:length|window)\b|\bcontext length exceeded\b)/i.test(
    value,
  );
}

/** Return true only when the provider cannot safely continue the native conversation. */
export function isConversationUnresolvedFailureText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (/^API Error:\s*409\s+Conversation has an unresolved prior request\b/i.test(value.trim()) ||
      /^API Error:\s*409\s+Conversation already has an active request\b/i.test(value.trim()) ||
      /^API Error:\s*503\s+Continuation matching is temporarily unavailable\b/i.test(value.trim()))
  );
}

/**
 * Recognize the canonical text persisted after Claude's structured
 * `model_not_found` SDK error. Live classification uses the structured tag;
 * this predicate exists only so a terminal failure survives daemon hydration.
 */
export function isResumeModelUnavailableFailureText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^There(?:'|’)s an issue with the selected model \(.+\)\. It may not exist or you may not have access to it\. Run --model to pick a different model\.$/i.test(
      value.trim(),
    )
  );
}

export function isConversationRolloverFailureKind(
  value: unknown,
): value is ConversationRolloverFailureKind {
  return (
    value === "context_overflow" ||
    value === "conversation_unresolved" ||
    value === "resume_model_unavailable"
  );
}

export function isConversationRolloverFailureText(
  kind: ConversationRolloverFailureKind,
  value: unknown,
): value is string {
  if (kind === "context_overflow") return isContextOverflowFailureText(value);
  if (kind === "conversation_unresolved") return isConversationUnresolvedFailureText(value);
  return isResumeModelUnavailableFailureText(value);
}

export interface TerminalConversationRolloverFailure {
  kind: ConversationRolloverFailureKind;
  text: string;
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

/** Classify a persisted terminal error that requires a fresh native session. */
export function readTerminalConversationRolloverFailure(
  rows: readonly AgentTimelineRow[],
): TerminalConversationRolloverFailure | null {
  const item = rows.at(-1)?.item;
  let text: string | null = null;
  if (item?.type === "assistant_message") {
    text = item.text;
  } else if (item?.type === "error") {
    text = item.message;
  }
  if (isContextOverflowFailureText(text)) {
    return { kind: "context_overflow", text };
  }
  if (isConversationUnresolvedFailureText(text)) {
    return { kind: "conversation_unresolved", text };
  }
  if (isResumeModelUnavailableFailureText(text)) {
    return { kind: "resume_model_unavailable", text };
  }
  return null;
}
