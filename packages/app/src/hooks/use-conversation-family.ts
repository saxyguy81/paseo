import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  CONVERSATION_FAMILY_ID_LABEL,
  parseConversationFamilyLabels,
  stitchConversationFamilyTimeline,
  type ConversationFamilyTimelineMember,
} from "@/conversation-family";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { planTimelineOlderFetch, planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
import type { StreamItem } from "@/types/stream";

const FAMILY_HISTORY_PAGE_LIMIT = 200;
const EMPTY_TIMELINE_TAILS = new Map<string, StreamItem[]>();
const EMPTY_FAMILY_MEMBERS: ConversationFamilyMember[] = [];

export interface ConversationFamilyMember {
  agentId: string;
  title: string;
  position: number;
}

async function fetchConversationFamilyMembers(input: {
  client: Pick<DaemonClient, "fetchAgentHistory">;
  familyId: string;
}): Promise<ConversationFamilyMember[]> {
  const members: ConversationFamilyMember[] = [];
  let cursor: string | undefined;

  do {
    const page = await input.client.fetchAgentHistory({
      filter: {
        labels: { [CONVERSATION_FAMILY_ID_LABEL]: input.familyId },
        includeArchived: true,
      },
      sort: [{ key: "created_at", direction: "asc" }],
      page: { limit: FAMILY_HISTORY_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    });
    for (const entry of page.entries) {
      const metadata = parseConversationFamilyLabels(entry.agent.labels);
      if (!metadata || metadata.id !== input.familyId || metadata.hidden) continue;
      members.push({
        agentId: entry.agent.id,
        title: entry.agent.title?.trim() || metadata.name,
        position: metadata.position,
      });
    }
    cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);

  return members.sort((left, right) => left.position - right.position);
}

async function loadCompleteAgentTimeline(serverId: string, agentId: string): Promise<void> {
  const runtime = getHostRuntimeStore();
  let page = await runtime.fetchAgentTimeline(serverId, agentId, planTimelineTailFetch());
  const seenCursors = new Set<string>();

  while (page.hasOlder && page.startCursor) {
    const cursorKey = `${page.startCursor.epoch}:${page.startCursor.seq}`;
    if (seenCursors.has(cursorKey)) {
      throw new Error(`Timeline cursor did not advance for ${agentId}`);
    }
    seenCursors.add(cursorKey);
    page = await runtime.fetchAgentTimeline(
      serverId,
      agentId,
      planTimelineOlderFetch(page.startCursor),
    );
  }
}

export interface ConversationFamilyView {
  familyId: string;
  name: string;
  memberCount: number;
  streamItems: StreamItem[];
  readOnlyItemIds: ReadonlySet<string>;
  isLoading: boolean;
  error: string | null;
}

/**
 * Loads every immutable predecessor of the selected session, then presents the
 * stored timelines as one local view. Only the family-designated current
 * session is eligible, so opening an old route can never accept a new prompt.
 */
export function useConversationFamily(input: {
  serverId: string;
  agentId: string;
  labels?: Record<string, string>;
}): ConversationFamilyView | null {
  const { t } = useTranslation();
  const metadata = useMemo(() => parseConversationFamilyLabels(input.labels), [input.labels]);
  const isCurrent = metadata?.currentAgentId === input.agentId;
  const client = getHostRuntimeStore().getClient(input.serverId);
  const membersQuery = useFetchQuery({
    queryKey: ["conversation-family-members", input.serverId, metadata?.id],
    queryFn: async () => {
      if (!client || !metadata) throw new Error("Paseo daemon is unavailable");
      return await fetchConversationFamilyMembers({ client, familyId: metadata.id });
    },
    enabled: Boolean(isCurrent && client && metadata),
    retry: false,
    staleTimeMs: 30_000,
    dataShape: "list",
  });
  const members = membersQuery.data ?? EMPTY_FAMILY_MEMBERS;
  const memberKey = members.map((member) => member.agentId).join(":");
  const [timelineLoad, setTimelineLoad] = useState<{
    key: string;
    status: "idle" | "loading" | "ready" | "error";
    error: string | null;
  }>({ key: "", status: "idle", error: null });

  useEffect(() => {
    if (!isCurrent || members.length === 0) return;
    let cancelled = false;
    setTimelineLoad({ key: memberKey, status: "loading", error: null });
    void (async () => {
      try {
        await Promise.all(
          members.map((member) => loadCompleteAgentTimeline(input.serverId, member.agentId)),
        );
        if (!cancelled) setTimelineLoad({ key: memberKey, status: "ready", error: null });
      } catch (error) {
        if (cancelled) return;
        setTimelineLoad({
          key: memberKey,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [input.serverId, isCurrent, memberKey, members]);

  const tails = useSessionStore(
    (state) => state.sessions[input.serverId]?.agentStreamTail ?? EMPTY_TIMELINE_TAILS,
  );
  const stitched = useMemo(() => {
    if (!metadata || !isCurrent || members.length === 0) return null;
    const timelineMembers: ConversationFamilyTimelineMember[] = members.map((member) => ({
      ...member,
      items: tails.get(member.agentId) ?? [],
    }));
    return stitchConversationFamilyTimeline({
      currentAgentId: metadata.currentAgentId,
      members: timelineMembers,
      formatBoundary: ({ member, index }) =>
        t(
          index === 0
            ? "agentStream.family.conversationStarted"
            : "agentStream.family.continuedInNewSession",
          { title: member.title },
        ),
    });
  }, [isCurrent, members, metadata, t, tails]);

  if (!metadata || !isCurrent) return null;
  return {
    familyId: metadata.id,
    name: metadata.name,
    memberCount: Math.max(1, members.length),
    streamItems: stitched?.items ?? [],
    readOnlyItemIds: stitched?.readOnlyItemIds ?? new Set<string>(),
    isLoading:
      membersQuery.isPending ||
      (timelineLoad.key === memberKey && timelineLoad.status === "loading"),
    error:
      (membersQuery.error instanceof Error ? membersQuery.error.message : null) ??
      (timelineLoad.key === memberKey ? timelineLoad.error : null),
  };
}
