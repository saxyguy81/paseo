import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { CLIENT_CAPS } from "@getpaseo/protocol/client-capabilities";

import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { claudeProjectDirSync } from "../agent/providers/claude/project-dir.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";

class AvailableClaudeAgentClient extends ClaudeAgentClient {
  override async isAvailable(): Promise<boolean> {
    return true;
  }
}

interface ClaudeJsonlEntry {
  type: "user" | "assistant";
  uuid?: string;
  sessionId: string;
  cwd: string;
  isSidechain?: boolean;
  agentId?: string;
  timestamp?: string;
  message: { role: "user" | "assistant"; content: unknown };
}

function userEntry(
  sessionId: string,
  cwd: string,
  content: string,
  uuid: string,
): ClaudeJsonlEntry {
  return {
    type: "user",
    uuid,
    sessionId,
    cwd,
    message: { role: "user", content },
  };
}

function assistantEntry(sessionId: string, cwd: string, content: string): ClaudeJsonlEntry {
  return {
    type: "assistant",
    sessionId,
    cwd,
    message: { role: "assistant", content },
  };
}

function timelineText(entries: ReadonlyArray<{ item: { type: string; text?: string } }>): string {
  return entries
    .filter(
      (entry): entry is { item: { type: "user_message" | "assistant_message"; text: string } } =>
        entry.item.type === "user_message" || entry.item.type === "assistant_message",
    )
    .map((entry) => entry.item.text)
    .join("\n");
}

