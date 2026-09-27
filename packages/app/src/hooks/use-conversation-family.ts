import { useCallback, useEffect, useMemo, useState } from "react";
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
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
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

export interface ConversationFamilyView {
  familyId: string;
  name: string;
  memberCount: number;
  streamItems: StreamItem[];
  readOnlyItemIds: ReadonlySet<string>;
  isLoading: boolean;
  error: string | null;
  hasOlder: boolean;
  progressKey: string;
  loadOlder: () => Promise<boolean>;
}

/**
 * Pages backwards through one session at a time. Search may explicitly request
 * the complete family, but mounting or expanding the toolbar never does.
 */
export function useConversationFamily(input: {
  serverId: string;
  agentId: string;
  labels?: Record<string, string>;
  loadHistory?: boolean;
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
  const { pager, loadOlder } = useFamilyHistoryPager({
    serverId: input.serverId,
    agentId: input.agentId,
    isCurrent,
    members,
    loadHistory: input.loadHistory,
  });

  const session = useSessionStore((state) => state.sessions[input.serverId]);
  const tails = session?.agentStreamTail ?? EMPTY_TIMELINE_TAILS;
  const visible = pager.visible;
  const stitched = useMemo(() => {
    if (!metadata || !isCurrent || members.length === 0) return null;
    // Keep the live view until its initial tail is available.
    if (!tails.get(input.agentId)?.length) return null;
    const timelineMembers: ConversationFamilyTimelineMember[] = members
      .filter((member) => visible.has(member.agentId))
      .map((member) => ({
        agentId: member.agentId,
        title: member.title,
        position: member.position,
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
  }, [input.agentId, isCurrent, members, metadata, t, tails, visible]);

  const pagination = familyPaginationState(session, members, visible, input.agentId);

  if (!metadata || !isCurrent) return null;
  return {
    familyId: metadata.id,
    name: metadata.name,
    memberCount: Math.max(1, members.length),
    streamItems: stitched?.items ?? [],
    readOnlyItemIds: stitched?.readOnlyItemIds ?? new Set<string>(),
    isLoading: membersQuery.isPending || pager.pending !== null,
    hasOlder: pagination.hasOlder,
    progressKey: pagination.progressKey,
    loadOlder,
    error: (membersQuery.error instanceof Error ? membersQuery.error.message : null) ?? pager.error,
  };
}

function familyPaginationState(
  session: Parameters<typeof selectAgentTimelineState>[0],
  members: ConversationFamilyMember[],
  visible: ReadonlySet<string>,
  currentAgentId: string,
) {
  const first = members.findIndex((member) => visible.has(member.agentId));
  const oldest = first >= 0 ? selectAgentTimelineState(session, members[first].agentId) : null;
  const range = oldest?.status === "synced" ? oldest.range : null;
  return {
    hasOlder: oldest?.status === "synced" && (first > 0 || oldest.older === "available"),
    progressKey: `${members[first]?.agentId ?? currentAgentId}:${range?.epoch ?? ""}:${range?.startSeq ?? ""}`,
  };
}

/** Owns family page admission; consumers only request one older page. */
function useFamilyHistoryPager(input: {
  serverId: string;
  agentId: string;
  isCurrent: boolean;
  members: ConversationFamilyMember[];
  loadHistory?: boolean;
}) {
  const { members, isCurrent } = input;
  const pager = useMemo(
    () => ({
      serverId: input.serverId,
      visible: new Set([input.agentId]),
      pending: null as Promise<boolean> | null,
      error: null as string | null,
    }),
    [input.serverId, input.agentId],
  );
  const [, refresh] = useState(0);
  const loadOlder = useCallback((): Promise<boolean> => {
    if (pager.pending) return pager.pending;
    if (!isCurrent || !members.length) return Promise.resolve(false);
    const first = members.findIndex((member) => pager.visible.has(member.agentId));
    if (first < 0) return Promise.resolve(false);
    const oldest = members[first];
    const timeline = selectAgentTimelineState(
      useSessionStore.getState().sessions[input.serverId],
      oldest.agentId,
    );
    const cursor =
      timeline.status === "synced" && timeline.older === "available" ? timeline.range : null;
    const target = timeline.status !== "synced" || cursor ? oldest : members[first - 1];
    if (!target) return Promise.resolve(false);
    const request = cursor
      ? planTimelineOlderFetch({ epoch: cursor.epoch, seq: cursor.startSeq })
      : planTimelineTailFetch();
    pager.error = null;
    pager.pending = (async () => {
      try {
        const page = await getHostRuntimeStore().fetchAgentTimeline(
          input.serverId,
          target.agentId,
          request,
        );
        if (page.error) throw new Error(page.error);
        if (
          cursor &&
          page.hasOlder &&
          page.startCursor?.epoch === cursor.epoch &&
          page.startCursor.seq >= cursor.startSeq
        ) {
          throw new Error("History cursor did not advance");
        }
        pager.visible = new Set([...pager.visible, target.agentId]);
        return true;
      } catch (error) {
        pager.error = error instanceof Error ? error.message : String(error);
        return false;
      } finally {
        pager.pending = null;
        refresh((value) => value + 1);
      }
    })();
    refresh((value) => value + 1);
    return pager.pending;
  }, [input.serverId, isCurrent, members, pager]);

  useEffect(() => {
    if (!input.loadHistory) return;
    let cancelled = false;
    void (async () => {
      for (;;) {
        if (cancelled || !(await loadOlder())) break;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [input.loadHistory, loadOlder]);

  return { pager, loadOlder };
}
