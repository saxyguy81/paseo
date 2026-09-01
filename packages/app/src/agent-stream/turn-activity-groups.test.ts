import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { layoutStream } from "./layout";
import { orderTailForStreamRenderStrategy } from "./strategy";
import { resolveStreamRenderStrategy } from "./strategy-resolver";
import { buildTurnActivityGroups } from "./turn-activity-groups";

function timestamp(seed: number): Date {
  return new Date(`2026-01-01T00:00:${seed.toString().padStart(2, "0")}.000Z`);
}

function user(id: string, seed: number, turnId: string): StreamItem {
  return { kind: "user_message", id, text: id, timestamp: timestamp(seed), turnId };
}

function assistant(id: string, seed: number, turnId: string): StreamItem {
  return { kind: "assistant_message", id, text: id, timestamp: timestamp(seed), turnId };
}

function thought(id: string, seed: number, turnId: string): StreamItem {
  return { kind: "thought", id, text: id, timestamp: timestamp(seed), status: "ready", turnId };
}

function tool(id: string, seed: number, turnId: string): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: timestamp(seed),
    turnId,
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: id,
        toolName: "Shell",
        arguments: "echo hi",
        result: "done",
        status: "completed",
      },
    },
  };
}

function activity(id: string, seed: number, turnId: string): StreamItem {
  return {
    kind: "activity_log",
    id,
    timestamp: timestamp(seed),
    turnId,
    activityType: "info",
    message: id,
  };
}

function groupsFor(platform: "web" | "android", items: StreamItem[]) {
  const strategy = resolveStreamRenderStrategy({ platform, isMobileBreakpoint: false });
  const history = orderTailForStreamRenderStrategy({ strategy, streamItems: items });
  const layout = layoutStream({
    strategy,
    isTurnActive: false,
    history,
    liveHead: [],
    timingByAssistantId: new Map(),
  });
  return buildTurnActivityGroups(layout.history);
}

describe("buildTurnActivityGroups", () => {
  it.each(["web", "android"] as const)(
    "collapses completed intermediate work but keeps the prompt and final answer on %s",
    (platform) => {
      const result = groupsFor(platform, [
        user("user-1", 1, "turn-1"),
        assistant("progress", 2, "turn-1"),
        thought("reasoning", 3, "turn-1"),
        tool("shell", 4, "turn-1"),
        assistant("final-1", 5, "turn-1"),
        assistant("final-2", 6, "turn-1"),
      ]);

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]?.memberItemIds).toEqual(["progress", "reasoning", "shell"]);
      expect(result.byItemId.has("user-1")).toBe(false);
      expect(result.byItemId.has("final-1")).toBe(false);
      expect(result.byItemId.has("final-2")).toBe(false);
      expect(result.byItemId.get("progress")?.isHost).toBe(true);
      expect(result.byItemId.get("shell")?.isHost).toBe(false);
    },
  );

  it("leaves unfinished and error-only turns fully visible", () => {
    const result = groupsFor("web", [
      user("user-1", 1, "turn-1"),
      assistant("progress", 2, "turn-1"),
      tool("shell", 3, "turn-1"),
      activity("api-error", 4, "turn-1"),
    ]);

    expect(result.groups).toEqual([]);
    expect(result.byItemId.size).toBe(0);
  });

  it("never hides conversation-family boundaries", () => {
    const boundary = activity("family-boundary:older", 3, "turn-1");
    const result = groupsFor("web", [
      user("user-1", 1, "turn-1"),
      tool("before-boundary", 2, "turn-1"),
      boundary,
      tool("after-boundary", 4, "turn-1"),
      assistant("final", 5, "turn-1"),
    ]);

    expect(result.groups.map((group) => group.memberItemIds)).toEqual([
      ["before-boundary"],
      ["after-boundary"],
    ]);
    expect(result.byItemId.has(boundary.id)).toBe(false);
  });

  it("creates independent disclosures for independent turns", () => {
    const result = groupsFor("web", [
      user("user-1", 1, "turn-1"),
      tool("tool-1", 2, "turn-1"),
      assistant("final-1", 3, "turn-1"),
      user("user-2", 4, "turn-2"),
      thought("thought-2", 5, "turn-2"),
      assistant("final-2", 6, "turn-2"),
    ]);

    expect(result.groups.map((group) => group.memberItemIds)).toEqual([["tool-1"], ["thought-2"]]);
  });
});
