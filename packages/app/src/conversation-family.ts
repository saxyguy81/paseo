import type { AgentSearchMatch } from "@getpaseo/protocol/messages";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { StreamItem } from "@/types/stream";
import { isGroupableToolCall } from "@/tool-calls/detail-level/grouping";

export const CONVERSATION_FAMILY_ID_LABEL = "paseo.family.id";
export const CONVERSATION_FAMILY_CURRENT_LABEL = "paseo.family.current";
export const CONVERSATION_FAMILY_NAME_LABEL = "paseo.family.name";
export const CONVERSATION_FAMILY_POSITION_LABEL = "paseo.family.position";
export const CONVERSATION_FAMILY_HIDDEN_LABEL = "paseo.family.hidden";

export interface ConversationFamilyMetadata {
  id: string;
  currentAgentId: string;
  name: string;
  position: number;
  hidden: boolean;
}

export function parseConversationFamilyLabels(
  labels: Record<string, string> | null | undefined,
): ConversationFamilyMetadata | null {
  const id = labels?.[CONVERSATION_FAMILY_ID_LABEL]?.trim();
  const currentAgentId = labels?.[CONVERSATION_FAMILY_CURRENT_LABEL]?.trim();
  const name = labels?.[CONVERSATION_FAMILY_NAME_LABEL]?.trim();
  const rawPosition = labels?.[CONVERSATION_FAMILY_POSITION_LABEL]?.trim();
  const position = rawPosition === undefined ? Number.NaN : Number(rawPosition);
  if (!id || !currentAgentId || !name || !Number.isInteger(position) || position < 0) {
    return null;
  }
  return {
    id,
    currentAgentId,
    name,
    position,
    hidden: Boolean(labels?.[CONVERSATION_FAMILY_HIDDEN_LABEL]?.trim()),
  };
}

interface CollapsedConversationFamilies {
  agents: AggregatedAgent[];
  searchMatchesByAgentKey: Record<string, AgentSearchMatch[]>;
  memberCountByAgentKey: Record<string, number>;
}

function rowKey(agent: Pick<AggregatedAgent, "serverId" | "id">): string {
  return `${agent.serverId}:${agent.id}`;
}

interface ConversationFamilyIndex {
  familyMembers: Map<string, AggregatedAgent[]>;
  metadataByAgentKey: Map<string, ConversationFamilyMetadata>;
}

function indexConversationFamilies(agents: readonly AggregatedAgent[]): ConversationFamilyIndex {
  const familyMembers = new Map<string, AggregatedAgent[]>();
  const metadataByAgentKey = new Map<string, ConversationFamilyMetadata>();

  for (const agent of agents) {
    const metadata = parseConversationFamilyLabels(agent.labels);
    if (!metadata || metadata.hidden) continue;
    const familyKey = `${agent.serverId}:${metadata.id}`;
    const members = familyMembers.get(familyKey) ?? [];
    members.push(agent);
    familyMembers.set(familyKey, members);
    metadataByAgentKey.set(rowKey(agent), metadata);
  }

  return { familyMembers, metadataByAgentKey };
}

function buildFamilyRepresentatives(index: ConversationFamilyIndex): Map<string, AggregatedAgent> {
  const representatives = new Map<string, AggregatedAgent>();
  for (const [familyKey, members] of index.familyMembers) {
    const metadata = index.metadataByAgentKey.get(rowKey(members[0]));
    if (!metadata) continue;
    const current = members.find((member) => member.id === metadata.currentAgentId);
    const source = current ?? members[0];
    representatives.set(familyKey, {
      ...source,
      id: metadata.currentAgentId,
      title: metadata.name,
      // A server-side search can return only an older member from a different
      // workspace. Let navigateToAgent resolve the current session's workspace
      // by id instead of routing that id through the older member's workspace.
      workspaceId: current?.workspaceId,
    });
  }
  return representatives;
}

/**
 * Replaces a set of related history rows with the one session that accepts new
 * prompts. A search result may contain only an older member, so every member
 * carries the current id and can still route to the right conversation.
 */
export function collapseConversationFamilies(input: {
  agents: readonly AggregatedAgent[];
  searchMatchesByAgentKey?: Record<string, AgentSearchMatch[]>;
}): CollapsedConversationFamilies {
  const { familyMembers, metadataByAgentKey } = indexConversationFamilies(input.agents);
  const representativeByFamilyKey = buildFamilyRepresentatives({
    familyMembers,
    metadataByAgentKey,
  });

  const emittedFamilies = new Set<string>();
  const agents: AggregatedAgent[] = [];
  const searchMatchesByAgentKey: Record<string, AgentSearchMatch[]> = {};
  const memberCountByAgentKey: Record<string, number> = {};

  for (const agent of input.agents) {
    const metadata = parseConversationFamilyLabels(agent.labels);
    if (metadata?.hidden) continue;
    if (!metadata) {
      agents.push(agent);
      const key = rowKey(agent);
      const matches = input.searchMatchesByAgentKey?.[key];
      if (matches) searchMatchesByAgentKey[key] = matches;
      continue;
    }

    const familyKey = `${agent.serverId}:${metadata.id}`;
    const representative = representativeByFamilyKey.get(familyKey);
    const representativeAppearsHere = agent.id === metadata.currentAgentId;
    const currentMissing = !familyMembers
      .get(familyKey)
      ?.some((member) => member.id === metadata.currentAgentId);
    if (
      !representative ||
      emittedFamilies.has(familyKey) ||
      (!representativeAppearsHere && !currentMissing)
    ) {
      continue;
    }

    emittedFamilies.add(familyKey);
    agents.push(representative);
    const representativeKey = rowKey(representative);
    memberCountByAgentKey[representativeKey] = familyMembers.get(familyKey)?.length ?? 1;
    const matches = (familyMembers.get(familyKey) ?? []).flatMap(
      (member) => input.searchMatchesByAgentKey?.[rowKey(member)] ?? [],
    );
    if (matches.length > 0) searchMatchesByAgentKey[representativeKey] = matches;
  }

  return { agents, searchMatchesByAgentKey, memberCountByAgentKey };
}

