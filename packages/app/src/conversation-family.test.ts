import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { StreamItem } from "@/types/stream";
import {
  CONVERSATION_FAMILY_CURRENT_LABEL,
  CONVERSATION_FAMILY_HIDDEN_LABEL,
  CONVERSATION_FAMILY_ID_LABEL,
  CONVERSATION_FAMILY_NAME_LABEL,
  CONVERSATION_FAMILY_POSITION_LABEL,
  collapseConversationFamilies,
  findSupersededConversationFamilyWorkspaceKeys,
  parseConversationFamilyLabels,
  searchConversationFamily,
  stitchConversationFamilyTimeline,
} from "./conversation-family";

function agent(input: {
  id: string;
  title: string;
  labels?: Record<string, string>;
  updatedAt?: string;
  workspaceId?: string;
}): AggregatedAgent {
  const updatedAt = new Date(input.updatedAt ?? "2026-08-26T12:00:00.000Z");
  return {
    id: input.id,
    serverId: "server-1",
    serverLabel: "Mac mini",
    title: input.title,
    status: "idle",
    lastActivityAt: updatedAt,
    cwd: "/repo",
    workspaceId: input.workspaceId,
    provider: "claude",
    pendingPermissionCount: 0,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    createdAt: updatedAt,
    labels: input.labels ?? {},
    projectPlacement: {
      projectKey: "/repo",
      projectName: "repo",
      checkout: {
        cwd: "/repo",
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

function familyLabels(
  input: {
    id?: string;
    current?: string;
    name?: string;
    position?: number;
    hidden?: boolean;
  } = {},
): Record<string, string> {
  return {
    [CONVERSATION_FAMILY_ID_LABEL]: input.id ?? "family-vclp",
    [CONVERSATION_FAMILY_CURRENT_LABEL]: input.current ?? "current",
    [CONVERSATION_FAMILY_NAME_LABEL]: input.name ?? "VCLP complexity",
    [CONVERSATION_FAMILY_POSITION_LABEL]: String(input.position ?? 0),
    ...(input.hidden ? { [CONVERSATION_FAMILY_HIDDEN_LABEL]: "duplicate" } : {}),
  };
}

function message(
  kind: "user_message" | "assistant_message" | "thought",
  id: string,
  text: string,
): StreamItem {
  const timestamp = new Date("2026-08-26T12:00:00.000Z");
  if (kind === "thought") {
    return { kind, id, text, timestamp, status: "ready" };
  }
  return { kind, id, text, timestamp };
}

describe("conversation families", () => {
  it("parses valid family labels and rejects incomplete metadata", () => {
    expect(parseConversationFamilyLabels(familyLabels({ position: 2 }))).toEqual({
      id: "family-vclp",
      currentAgentId: "current",
      name: "VCLP complexity",
      position: 2,
      hidden: false,
    });
    expect(
      parseConversationFamilyLabels({ [CONVERSATION_FAMILY_ID_LABEL]: "family-vclp" }),
    ).toBeNull();
  });

  it("collapses family members into the canonical current row", () => {
    const original = agent({
      id: "original",
      title: "VCLP original",
      labels: familyLabels({ position: 0 }),
      updatedAt: "2026-08-24T12:00:00.000Z",
    });
    const current = agent({
      id: "current",
      title: "VCLP recovery",
      labels: familyLabels({ position: 2 }),
      workspaceId: "current-workspace",
      updatedAt: "2026-08-26T12:00:00.000Z",
    });
    const unrelated = agent({ id: "other", title: "Other" });

    const result = collapseConversationFamilies({ agents: [original, unrelated, current] });

    expect(result.agents.map((candidate) => candidate.id)).toEqual(["other", "current"]);
    expect(result.agents.find((candidate) => candidate.id === "current")?.title).toBe(
      "VCLP complexity",
    );
    expect(result.agents.find((candidate) => candidate.id === "current")?.workspaceId).toBe(
      "current-workspace",
    );
    expect(result.memberCountByAgentKey["server-1:current"]).toBe(2);
  });

  it("routes a search hit on an older member to the canonical current session", () => {
    const original = agent({
      id: "original",
      title: "VCLP original",
      labels: familyLabels({ position: 0 }),
      workspaceId: "old-workspace",
    });
    const matches = {
      "server-1:original": [{ field: "title" as const, ranges: [{ start: 0, length: 4 }] }],
    };

    const result = collapseConversationFamilies({
      agents: [original],
      searchMatchesByAgentKey: matches,
    });

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({ id: "current", title: "VCLP complexity" });
    expect(result.agents[0]?.workspaceId).toBeUndefined();
    expect(result.searchMatchesByAgentKey["server-1:current"]).toEqual(
      matches["server-1:original"],
    );
  });

  it("suppresses a family member explicitly marked as a duplicate", () => {
    const duplicate = agent({
      id: "duplicate",
      title: "Duplicate import",
      labels: familyLabels({ hidden: true }),
    });

    expect(collapseConversationFamilies({ agents: [duplicate] }).agents).toEqual([]);
  });

  it("identifies obsolete family workspaces while preserving shared workspaces", () => {
    const original = agent({
      id: "original",
      title: "VCLP original",
      labels: familyLabels({ position: 0 }),
      workspaceId: "old-workspace",
    });
    const duplicate = agent({
      id: "duplicate",
      title: "VCLP duplicate",
      labels: familyLabels({ position: 1, hidden: true }),
      workspaceId: "duplicate-workspace",
    });
    const current = agent({
      id: "current",
      title: "VCLP current",
      labels: familyLabels({ position: 2 }),
      workspaceId: "current-workspace",
    });
    const shared = agent({
      id: "shared",
      title: "Independent conversation",
      workspaceId: "old-workspace",
    });

    expect(findSupersededConversationFamilyWorkspaceKeys([original, duplicate, current])).toEqual(
      new Set(["server-1:old-workspace", "server-1:duplicate-workspace"]),
    );
    expect(
      findSupersededConversationFamilyWorkspaceKeys([original, duplicate, current, shared]),
    ).toEqual(new Set(["server-1:duplicate-workspace"]));
  });

  it("stitches ordered sessions with boundaries and keeps only the current ids live", () => {
    const result = stitchConversationFamilyTimeline({
      currentAgentId: "current",
      members: [
        {
          agentId: "current",
          title: "Current",
          position: 2,
          items: [message("assistant_message", "shared", "Newest response")],
        },
        {
          agentId: "original",
          title: "Original",
          position: 0,
          items: [message("user_message", "shared", "Old prompt")],
        },
      ],
    });

    expect(result.items.map((item) => item.kind)).toEqual([
      "activity_log",
      "user_message",
      "activity_log",
      "assistant_message",
    ]);
    expect(result.items[1]?.id).toBe("family:original:shared");
    expect(result.items[3]?.id).toBe("shared");
    expect(result.readOnlyItemIds.has("family:original:shared")).toBe(true);
    expect(result.readOnlyItemIds.has("shared")).toBe(false);
  });

  it("searches message text by default and includes tool activity only when requested", () => {
    const firstTool: StreamItem = {
      kind: "tool_call",
      id: "tool-group-host",
      timestamp: new Date("2026-08-26T12:00:00.000Z"),
      payload: {
        source: "orchestrator",
        data: {
          toolCallId: "tool-1",
          toolName: "shell",
          arguments: { command: "prepare search" },
          result: null,
          status: "completed",
        },
      },
    };
    const matchingTool: StreamItem = {
      kind: "tool_call",
      id: "tool-match",
      timestamp: new Date("2026-08-26T12:00:01.000Z"),
      payload: {
        source: "orchestrator",
        data: {
          toolCallId: "tool-2",
          toolName: "shell",
          arguments: { command: "find hidden needle" },
          result: null,
          status: "completed",
        },
      },
    };
    const items = [
      message("user_message", "user", "Find the public needle"),
      message("assistant_message", "assistant", "The needle is here"),
      message("thought", "thought", "private needle"),
      firstTool,
      matchingTool,
    ];

    expect(searchConversationFamily(items, "needle").map((match) => match.itemId)).toEqual([
      "user",
      "assistant",
    ]);
    expect(
      searchConversationFamily(items, "hidden", { includeToolActivity: true }).map(
        (match) => match.itemId,
      ),
    ).toEqual(["tool-group-host"]);
  });
});
