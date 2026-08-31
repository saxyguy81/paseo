import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { isLikelyExternalToolName } from "@getpaseo/protocol/tool-name-normalization";
import { buildToolCallDisplayModel } from "@getpaseo/protocol/tool-call-display";
import { projectTimelineRows } from "./timeline-projection.js";
import {
  isContextOverflowFailureText,
  isConversationUnresolvedFailureText,
} from "./context-overflow.js";

const DEFAULT_MAX_ITEMS = 0;
const MAX_TOOL_INPUT_CHARS = 400;
const MAX_TOOL_SUMMARY_CHARS = 200;
const DEFAULT_CONTEXT_OVERFLOW_CONTINUATION_MAX_CHARS = 24_000;
const MAX_CONTEXT_STATE_ENTRY_CHARS = 1_000;

interface ActivityCuratorOptions {
  maxItems?: number;
  labelAssistantMessages?: boolean;
  includeKinds?: readonly AgentTimelineItem["type"][];
  includeExternalToolInput?: boolean;
}

interface ActivityEntry {
  text: string;
}

type TextAgentAttachment = Extract<AgentAttachment, { type: "text" }>;

function appendText(buffer: string, text: string): string {
  const normalized = text.trim();
  if (!normalized) {
    return buffer;
  }
  if (!buffer) {
    return normalized;
  }
  return `${buffer}\n${normalized}`;
}

function activityEntry(text: string): ActivityEntry {
  return { text };
}

function flushBuffers(
  entries: ActivityEntry[],
  buffers: { message: string; thought: string },
  options?: ActivityCuratorOptions,
) {
  if (buffers.message.trim()) {
    const text = buffers.message.trim();
    entries.push(activityEntry(options?.labelAssistantMessages ? `[Assistant] ${text}` : text));
  }
  if (buffers.thought.trim()) {
    const text = buffers.thought.trim();
    entries.push(activityEntry(`[Thought] ${text}`));
  }
  buffers.message = "";
  buffers.thought = "";
}

function formatToolInputJson(input: unknown): string | null {
  if (input === undefined) {
    return null;
  }
  try {
    const encoded = JSON.stringify(input);
    if (!encoded) {
      return null;
    }
    if (encoded.length <= MAX_TOOL_INPUT_CHARS) {
      return encoded;
    }
    return `${encoded.slice(0, MAX_TOOL_INPUT_CHARS)}...`;
  } catch {
    return null;
  }
}

