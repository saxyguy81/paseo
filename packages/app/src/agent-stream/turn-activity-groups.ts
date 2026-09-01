import type { StreamItem } from "@/types/stream";
import type { StreamLayoutItem } from "./layout";
import { continuesTurn } from "./turn-membership";

export interface TurnActivityGroup {
  id: string;
  hostItemId: string;
  memberItemIds: string[];
  members: StreamLayoutItem[];
}

export interface TurnActivityGroupMembership {
  group: TurnActivityGroup;
  isHost: boolean;
}

export interface TurnActivityGroups {
  groups: TurnActivityGroup[];
  byItemId: Map<string, TurnActivityGroupMembership>;
}

function isConversationFamilyBoundary(item: StreamItem): boolean {
  return item.kind === "activity_log" && item.id.startsWith("family-boundary:");
}

function isCollapsibleActivity(item: StreamItem): boolean {
  return item.kind !== "user_message" && !isConversationFamilyBoundary(item);
}

function hasSubstantiveWork(items: readonly StreamLayoutItem[]): boolean {
  return (
    items.length > 1 ||
    items.some(({ item }) => item.kind !== "assistant_message" && item.kind !== "activity_log")
  );
}

function orderChronologically(layoutItems: readonly StreamLayoutItem[]): StreamLayoutItem[] {
  if (layoutItems.length < 2) {
    return [...layoutItems];
  }

  const byId = new Map(layoutItems.map((layoutItem) => [layoutItem.item.id, layoutItem]));
  const ordered: StreamLayoutItem[] = [];
  const visited = new Set<string>();
  let current = layoutItems.find(({ aboveItem }) => aboveItem === null || !byId.has(aboveItem.id));

  while (current && !visited.has(current.item.id)) {
    ordered.push(current);
    visited.add(current.item.id);
    current = current.belowItem ? byId.get(current.belowItem.id) : undefined;
  }

  if (ordered.length === layoutItems.length) {
    return ordered;
  }

  // A partially loaded legacy timeline can be disconnected at an old pagination
  // boundary. Preserve its stable source order instead of dropping those rows.
  for (const layoutItem of layoutItems) {
    if (!visited.has(layoutItem.item.id)) {
      ordered.push(layoutItem);
    }
  }
  return ordered;
}

function splitIntoTurns(items: readonly StreamLayoutItem[]): StreamLayoutItem[][] {
  const turns: StreamLayoutItem[][] = [];
  let currentTurn: StreamLayoutItem[] = [];

  for (const layoutItem of items) {
    const previous = currentTurn.at(-1);
    if (previous && !continuesTurn(previous.item, layoutItem.item)) {
      turns.push(currentTurn);
      currentTurn = [];
    }
    currentTurn.push(layoutItem);
  }

  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }
  return turns;
}

function collectActivityRuns(turn: readonly StreamLayoutItem[]): StreamLayoutItem[][] {
  if (turn.at(-1)?.item.kind !== "assistant_message") {
    return [];
  }

  let finalAnswerStart = turn.length - 1;
  while (finalAnswerStart > 0 && turn[finalAnswerStart - 1]?.item.kind === "assistant_message") {
    finalAnswerStart -= 1;
  }

  const runs: StreamLayoutItem[][] = [];
  let currentRun: StreamLayoutItem[] = [];
  for (const layoutItem of turn.slice(0, finalAnswerStart)) {
    if (isCollapsibleActivity(layoutItem.item)) {
      currentRun.push(layoutItem);
      continue;
    }
    if (hasSubstantiveWork(currentRun)) {
      runs.push(currentRun);
    }
    currentRun = [];
  }
  if (hasSubstantiveWork(currentRun)) {
    runs.push(currentRun);
  }
  return runs;
}

/**
 * Groups completed-turn work while leaving prompts, final answers, family
 * boundaries, unfinished turns, and the live head untouched.
 */
export function buildTurnActivityGroups(
  historyLayout: readonly StreamLayoutItem[],
): TurnActivityGroups {
  const groups: TurnActivityGroup[] = [];
  const byItemId = new Map<string, TurnActivityGroupMembership>();
  const turns = splitIntoTurns(orderChronologically(historyLayout));

  for (const turn of turns) {
    for (const members of collectActivityRuns(turn)) {
      const host = members[0];
      const finalItem = turn.at(-1);
      if (!host || !finalItem) {
        continue;
      }
      const turnIdentity = finalItem.item.turnId ?? finalItem.item.id;
      const group: TurnActivityGroup = {
        id: `turn-work:${turnIdentity}:${host.item.id}`,
        hostItemId: host.item.id,
        memberItemIds: members.map(({ item }) => item.id),
        members,
      };
      groups.push(group);
      for (const member of members) {
        byItemId.set(member.item.id, {
          group,
          isHost: member.item.id === group.hostItemId,
        });
      }
    }
  }

  return { groups, byItemId };
}