export interface ConversationFamilyTimelineMember {
  agentId: string;
  title: string;
  position: number;
  items: readonly StreamItem[];
}

export interface StitchedConversationFamilyTimeline {
  items: StreamItem[];
  readOnlyItemIds: ReadonlySet<string>;
}

function namespaceHistoricalItem(item: StreamItem, agentId: string): StreamItem {
  const namespace = (value: string) => `family:${agentId}:${value}`;
  if (item.kind === "user_message") {
    return {
      ...item,
      id: namespace(item.id),
      timelineCursor: undefined,
      ...(item.turnId ? { turnId: namespace(item.turnId) } : {}),
      clientMessageId: undefined,
      messageId: undefined,
    };
  }
  if (item.kind === "assistant_message") {
    return {
      ...item,
      id: namespace(item.id),
      timelineCursor: undefined,
      ...(item.turnId ? { turnId: namespace(item.turnId) } : {}),
      messageId: undefined,
      ...(item.blockGroupId ? { blockGroupId: namespace(item.blockGroupId) } : {}),
    };
  }
  return {
    ...item,
    id: namespace(item.id),
    timelineCursor: undefined,
    ...(item.turnId ? { turnId: namespace(item.turnId) } : {}),
  };
}

/** Builds one renderable timeline without mutating any stored or native transcript. */
export function stitchConversationFamilyTimeline(input: {
  currentAgentId: string;
  members: readonly ConversationFamilyTimelineMember[];
  formatBoundary?: (input: { member: ConversationFamilyTimelineMember; index: number }) => string;
}): StitchedConversationFamilyTimeline {
  const items: StreamItem[] = [];
  const readOnlyItemIds = new Set<string>();
  const members = [...input.members].sort((left, right) => left.position - right.position);

  for (const [index, member] of members.entries()) {
    const firstTimestamp = member.items[0]?.timestamp ?? new Date(0);
    const boundary: StreamItem = {
      kind: "activity_log",
      id: `family-boundary:${member.agentId}`,
      timestamp: firstTimestamp,
      activityType: "system",
      message:
        input.formatBoundary?.({ member, index }) ??
        (index === 0
          ? `Conversation started in “${member.title}”`
          : `Continued in a new session: “${member.title}”`),
    };
    items.push(boundary);
    if (member.agentId !== input.currentAgentId) readOnlyItemIds.add(boundary.id);

    for (const sourceItem of member.items) {
      const item =
        member.agentId === input.currentAgentId
          ? sourceItem
          : namespaceHistoricalItem(sourceItem, member.agentId);
      items.push(item);
      if (member.agentId !== input.currentAgentId) readOnlyItemIds.add(item.id);
    }
  }

  return { items, readOnlyItemIds };
}

export interface ConversationFamilySearchMatch {
  itemId: string;
  kind: StreamItem["kind"];
}

function searchableText(item: StreamItem, includeToolActivity: boolean): string | null {
  switch (item.kind) {
    case "user_message":
    case "assistant_message":
      return item.text;
    case "thought":
      return includeToolActivity ? item.text : null;
    case "tool_call":
      return includeToolActivity ? JSON.stringify(item.payload) : null;
    case "todo_list":
    case "activity_log":
    case "compaction":
      return includeToolActivity ? JSON.stringify(item) : null;
  }
}

export function searchConversationFamily(
  items: readonly StreamItem[],
  query: string,
  options?: { includeToolActivity?: boolean },
): ConversationFamilySearchMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const includeToolActivity = options?.includeToolActivity === true;
  const matches: ConversationFamilySearchMatch[] = [];
  let toolGroupHostId: string | null = null;
  let toolGroupMatched = false;

  for (const item of items) {
    if (isGroupableToolCall(item)) {
      toolGroupHostId ??= item.id;
      const text = searchableText(item, includeToolActivity);
      if (!toolGroupMatched && text?.toLocaleLowerCase().includes(needle)) {
        matches.push({ itemId: toolGroupHostId, kind: item.kind });
        toolGroupMatched = true;
      }
      continue;
    }

    toolGroupHostId = null;
    toolGroupMatched = false;
    const text = searchableText(item, includeToolActivity);
    if (text?.toLocaleLowerCase().includes(needle)) {
      matches.push({ itemId: item.id, kind: item.kind });
    }
  }

  return matches;
}