function formatToolSummary(summary: string | undefined): string | null {
  if (typeof summary !== "string") {
    return null;
  }
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= MAX_TOOL_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TOOL_SUMMARY_CHARS - 3)}...`;
}

function normalizeBoundedText(value: unknown, maxChars: number): string | null {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      return null;
    }
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatContextOverflowStateEntry(item: AgentTimelineItem): string | null {
  switch (item.type) {
    case "assistant_message": {
      const text = item.text.trim();
      return text.startsWith("[System Error]") ||
        isContextOverflowFailureText(text) ||
        isConversationUnresolvedFailureText(text)
        ? null
        : normalizeBoundedText(text, MAX_CONTEXT_STATE_ENTRY_CHARS);
    }
    case "todo": {
      const lines = item.items.map(
        (entry) => `- [${entry.completed ? "x" : " "}] ${entry.text.trim()}`,
      );
      return normalizeBoundedText(`[Tasks]\n${lines.join("\n")}`, MAX_CONTEXT_STATE_ENTRY_CHARS);
    }
    case "tool_call": {
      if (item.name.toLowerCase() === "askuserquestion" && item.detail.type === "unknown") {
        const question = normalizeBoundedText(item.detail.input, MAX_CONTEXT_STATE_ENTRY_CHARS / 2);
        const answer = normalizeBoundedText(item.detail.output, MAX_CONTEXT_STATE_ENTRY_CHARS / 2);
        if (question || answer) {
          return `[User decision]\n${question ?? "Question unavailable"}\n${answer ?? "No answer recorded"}`;
        }
      }
      return formatToolCallEntry(item, { includeExternalToolInput: false }).text;
    }
    case "user_message":
    case "reasoning":
    case "error":
    case "compaction":
      return null;
  }
}

/**
 * Build a deliberately small handoff for a fresh native session after the
 * previous one becomes unsafe to continue. The latest user request is preserved
 * verbatim; older conversation history is never copied.
 */
export function buildAgentFreshSessionContinuationPrompt(input: {
  rows: readonly AgentTimelineRow[];
  failureKind: "context_overflow" | "conversation_unresolved" | "resume_model_unavailable";
  maxChars?: number;
}): string | null {
  const maxChars = input.maxChars ?? DEFAULT_CONTEXT_OVERFLOW_CONTINUATION_MAX_CHARS;
  const projected = projectTimelineRows({ rows: input.rows, mode: "projected" });
  const latestUserIndex = projected.findLastIndex(
    (entry) => entry.item.type === "user_message" && entry.item.text.trim().length > 0,
  );
  if (latestUserIndex < 0) {
    return null;
  }

  const latestUser = projected[latestUserIndex]?.item;
  if (!latestUser || latestUser.type !== "user_message") {
    return null;
  }
  const request = latestUser.text.trim();
  let reason =
    "cannot be resumed safely because Claude rejected the saved native session before doing new work";
  if (input.failureKind === "context_overflow") {
    reason = "reached its context limit";
  } else if (input.failureKind === "conversation_unresolved") {
    reason = "cannot be continued safely because its prior request has unresolved delivery state";
  }
  const prefix =
    `<paseo-system>\nThe previous native Claude session ${reason}. ` +
    "Continue the unfinished work in this fresh session. Do not repeat completed work.\n\n" +
    "Outstanding user request:\n";
  const stateHeader = "\n\nRecent working state:\n";
  const suffix = "\n</paseo-system>";
  const minimum = `${prefix}${request}${stateHeader}No provider work was recorded after the request.${suffix}`;
  if (minimum.length > maxChars) {
    return null;
  }

  const stateEntries = projected
    .slice(latestUserIndex + 1)
    .map((entry) => formatContextOverflowStateEntry(entry.item))
    .filter((entry): entry is string => Boolean(entry));
  if (stateEntries.length === 0) {
    return minimum;
  }

  const fixedLength = prefix.length + request.length + stateHeader.length + suffix.length;
  const selected: string[] = [];
  let remaining = maxChars - fixedLength;
  for (let index = stateEntries.length - 1; index >= 0; index -= 1) {
    const entry = stateEntries[index];
    if (!entry) {
      continue;
    }
    const separatorLength = selected.length > 0 ? 2 : 0;
    if (entry.length + separatorLength > remaining) {
      continue;
    }
    selected.unshift(entry);
    remaining -= entry.length + separatorLength;
  }

  const state = selected.length > 0 ? selected.join("\n\n") : "No bounded state fit.";
  const prompt = `${prefix}${request}${stateHeader}${state}${suffix}`;
  return prompt.length <= maxChars ? prompt : null;
}

function inputFromUnknownDetail(
  detail: Extract<AgentTimelineItem, { type: "tool_call" }>["detail"],
): unknown {
  return detail.type === "unknown" ? detail.input : null;
}

function projectForCuration(items: readonly AgentTimelineItem[]): AgentTimelineItem[] {
  const rows = items.map((item, index) => ({
    seq: index + 1,
    timestamp: "",
    item,
  }));
  return projectTimelineRows({ rows, mode: "projected" }).map((entry) => entry.item);
}

function shouldIncludeItem(item: AgentTimelineItem, options?: ActivityCuratorOptions): boolean {
  if (!options?.includeKinds) {
    return true;
  }
  return options.includeKinds.includes(item.type);
}

function formatToolCallEntry(
  item: Extract<AgentTimelineItem, { type: "tool_call" }>,
  options?: ActivityCuratorOptions,
): ActivityEntry {
  const inputJson = formatToolInputJson(inputFromUnknownDetail(item.detail));
  const display = buildToolCallDisplayModel({
    name: item.name,
    status: item.status,
    error: item.error,
    detail: item.detail,
    metadata: item.metadata,
  });
  const displayName = display.displayName;
  const summary = formatToolSummary(display.summary);
  if (
    (options?.includeExternalToolInput ?? true) &&
    isLikelyExternalToolName(item.name) &&
    inputJson
  ) {
    return activityEntry(`[${displayName}] ${inputJson}`);
  }
  return activityEntry(summary ? `[${displayName}] ${summary}` : `[${displayName}]`);
}

function curateProjectedActivityEntries(
  items: readonly AgentTimelineItem[],
  options?: ActivityCuratorOptions,
): ActivityEntry[] {
  if (items.length === 0) {
    return [];
  }

  const maxItems = options?.maxItems ?? DEFAULT_MAX_ITEMS;
  const recentItems = maxItems > 0 && items.length > maxItems ? items.slice(-maxItems) : items;

  const entries: ActivityEntry[] = [];
  const buffers = { message: "", thought: "" };

  for (const item of recentItems) {
    if (!shouldIncludeItem(item, options)) {
      continue;
    }

    switch (item.type) {
      case "user_message":
        flushBuffers(entries, buffers, options);
        entries.push(activityEntry(`[User] ${item.text.trim()}`));
        break;
      case "assistant_message":
        buffers.message = appendText(buffers.message, item.text);
        break;
      case "reasoning":
        buffers.thought = appendText(buffers.thought, item.text);
        break;
      case "tool_call": {
        flushBuffers(entries, buffers, options);
        entries.push(formatToolCallEntry(item, options));
        if (item.detail.type === "sub_agent" && item.detail.log.trim()) {
          entries.push(activityEntry(item.detail.log.trim()));
        }
        break;
      }
      case "todo":
        flushBuffers(entries, buffers, options);
        entries.push(activityEntry("[Tasks]"));
        for (const entry of item.items) {
          const checkbox = entry.completed ? "[x]" : "[ ]";
          const text = `- ${checkbox} ${entry.text}`;
          entries.push(activityEntry(text));
        }
        break;
      case "error":
        flushBuffers(entries, buffers, options);
        entries.push(activityEntry(`[Error] ${item.message}`));
        break;
      case "compaction":
        flushBuffers(entries, buffers, options);
        entries.push(activityEntry("[Compacted]"));
        break;
    }
  }

  flushBuffers(entries, buffers, options);

  return entries;
}

function curateAgentActivityEntries(
  timeline: AgentTimelineItem[],
  options?: ActivityCuratorOptions,
): ActivityEntry[] {
  const collapsed = projectForCuration(timeline);
  return curateProjectedActivityEntries(collapsed, options);
}

/**
 * Convert normalized agent timeline items into a concise text summary.
 */
export function curateAgentActivity(
  timeline: AgentTimelineItem[],
  options?: ActivityCuratorOptions,
): string {
  const entries = curateAgentActivityEntries(timeline, options);
  return entries.length > 0
    ? entries.map((entry) => entry.text).join("\n")
    : "No activity to display.";
}

interface ForkCursorBoundary {
  timelineEpoch: string;
  cursor: { epoch: string; seq: number };
}

function selectForkContextRows(input: {
  rows: readonly AgentTimelineRow[];
  cursorBoundary?: ForkCursorBoundary | null;
  boundaryMessageId?: string | null;
}): {
  items: AgentTimelineItem[];
  boundaryCursor: { epoch: string; seq: number } | null;
  boundaryMessageId: string | null;
} {
  const boundaryCursor = input.cursorBoundary?.cursor ?? null;
  const boundaryMessageId = input.boundaryMessageId?.trim() || null;
  if (!boundaryCursor && !boundaryMessageId) {
    const projected = projectTimelineRows({ rows: input.rows, mode: "projected" });
    return {
      items: projected.map((entry) => entry.item),
      boundaryCursor: null,
      boundaryMessageId: null,
    };
  }

  if (
    input.cursorBoundary &&
    input.cursorBoundary.cursor.epoch !== input.cursorBoundary.timelineEpoch
  ) {
    throw new Error("Selected timeline position is no longer available.");
  }
  const boundaryIndex = boundaryCursor
    ? input.rows.findIndex((row) => row.seq === boundaryCursor.seq)
    : input.rows.findLastIndex(
        (row) => row.item.type === "assistant_message" && row.item.messageId === boundaryMessageId,
      );
  if (boundaryIndex < 0) {
    throw new Error(
      boundaryCursor
        ? "Selected timeline position is no longer available."
        : "Selected assistant message is no longer available.",
    );
  }
  const selectedRows = input.rows.slice(0, boundaryIndex + 1);
  const projected = projectTimelineRows({ rows: selectedRows, mode: "projected" });

  return {
    items: projected.map((entry) => entry.item),
    boundaryCursor,
    boundaryMessageId,
  };
}

function trimContextMetadata(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function buildForkContextText(input: {
  body: string;
  agentTitle?: string | null;
  cwd?: string | null;
}): string {
  const header = ["Chat history from a previous Paseo agent."];
  const agentTitle = trimContextMetadata(input.agentTitle);
  const cwd = trimContextMetadata(input.cwd);
  if (agentTitle) {
    header.push(`Source agent: ${agentTitle}`);
  }
  if (cwd) {
    header.push(`Source directory: ${cwd}`);
  }
  return `<chat-history-summary>\n${header.join("\n")}\n\n${input.body}\n</chat-history-summary>`;
}

export function buildAgentForkContextAttachment(input: {
  rows: readonly AgentTimelineRow[];
  cursorBoundary?: ForkCursorBoundary | null;
  boundaryMessageId?: string | null;
  agentTitle?: string | null;
  cwd?: string | null;
}): {
  attachment: TextAgentAttachment;
  itemCount: number;
  boundaryCursor: { epoch: string; seq: number } | null;
  boundaryMessageId: string | null;
} {
  const selected = selectForkContextRows({
    rows: input.rows,
    cursorBoundary: input.cursorBoundary,
    boundaryMessageId: input.boundaryMessageId,
  });
  const entries = curateProjectedActivityEntries(selected.items, {
    maxItems: 0,
    labelAssistantMessages: true,
    includeKinds: ["user_message", "assistant_message", "tool_call"],
    includeExternalToolInput: false,
  });
  const body =
    entries.length > 0
      ? entries.map((entry) => entry.text).join("\n")
      : "No chat history to display.";
  return {
    attachment: {
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: "Chat history",
      text: buildForkContextText({
        body,
        agentTitle: input.agentTitle,
        cwd: input.cwd,
      }),
    },
    itemCount: selected.items.length,
    boundaryCursor: selected.boundaryCursor,
    boundaryMessageId: selected.boundaryMessageId,
  };
}