describe("daemon E2E - refresh rehydrates timeline from on-disk session", () => {
  let claudeConfigDir: string;
  let prevClaudeConfigDir: string | undefined;
  let cwd: string;
  let sessionFile: string;
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  let passiveClient: DaemonClient | undefined;
  let legacyClient: DaemonClient | undefined;

  const sessionId = "external-edits-session";

  beforeEach(() => {
    prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    claudeConfigDir = mkdtempSync(path.join(tmpdir(), "claude-cfg-refresh-"));
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    cwd = mkdtempSync(path.join(tmpdir(), "claude-cwd-refresh-"));
    const projectsDir = claudeProjectDirSync(cwd, { configDir: claudeConfigDir });
    mkdirSync(projectsDir, { recursive: true });
    sessionFile = path.join(projectsDir, `${sessionId}.jsonl`);

    const initial: ClaudeJsonlEntry[] = [
      userEntry(sessionId, cwd, "first hello", "user-uuid-1"),
      assistantEntry(sessionId, cwd, "first reply"),
      ...Array.from({ length: 250 }, (_, index) => ({
        ...assistantEntry(sessionId, cwd, `persisted history ${index}`),
        uuid: `persisted-history-${index}`,
      })),
      {
        type: "assistant",
        uuid: "refresh-task-call-message",
        sessionId,
        cwd,
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "refresh-task-call",
              name: "Agent",
              input: {
                name: "refresh_researcher",
                subagent_type: "Explore",
                description: "Inspect persisted history",
              },
            },
          ],
        },
      },
      {
        type: "assistant",
        isSidechain: true,
        agentId: "refresh-child",
        uuid: "refresh-child-message",
        timestamp: "2026-08-27T10:00:01.000Z",
        sessionId,
        cwd,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "child history" }],
        },
      },
      {
        type: "user",
        sessionId,
        cwd,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "refresh-task-call",
              content: "done\nagentId: refresh-child",
            },
          ],
        },
      },
    ];
    writeFileSync(
      sessionFile,
      `${initial.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  });

  afterEach(async () => {
    await legacyClient?.close().catch(() => undefined);
    await passiveClient?.close().catch(() => undefined);
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    legacyClient = undefined;
    passiveClient = undefined;
    client = undefined;
    daemon = undefined;
    rmSync(claudeConfigDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
    if (prevClaudeConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
    }
  }, 60_000);

  test("refresh picks up entries appended externally and advances the epoch", async () => {
    const logger = pino({ level: "silent" });
    daemon = await createTestPaseoDaemon({
      agentClients: {
        claude: new AvailableClaudeAgentClient({
          logger,
          resolveBinary: async () => process.execPath,
        }),
      },
      logger,
    });
    client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      capabilities: {
        [CLIENT_CAPS.timelineReplacementInvalidation]: true,
        [CLIENT_CAPS.selectiveAgentTimeline]: true,
      },
    });
    await client.connect();
    await client.fetchAgents({
      subscribe: { subscriptionId: "refresh-rehydrate-test" },
    });
    passiveClient = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      capabilities: {
        [CLIENT_CAPS.timelineReplacementInvalidation]: true,
        [CLIENT_CAPS.selectiveAgentTimeline]: true,
      },
    });
    await passiveClient.connect();
    await passiveClient.fetchAgents({
      subscribe: { subscriptionId: "refresh-rehydrate-passive-test" },
    });
    legacyClient = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      capabilities: {},
    });
    await legacyClient.connect();
    await legacyClient.fetchAgents({
      subscribe: { subscriptionId: "refresh-rehydrate-legacy-test" },
    });

    const imported = await client.importAgent({ provider: "claude", sessionId, cwd });
    expect(imported.id).toBeTruthy();

    const before = await client.fetchAgentTimeline(imported.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    const beforeText = timelineText(before.entries);
    expect(beforeText).toContain("first hello");
    expect(beforeText).toContain("first reply");
    const epochBefore = before.epoch;
    const countBefore = before.entries.length;

    const additions: ClaudeJsonlEntry[] = [
      userEntry(sessionId, cwd, "second hello", "user-uuid-2"),
      assistantEntry(sessionId, cwd, "second reply"),
    ];
    appendFileSync(
      sessionFile,
      `${additions.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );

    await Promise.all([
      client.setAgentTimelineSubscription([imported.id]),
      passiveClient.setAgentTimelineSubscription([imported.id]),
    ]);
    const initiatingEvents: string[] = [];
    const passiveEvents: string[] = [];
    const legacyTimelineEvents: string[] = [];
    const unsubscribeInitiating = client.subscribe((event) => {
      if (event.type === "agent_stream" && event.agentId === imported.id) {
        initiatingEvents.push(event.event.type);
      }
      if (event.type === "agent.provider_subagents.update") {
        initiatingEvents.push(`${event.type}:${event.payload.kind}`);
      }
    });
    const unsubscribeInitiatingReplacement = client.on("agent.timeline.replacement", (event) => {
      if (event.payload.agentId === imported.id) {
        initiatingEvents.push(event.type);
      }
    });
    const unsubscribePassive = passiveClient.subscribe((event) => {
      if (event.type === "agent_stream" && event.agentId === imported.id) {
        passiveEvents.push(event.event.type);
      }
      if (event.type === "agent.provider_subagents.update") {
        passiveEvents.push(`${event.type}:${event.payload.kind}`);
      }
    });
    const unsubscribePassiveReplacement = passiveClient.on(
      "agent.timeline.replacement",
      (event) => {
        if (event.payload.agentId === imported.id) {
          passiveEvents.push(event.type);
        }
      },
    );
    const unsubscribeLegacy = legacyClient.subscribe((event) => {
      if (event.type === "agent_stream" && event.agentId === imported.id) {
        legacyTimelineEvents.push(event.event.type);
      }
    });

    await client.refreshAgent(imported.id);
    await vi.waitFor(() => {
      expect(initiatingEvents).toContain("agent.timeline.replacement");
      expect(passiveEvents).toContain("agent.timeline.replacement");
    });
    unsubscribeInitiating();
    unsubscribeInitiatingReplacement();
    unsubscribePassive();
    unsubscribePassiveReplacement();
    unsubscribeLegacy();

    expect(initiatingEvents).not.toContain("timeline");
    expect(
      initiatingEvents.filter((event) => event.startsWith("agent.provider_subagents")),
    ).toEqual([]);
    expect(initiatingEvents).toContain("agent.timeline.replacement");
    expect(passiveEvents).toContain("agent.timeline.replacement");
    expect(passiveEvents).not.toContain("timeline");
    expect(passiveEvents.filter((event) => event.startsWith("agent.provider_subagents"))).toEqual(
      [],
    );
    expect(legacyTimelineEvents.filter((event) => event === "timeline")).toHaveLength(200);

    const after = await client.fetchAgentTimeline(imported.id, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    const afterText = timelineText(after.entries);
    expect(afterText).toContain("second hello");
    expect(afterText).toContain("second reply");
    expect(after.entries.length).toBeGreaterThan(countBefore);
    expect(after.epoch).not.toBe(epochBefore);
  }, 30_000);
});
