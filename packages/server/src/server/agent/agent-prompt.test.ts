import { expect, it, test, vi } from "vitest";
import pino, { type Logger } from "pino";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import {
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  resumePendingAgentPrompts,
  sendPromptToAgent,
  setupFinishNotification,
  waitForAgentRunStartWithTimeout,
} from "./agent-prompt.js";
import type { AgentManagerEvent, ManagedAgent } from "./agent-manager.js";
import type {
  AgentClient,
  AgentPermissionRequest,
  AgentPromptAdmissionDecision,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
  AgentUsage,
} from "./agent-sdk-types.js";
import {
  isClaudeContextPreflightPrompt,
  planClaudePromptAdmission,
} from "./providers/claude/prompt-admission.js";

interface CapturedLogger {
  logger: Logger;
  records: Array<Record<string, unknown>>;
  nextRecord: Promise<void>;
}

function createCapturedLogger(): CapturedLogger {
  const records: Array<Record<string, unknown>> = [];
  let resolveNextRecord!: () => void;
  const nextRecord = new Promise<void>((resolve) => {
    resolveNextRecord = resolve;
  });
  const logger = pino(
    { level: "error" },
    {
      write(line: string) {
        records.push(JSON.parse(line) as Record<string, unknown>);
        resolveNextRecord();
      },
    },
  );
  return { logger, records, nextRecord };
}

interface FinishNotificationScenarioOptions {
  childLastAssistantMessage?: string | null;
  childParentAgentId?: string | null;
  requireParentOwnership?: boolean;
  parentPromptError?: Error;
  logger?: Logger;
}

interface FinishNotificationScenario {
  startWatchingChild(): void;
  requestChildPermission(requestId?: string): void;
  resolveChildPermission(requestId?: string): void;
  resolveChildPermissionFromState(requestId?: string): void;
  resolveChildPermissionWhileIdle(requestId?: string): void;
  finishChild(): void;
  finishChildAndReadParentPrompt(): Promise<string>;
  closeChildAndReadParentPrompt(): Promise<string>;
  parentPrompts(): string[];
  steerAttemptCount(): number;
  wasParentPrompted(): boolean;
}

function createFinishNotificationScenario(
  options?: FinishNotificationScenarioOptions,
): FinishNotificationScenario {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;
  let resolveParentPrompt: ((prompt: string) => void) | null = null;
  let parentPrompted = false;
  let steerAttemptCount = 0;
  const parentPrompts: string[] = [];

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });
  Reflect.set(childAgent, "pendingPermissions", new Map());

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });
  Reflect.set(callerAgent, "capabilities", { supportsInFlightSteering: true });

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(agentManager, "getAgent", (agentId: string) => {
    if (agentId === "child-agent") {
      return childAgent;
    }
    if (agentId === "caller-agent") {
      return callerAgent;
    }
    return null;
  });
  Reflect.set(agentManager, "subscribe", (callback: (event: AgentManagerEvent) => void) => {
    subscriber = callback;
    return () => {
      subscriber = null;
    };
  });
  Reflect.set(agentManager, "getLastAssistantMessage", async () => {
    return options?.childLastAssistantMessage ?? null;
  });
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "planPromptAdmission", () => ({
    type: "dispatch",
  }));
  Reflect.set(agentManager, "hasInFlightRun", () => Boolean(options?.parentPromptError));
  Reflect.set(agentManager, "steerOrReplaceActiveTurn", async () => {
    steerAttemptCount += 1;
    return { status: "inactive" };
  });
  Reflect.set(agentManager, "streamAgent", (_agentId: string, prompt: string) => {
    parentPrompted = true;
    parentPrompts.push(prompt);
    resolveParentPrompt?.(prompt);
    return (async function* noop() {})();
  });
  Reflect.set(agentManager, "replaceAgentRun", async (_agentId: string, prompt: string) => {
    resolveParentPrompt?.(prompt);
    throw options?.parentPromptError;
  });

  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", async (agentId: string) => {
    if (agentId === "child-agent") {
      const parentAgentId =
        options?.childParentAgentId === undefined ? "caller-agent" : options.childParentAgentId;
      return {
        title: "Child Agent",
        labels: parentAgentId ? { "paseo.parent-agent-id": parentAgentId } : {},
      };
    }
    return null;
  });

  return {
    startWatchingChild() {
      setupFinishNotification({
        agentManager,
        agentStorage,
        childAgentId: "child-agent",
        callerAgentId: "caller-agent",
        requireParentOwnership: options?.requireParentOwnership,
        logger: options?.logger ?? createTestLogger(),
      });
    },
    requestChildPermission(requestId = "permission-1") {
      childAgent.lifecycle = "running";
      childAgent.pendingPermissions.set(requestId, {
        id: requestId,
        provider: "claude",
        kind: "tool",
        name: "Run command",
        description: "Write the QA sentinel",
        input: {
          file_path: "/tmp/permission-qa.txt",
          content: "PASEO_PERMISSION_NOTIFY_QA_OK\n",
        },
      });
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_requested",
          provider: "codex",
          request: childAgent.pendingPermissions.get(requestId)!,
        },
      });
    },
    resolveChildPermission(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_resolved",
          provider: "codex",
          requestId,
          resolution: { behavior: "allow" },
        },
      });
    },
    resolveChildPermissionFromState(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      subscriber?.({ type: "agent_state", agent: childAgent });
    },
    resolveChildPermissionWhileIdle(requestId = "permission-1") {
      childAgent.pendingPermissions.delete(requestId);
      childAgent.lifecycle = "idle";
      subscriber?.({ type: "agent_state", agent: childAgent });
      subscriber?.({
        type: "agent_stream",
        agentId: "child-agent",
        event: {
          type: "permission_resolved",
          provider: "codex",
          requestId,
          resolution: { behavior: "allow" },
        },
      });
    },
    finishChild() {
      childAgent.lifecycle = "running";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      childAgent.lifecycle = "idle";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });
    },
    async finishChildAndReadParentPrompt() {
      const parentPrompt = new Promise<string>((resolve) => {
        resolveParentPrompt = resolve;
      });
      this.finishChild();

      return parentPrompt;
    },
    async closeChildAndReadParentPrompt() {
      const parentPrompt = new Promise<string>((resolve) => {
        resolveParentPrompt = resolve;
      });

      childAgent.lifecycle = "running";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      childAgent.lifecycle = "closed";
      subscriber?.({
        type: "agent_state",
        agent: childAgent,
      });

      return parentPrompt;
    },
    parentPrompts() {
      return parentPrompts;
    },
    steerAttemptCount() {
      return steerAttemptCount;
    },
    wasParentPrompted() {
      return parentPrompted;
    },
  };
}

test("isSystemInjectedEnvelope matches the envelope formatSystemNotificationPrompt produces", () => {
  expect(isSystemInjectedEnvelope(formatSystemNotificationPrompt("child finished"))).toBe(true);
  expect(isSystemInjectedEnvelope("hello world")).toBe(false);
});

test("finish notifications tell the parent the child's last assistant message", async () => {
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: "Implemented the cleanup and all checks pass.",
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toEqual(
    formatSystemNotificationPrompt(
      "Agent child-agent (Child Agent) finished.\n\n<agent-response>\nImplemented the cleanup and all checks pass.\n</agent-response>",
    ),
  );
  expect(scenario.steerAttemptCount()).toBe(1);
});

test("finish notifications truncate oversized child responses", async () => {
  const included = "x".repeat(4000);
  const omitted = "TAIL-MARKER".repeat(50);
  const scenario = createFinishNotificationScenario({
    childLastAssistantMessage: included + omitted,
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toContain(included);
  expect(parentPrompt).toContain(
    `[truncated ${omitted.length} chars; use get_agent_activity for the full response]`,
  );
  expect(parentPrompt).not.toContain("TAIL-MARKER");
});

test("closing a watched child notifies the caller", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  const parentPrompt = await scenario.closeChildAndReadParentPrompt();

  expect(parentPrompt).toEqual(
    formatSystemNotificationPrompt("Agent child-agent (Child Agent) was closed."),
  );
});

test("finish notifications survive permission responses", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();

  await vi.waitFor(() => {
    expect(scenario.parentPrompts()).toHaveLength(1);
  });
  expect(scenario.parentPrompts()[0]).toContain("needs permission.");
  const permissionPayload = scenario
    .parentPrompts()[0]
    .match(/<permission-request>\n([\s\S]+?)\n<\/permission-request>/)?.[1];
  expect(permissionPayload).toBeDefined();
  expect(JSON.parse(permissionPayload!)).toEqual({
    agentId: "child-agent",
    requestId: "permission-1",
    request: {
      id: "permission-1",
      provider: "claude",
      kind: "tool",
      name: "Run command",
      description: "Write the QA sentinel",
      input: {
        file_path: "/tmp/permission-qa.txt",
        content: "PASEO_PERMISSION_NOTIFY_QA_OK\n",
      },
    },
  });

  scenario.resolveChildPermission();
  scenario.finishChild();

  await vi.waitFor(() => {
    expect(scenario.parentPrompts()).toHaveLength(2);
  });
  expect(scenario.parentPrompts()[1]).toContain("finished.");
});

test("an idle permission resolution waits for the resumed run to finish", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));

  scenario.resolveChildPermissionWhileIdle();
  scenario.requestChildPermission("permission-2");
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  expect(scenario.parentPrompts().every((prompt) => prompt.includes("needs permission."))).toBe(
    true,
  );

  scenario.resolveChildPermission("permission-2");
  scenario.finishChild();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(scenario.parentPrompts()[2]).toContain("finished.");
});

test("finish notifications report every concurrently pending permission", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission("permission-1");
  scenario.requestChildPermission("permission-2");

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  expect(
    scenario.parentPrompts().map((prompt) => {
      const payload = prompt.match(/<permission-request>\n([\s\S]+?)\n<\/permission-request>/)?.[1];
      return JSON.parse(payload!).requestId;
    }),
  ).toEqual(["permission-1", "permission-2"]);

  scenario.resolveChildPermission("permission-1");
  scenario.resolveChildPermission("permission-2");
  scenario.finishChild();

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(scenario.parentPrompts()[2]).toContain("finished.");
});

test("finish notifications survive repeated permission cycles", async () => {
  const scenario = createFinishNotificationScenario();

  scenario.startWatchingChild();
  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(1));
  scenario.resolveChildPermissionFromState();

  scenario.requestChildPermission();
  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(2));
  scenario.resolveChildPermission();
  scenario.finishChild();

  await vi.waitFor(() => expect(scenario.parentPrompts()).toHaveLength(3));
  expect(
    scenario.parentPrompts().map((prompt) => prompt.match(/(needs permission|finished)\./)?.[1]),
  ).toEqual(["needs permission", "needs permission", "finished"]);
});

test("detaching a child ends its parent-owned finish notification", async () => {
  const scenario = createFinishNotificationScenario({
    childParentAgentId: null,
    requireParentOwnership: true,
  });
  scenario.startWatchingChild();
  scenario.finishChild();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scenario.wasParentPrompted()).toBe(false);
});

test("follow-up finish notifications do not require a parent relationship", async () => {
  const scenario = createFinishNotificationScenario({
    childParentAgentId: "another-agent",
  });

  scenario.startWatchingChild();
  const parentPrompt = await scenario.finishChildAndReadParentPrompt();

  expect(parentPrompt).toContain("Agent child-agent (Child Agent) finished.");
});

test("finish notifications log a rejected parent prompt without an unhandled rejection", async () => {
  const captured = createCapturedLogger();
  const scenario = createFinishNotificationScenario({
    parentPromptError: new Error("parent provider rejected replacement"),
    logger: captured.logger,
  });

  scenario.startWatchingChild();
  await scenario.finishChildAndReadParentPrompt();
  await captured.nextRecord;

  expect(captured.records).toEqual([
    expect.objectContaining({
      msg: "Failed to notify caller agent",
      childAgentId: "child-agent",
      callerAgentId: "caller-agent",
      reason: "finished",
      err: expect.objectContaining({
        message: "parent provider rejected replacement",
      }),
    }),
  ]);
});

it("does not notify archived callers", async () => {
  let subscriber: ((event: AgentManagerEvent) => void) | null = null;

  const childAgent: ManagedAgent = Object.create(null);
  Reflect.set(childAgent, "id", "child-agent");
  Reflect.set(childAgent, "lifecycle", "idle");
  Reflect.set(childAgent, "config", { title: "Child Agent" });
  Reflect.set(childAgent, "pendingPermissions", new Map());

  const callerAgent: ManagedAgent = Object.create(null);
  Reflect.set(callerAgent, "id", "caller-agent");
  Reflect.set(callerAgent, "lifecycle", "idle");
  Reflect.set(callerAgent, "config", { title: "Caller Agent" });

  const streamAgentSpy = vi.fn(() => (async function* noop() {})());
  const replaceAgentRunSpy = vi.fn(() => (async function* noop() {})());

  const agentManager: AgentManager = Object.create(AgentManager.prototype);
  Reflect.set(
    agentManager,
    "getAgent",
    vi.fn((agentId: string) => {
      if (agentId === "child-agent") {
        return childAgent;
      }
      if (agentId === "caller-agent") {
        return callerAgent;
      }
      return null;
    }),
  );
  Reflect.set(
    agentManager,
    "subscribe",
    vi.fn((callback: (event: AgentManagerEvent) => void) => {
      subscriber = callback;
      return () => {
        subscriber = null;
      };
    }),
  );
  Reflect.set(agentManager, "hasInFlightRun", vi.fn().mockReturnValue(false));
  Reflect.set(agentManager, "streamAgent", streamAgentSpy);
  Reflect.set(agentManager, "replaceAgentRun", replaceAgentRunSpy);

  const agentStorageGetSpy = vi.fn(async (agentId: string) =>
    agentId === "caller-agent" ? { archivedAt: "2024-01-01" } : null,
  );
  const agentStorage: AgentStorage = Object.create(AgentStorage.prototype);
  Reflect.set(agentStorage, "get", agentStorageGetSpy);

  setupFinishNotification({
    agentManager,
    agentStorage,
    childAgentId: "child-agent",
    callerAgentId: "caller-agent",
    logger: createTestLogger(),
  });

  expect(subscriber).not.toBeNull();

  childAgent.lifecycle = "running";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  childAgent.lifecycle = "idle";
  subscriber?.({
    type: "agent_state",
    agent: childAgent,
  });

  await vi.waitFor(() => {
    expect(agentStorageGetSpy).toHaveBeenCalledWith("caller-agent");
  });

  expect(streamAgentSpy).not.toHaveBeenCalled();
  expect(replaceAgentRunSpy).not.toHaveBeenCalled();
});

// Deliberately independent literals rather than the production constants these tests
// guard: deriving the boundaries from AGENT_RUN_START_TIMEOUT_MS would keep the tests
// green if that constant were shortened back under a provider's startup budget.
const EXPECTED_RUN_START_BUDGET_MS = 60_000;
// The slowest provider startup budget the run-start wait has to sit outside of today
// (OpenCode's OPENCODE_SERVER_STARTUP_TIMEOUT_MS).
const SLOWEST_PROVIDER_STARTUP_BUDGET_MS = 30_000;

const RUN_START_TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
  supportsInFlightSteering: false,
} as const;

/**
 * Provider session whose turn start is held open for a configurable span, so the real
 * AgentManager run-state transition (pendingRun.started -> lifecycle "running" ->
 * agent_state) is what the run-start wait observes. `startDelayMs: null` never starts.
 */
class SlowStartAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly id = randomUUID();
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private releaseStartTurn!: () => void;
  private readonly released = new Promise<void>((resolve) => {
    this.releaseStartTurn = resolve;
  });

  constructor(private readonly startDelayMs: number | null) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  /** Teardown hook so a never-starting turn cannot wedge the suite. */
  release(): void {
    this.releaseStartTurn();
  }

  async startTurn(): Promise<{ turnId: string }> {
    await new Promise<void>((resolve) => {
      if (this.startDelayMs !== null) {
        setTimeout(resolve, this.startDelayMs);
      }
      void this.released.then(resolve);
    });
    const turnId = "turn-1";
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({
        type: "turn_completed",
        provider: this.provider,
        turnId,
      });
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: null,
      modeId: null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

class SlowStartAgentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly sessions: SlowStartAgentSession[] = [];

  constructor(private readonly startDelayMs: number | null) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const session = new SlowStartAgentSession(this.startDelayMs);
    this.sessions.push(session);
    return session;
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async resumeSession(): Promise<AgentSession> {
    return await this.createSession();
  }
}

class QueuedPromptAgentSession implements AgentSession {
  readonly provider = "claude-acc";
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly id = randomUUID();
  readonly prompts: string[] = [];
  interruptCount = 0;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private activeTurnId: string | null = null;

  planPromptAdmission(
    prompt: string | unknown[],
    usage: AgentUsage | undefined,
  ): AgentPromptAdmissionDecision {
    return planClaudePromptAdmission({
      prompt: prompt as Parameters<typeof planClaudePromptAdmission>[0]["prompt"],
      usage,
    });
  }

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: string | unknown[]): Promise<{ turnId: string }> {
    if (this.activeTurnId) throw new Error("Conversation already has an active request");
    this.prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    this.activeTurnId = `turn-${this.prompts.length}`;
    return { turnId: this.activeTurnId };
  }

  complete(usage?: AgentUsage): void {
    const turnId = this.activeTurnId;
    if (!turnId) throw new Error("No active turn");
    this.activeTurnId = null;
    this.pushEvent({
      type: "turn_completed",
      provider: this.provider,
      turnId,
      usage,
    });
  }

  reportUsage(usage: AgentUsage): void {
    this.pushEvent({ type: "usage_updated", provider: this.provider, usage });
  }

  reportCompactionBoundary(postTokens: number): void {
    const turnId = this.activeTurnId;
    if (!turnId) throw new Error("No active turn");
    this.pushEvent({
      type: "timeline",
      provider: this.provider,
      turnId,
      item: { type: "compaction", status: "completed", trigger: "manual" },
    });
    this.reportUsage({
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: postTokens,
    });
  }

  fail(
    error = "transient provider failure",
    failureKind?: Extract<AgentStreamEvent, { type: "turn_failed" }>["failureKind"],
  ): void {
    const turnId = this.activeTurnId;
    if (!turnId) throw new Error("No active turn");
    this.activeTurnId = null;
    this.pushEvent({
      type: "turn_failed",
      provider: this.provider,
      turnId,
      error,
      ...(failureKind ? { failureKind } : {}),
    });
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: null,
      modeId: null,
    };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence() {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {
    this.interruptCount += 1;
    const turnId = this.activeTurnId;
    if (!turnId) return;
    this.activeTurnId = null;
    this.pushEvent({
      type: "turn_canceled",
      provider: this.provider,
      turnId,
      reason: "Interrupted",
    });
  }
  async close(): Promise<void> {}
}

class QueuedPromptAgentClient implements AgentClient {
  readonly provider = "claude-acc";
  readonly capabilities = RUN_START_TEST_CAPABILITIES;
  readonly session = new QueuedPromptAgentSession();
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async createSession(): Promise<AgentSession> {
    return this.session;
  }
  async resumeSession(): Promise<AgentSession> {
    return this.session;
  }
  async fetchCatalog() {
    return { models: [], modes: [] };
  }
}

async function createContextPreflightScenario(options?: { retryDelayMs?: number }): Promise<{
  workdir: string;
  logger: Logger;
  storage: AgentStorage;
  client: QueuedPromptAgentClient;
  agentManager: AgentManager;
  agentId: string;
  cleanup(): Promise<void>;
}> {
  const workdir = mkdtempSync(join(tmpdir(), "agent-context-preflight-scenario-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new QueuedPromptAgentClient();
  const agentManager = new AgentManager({
    clients: { "claude-acc": client },
    registry: storage,
    ...(options?.retryDelayMs === undefined
      ? {}
      : {
          transientPromptRetryBaseDelayMs: options.retryDelayMs,
          transientPromptRetryMaxDelayMs: options.retryDelayMs,
        }),
    logger,
  });
  const snapshot = await agentManager.createAgent(
    { provider: "claude-acc", cwd: workdir },
    undefined,
    { workspaceId: undefined },
  );
  client.session.reportUsage({
    contextWindowMaxTokens: 200_000,
    contextWindowUsedTokens: 163_000,
  });
  await vi.waitFor(() =>
    expect(agentManager.getAgent(snapshot.id)?.lastUsage).toMatchObject({
      contextWindowUsedTokens: 163_000,
    }),
  );

  return {
    workdir,
    logger,
    storage,
    client,
    agentManager,
    agentId: snapshot.id,
    async cleanup() {
      await agentManager.closeAgent(snapshot.id).catch(() => undefined);
      await agentManager.flush().catch(() => undefined);
      await storage.flush().catch(() => undefined);
      rmSync(workdir, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    },
  };
}

test("precompacts high-context Claude sessions before releasing the exact queued user prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-context-preflight-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new QueuedPromptAgentClient();
  const agentManager = new AgentManager({
    clients: { "claude-acc": client },
    registry: storage,
    logger,
  });
  const snapshot = await agentManager.createAgent(
    { provider: "claude-acc", cwd: workdir },
    undefined,
    { workspaceId: undefined },
  );

  try {
    client.session.reportUsage({
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 163_000,
    });
    await vi.waitFor(() =>
      expect(agentManager.getAgent(snapshot.id)?.lastUsage).toMatchObject({
        contextWindowUsedTokens: 163_000,
      }),
    );

    await expect(
      sendPromptToAgent({
        agentManager,
        agentStorage: storage,
        agentId: snapshot.id,
        prompt: "/team finish the current goal",
        messageId: "message-high-context",
        activeTurnBehavior: "queue",
        logger,
      }),
    ).resolves.toEqual({ disposition: "queued" });

    await vi.waitFor(() => expect(client.session.prompts).toHaveLength(1));
    expect(isClaudeContextPreflightPrompt(client.session.prompts[0]!)).toBe(true);
    expect(client.session.prompts).not.toContain("/team finish the current goal");

    await expect(
      sendPromptToAgent({
        agentManager,
        agentStorage: storage,
        agentId: snapshot.id,
        prompt: "then summarize the result",
        messageId: "message-after-high-context",
        activeTurnBehavior: "queue",
        logger,
      }),
    ).resolves.toEqual({ disposition: "queued" });

    // A clean compact result is sufficient even when the SDK omits compact_boundary.
    client.session.complete({
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 163_000,
    });
    await vi.waitFor(() =>
      expect(client.session.prompts).toEqual([
        expect.stringContaining("PASEO_INTERNAL_CONTEXT_PREFLIGHT"),
        "/team finish the current goal",
      ]),
    );

    client.session.complete();
    await vi.waitFor(() =>
      expect(client.session.prompts).toEqual([
        expect.stringContaining("PASEO_INTERNAL_CONTEXT_PREFLIGHT"),
        "/team finish the current goal",
        "then summarize the result",
      ]),
    );
    client.session.complete();
    await vi.waitFor(async () => {
      await expect(storage.listPendingPrompts(snapshot.id)).resolves.toEqual([]);
    });
    expect(
      client.session.prompts.filter((prompt) => prompt === "/team finish the current goal"),
    ).toHaveLength(1);
    expect(
      client.session.prompts.filter((prompt) => prompt === "then summarize the result"),
    ).toHaveLength(1);
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    await agentManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("retries a transient compaction before dispatching the retained user prompt", async () => {
  const scenario = await createContextPreflightScenario({ retryDelayMs: 5 });
  try {
    await sendPromptToAgent({
      agentManager: scenario.agentManager,
      agentStorage: scenario.storage,
      agentId: scenario.agentId,
      prompt: "finish after the gateway recovers",
      messageId: "message-after-preflight-retry",
      activeTurnBehavior: "queue",
      logger: scenario.logger,
    });
    await vi.waitFor(() => expect(scenario.client.session.prompts).toHaveLength(1));
    scenario.client.session.fail("API Error: 502 status code (no body)", "retryable_api");

    await vi.waitFor(() => expect(scenario.client.session.prompts).toHaveLength(2));
    expect(scenario.client.session.prompts.every(isClaudeContextPreflightPrompt)).toBe(true);
    scenario.client.session.complete();
    await vi.waitFor(() =>
      expect(scenario.client.session.prompts[2]).toBe("finish after the gateway recovers"),
    );
    scenario.client.session.complete();
  } finally {
    await scenario.cleanup();
  }
});

test("precompacts a submitted retry without executing the original user turn twice", async () => {
  const scenario = await createContextPreflightScenario({ retryDelayMs: 5 });
  try {
    scenario.client.session.reportUsage({
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 100_000,
    });
    await vi.waitFor(() =>
      expect(scenario.agentManager.getAgent(scenario.agentId)?.lastUsage).toMatchObject({
        contextWindowUsedTokens: 100_000,
      }),
    );
    await sendPromptToAgent({
      agentManager: scenario.agentManager,
      agentStorage: scenario.storage,
      agentId: scenario.agentId,
      prompt: "perform this exact user instruction once",
      messageId: "message-submitted-before-preflight",
      activeTurnBehavior: "queue",
      logger: scenario.logger,
    });
    await vi.waitFor(() =>
      expect(scenario.client.session.prompts).toEqual(["perform this exact user instruction once"]),
    );

    scenario.client.session.reportUsage({
      contextWindowMaxTokens: 200_000,
      contextWindowUsedTokens: 163_000,
    });
    scenario.client.session.fail("API Error: 502 status code (no body)", "retryable_api");

    await vi.waitFor(() => expect(scenario.client.session.prompts).toHaveLength(2));
    expect(isClaudeContextPreflightPrompt(scenario.client.session.prompts[1]!)).toBe(true);
    scenario.client.session.complete();
    await vi.waitFor(() => expect(scenario.client.session.prompts).toHaveLength(3));
    expect(scenario.client.session.prompts[2]).toContain("<paseo-system>");
    expect(
      scenario.client.session.prompts.filter(
        (prompt) => prompt === "perform this exact user instruction once",
      ),
    ).toHaveLength(1);
    scenario.client.session.complete();
    await vi.waitFor(async () => {
      await expect(scenario.storage.listPendingPrompts(scenario.agentId)).resolves.toEqual([]);
    });
  } finally {
    await scenario.cleanup();
  }
});

test("does not repeat compaction after a boundary even if the trailing result fails", async () => {
  const scenario = await createContextPreflightScenario({ retryDelayMs: 5 });
  try {
    await sendPromptToAgent({
      agentManager: scenario.agentManager,
      agentStorage: scenario.storage,
      agentId: scenario.agentId,
      prompt: "continue after the completed compact boundary",
      messageId: "message-after-boundary",
      activeTurnBehavior: "queue",
      logger: scenario.logger,
    });
    await vi.waitFor(() => expect(scenario.client.session.prompts).toHaveLength(1));
    scenario.client.session.reportCompactionBoundary(12_000);
    scenario.client.session.fail("API Error: 502 after compact", "retryable_api");

    await vi.waitFor(() =>
      expect(scenario.client.session.prompts).toEqual([
        expect.stringContaining("PASEO_INTERNAL_CONTEXT_PREFLIGHT"),
        "continue after the completed compact boundary",
      ]),
    );
    scenario.client.session.complete();
  } finally {
    await scenario.cleanup();
  }
});

test("stops the predecessor drain when a completed preflight ends in rollover failure", async () => {
  const scenario = await createContextPreflightScenario();
  try {
    await scenario.storage.enqueuePendingPrompt(scenario.agentId, {
      id: "message-transferred-after-preflight",
      prompt: "continue only on the rollover successor",
    });
    await scenario.storage.claimPendingPrompt(scenario.agentId);
    await scenario.storage.insertPendingPromptPreflight(
      scenario.agentId,
      "message-transferred-after-preflight",
      {
        key: "claude_context_compaction",
        prompt: "/compact [PASEO_INTERNAL_CONTEXT_PREFLIGHT] preserve state",
      },
    );
    const preflight = await scenario.storage.claimPendingPrompt(scenario.agentId);
    if (!preflight) throw new Error("Expected claimed preflight");
    const settleStoredPreflight = Reflect.get(scenario.agentManager, "settleStoredPreflight") as (
      ...args: unknown[]
    ) => Promise<boolean>;

    await expect(
      Reflect.apply(settleStoredPreflight, scenario.agentManager, [
        scenario.agentId,
        preflight,
        {
          started: true,
          terminal: "failed",
          failureKind: "context_overflow",
          preflightBoundaryObserved: true,
        },
        scenario.storage,
      ]),
    ).resolves.toBe(false);
    await expect(scenario.storage.listPendingPrompts(scenario.agentId)).resolves.toMatchObject([
      { id: "message-transferred-after-preflight", state: "queued" },
    ]);
  } finally {
    await scenario.cleanup();
  }
});

test("stops after an unclassified stream error even when the compact boundary completed", async () => {
  const scenario = await createContextPreflightScenario();
  try {
    await scenario.storage.enqueuePendingPrompt(scenario.agentId, {
      id: "message-after-unknown-preflight-error",
      prompt: "remain queued after an unknown stream failure",
    });
    await scenario.storage.claimPendingPrompt(scenario.agentId);
    await scenario.storage.insertPendingPromptPreflight(
      scenario.agentId,
      "message-after-unknown-preflight-error",
      {
        key: "claude_context_compaction",
        prompt: "/compact [PASEO_INTERNAL_CONTEXT_PREFLIGHT] preserve state",
      },
    );
    const preflight = await scenario.storage.claimPendingPrompt(scenario.agentId);
    if (!preflight) throw new Error("Expected claimed preflight");
    const settleStoredPreflight = Reflect.get(scenario.agentManager, "settleStoredPreflight") as (
      ...args: unknown[]
    ) => Promise<boolean>;

    await expect(
      Reflect.apply(settleStoredPreflight, scenario.agentManager, [
        scenario.agentId,
        preflight,
        {
          started: true,
          terminal: null,
          preflightBoundaryObserved: true,
          error: new Error("stream iterator failed after the compact boundary"),
        },
        scenario.storage,
      ]),
    ).resolves.toBe(false);
    await expect(scenario.storage.listPendingPrompts(scenario.agentId)).resolves.toMatchObject([
      { id: "message-after-unknown-preflight-error", state: "queued" },
    ]);
  } finally {
    await scenario.cleanup();
  }
});

test("retains the user prompt without looping after a non-retryable compaction failure", async () => {
  const scenario = await createContextPreflightScenario({ retryDelayMs: 5 });
  try {
    await sendPromptToAgent({
      agentManager: scenario.agentManager,
      agentStorage: scenario.storage,
      agentId: scenario.agentId,
      prompt: "wait for credentials to be repaired",
      messageId: "message-after-auth-repair",
      activeTurnBehavior: "queue",
      logger: scenario.logger,
    });
    await vi.waitFor(() => expect(scenario.client.session.prompts).toHaveLength(1));
    scenario.client.session.fail("Invalid API key");

    await vi.waitFor(async () => {
      await expect(scenario.storage.listPendingPrompts(scenario.agentId)).resolves.toMatchObject([
        {
          id: "message-after-auth-repair",
          state: "queued",
        },
      ]);
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(scenario.client.session.prompts).toHaveLength(1);

    await sendPromptToAgent({
      agentManager: scenario.agentManager,
      agentStorage: scenario.storage,
      agentId: scenario.agentId,
      prompt: "continue once authentication is repaired",
      messageId: "message-after-auth-repair-follow-up",
      activeTurnBehavior: "steer",
      logger: scenario.logger,
    });
    await vi.waitFor(() => expect(scenario.client.session.prompts).toHaveLength(2));
    expect(isClaudeContextPreflightPrompt(scenario.client.session.prompts[1]!)).toBe(true);
    scenario.client.session.complete();
    await vi.waitFor(() =>
      expect(scenario.client.session.prompts[2]).toBe("wait for credentials to be repaired"),
    );
    scenario.client.session.complete();
    await vi.waitFor(() =>
      expect(scenario.client.session.prompts[3]).toBe("continue once authentication is repaired"),
    );
    scenario.client.session.complete();
    await vi.waitFor(async () => {
      await expect(scenario.storage.listPendingPrompts(scenario.agentId)).resolves.toEqual([]);
    });
    expect(
      scenario.client.session.prompts.filter(
        (prompt) => prompt === "wait for credentials to be repaired",
      ),
    ).toHaveLength(1);
  } finally {
    await scenario.cleanup();
  }
});

test("daemon recovery reclaims an interrupted preflight before releasing its user prompt", async () => {
  const scenario = await createContextPreflightScenario({ retryDelayMs: 5 });
  let recoveredManager: AgentManager | undefined;
  try {
    await scenario.agentManager.flush();
    await scenario.storage.enqueuePendingPrompt(scenario.agentId, {
      id: "message-after-preflight-restart",
      prompt: "continue exactly once after the daemon restart",
    });
    await scenario.storage.flush();

    const reloaded = new AgentStorage(join(scenario.workdir, "agents"), scenario.logger);
    const recoveredClient = new QueuedPromptAgentClient();
    recoveredManager = new AgentManager({
      clients: { "claude-acc": recoveredClient },
      registry: reloaded,
      logger: scenario.logger,
    });
    await resumePendingAgentPrompts({
      agentManager: recoveredManager,
      agentStorage: reloaded,
      logger: scenario.logger,
    });

    await vi.waitFor(() => expect(recoveredClient.session.prompts).toHaveLength(1));
    expect(isClaudeContextPreflightPrompt(recoveredClient.session.prompts[0]!)).toBe(true);
    recoveredClient.session.complete();
    await vi.waitFor(() =>
      expect(recoveredClient.session.prompts[1]).toBe(
        "continue exactly once after the daemon restart",
      ),
    );
    recoveredClient.session.complete();
    await vi.waitFor(async () => {
      await expect(reloaded.listPendingPrompts(scenario.agentId)).resolves.toEqual([]);
    });
  } finally {
    await recoveredManager?.closeAgent(scenario.agentId).catch(() => undefined);
    await recoveredManager?.flush().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("daemon recovery does not repeat a compact whose exact boundary receipt was persisted", async () => {
  const scenario = await createContextPreflightScenario({ retryDelayMs: 5 });
  let recoveredManager: AgentManager | undefined;
  try {
    await scenario.agentManager.flush();
    await scenario.storage.enqueuePendingPrompt(scenario.agentId, {
      id: "message-after-persisted-boundary",
      prompt: "continue after the already completed compact",
    });
    await scenario.storage.claimPendingPrompt(scenario.agentId);
    await scenario.storage.insertPendingPromptPreflight(
      scenario.agentId,
      "message-after-persisted-boundary",
      {
        key: "claude_context_compaction",
        prompt: "/compact [PASEO_INTERNAL_CONTEXT_PREFLIGHT] preserve state",
      },
    );
    const preflight = await scenario.storage.claimPendingPrompt(scenario.agentId);
    if (!preflight) throw new Error("Expected claimed preflight");
    await scenario.storage.recordPendingPromptPreflightBoundary(scenario.agentId, preflight.id);
    const stored = await scenario.storage.get(scenario.agentId);
    if (!stored) throw new Error("Expected stored agent");
    await scenario.storage.upsert({
      ...stored,
      lastUsage: {
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 163_000,
      },
    });
    await scenario.storage.flush();

    const reloaded = new AgentStorage(join(scenario.workdir, "agents"), scenario.logger);
    const recoveredClient = new QueuedPromptAgentClient();
    recoveredManager = new AgentManager({
      clients: { "claude-acc": recoveredClient },
      registry: reloaded,
      logger: scenario.logger,
    });
    await resumePendingAgentPrompts({
      agentManager: recoveredManager,
      agentStorage: reloaded,
      logger: scenario.logger,
    });

    await vi.waitFor(() =>
      expect(recoveredClient.session.prompts).toEqual([
        "continue after the already completed compact",
      ]),
    );
    expect(recoveredClient.session.prompts.some(isClaudeContextPreflightPrompt)).toBe(false);
    expect(
      recoveredManager.getAgent(scenario.agentId)?.lastUsage?.contextWindowUsedTokens,
    ).toBeUndefined();
    await recoveredManager.flush();
    expect(
      (await reloaded.get(scenario.agentId))?.lastUsage?.contextWindowUsedTokens,
    ).toBeUndefined();
    recoveredClient.session.complete();
    await vi.waitFor(async () => {
      await expect(reloaded.listPendingPrompts(scenario.agentId)).resolves.toEqual([]);
    });
  } finally {
    await recoveredManager?.closeAgent(scenario.agentId).catch(() => undefined);
    await recoveredManager?.flush().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("daemon recovery never infers a compact boundary from a stale low usage value", async () => {
  const scenario = await createContextPreflightScenario({ retryDelayMs: 5 });
  let recoveredManager: AgentManager | undefined;
  try {
    await scenario.agentManager.flush();
    await scenario.storage.enqueuePendingPrompt(scenario.agentId, {
      id: "message-after-unproven-boundary",
      prompt: "compact before this request despite stale storage",
    });
    await scenario.storage.claimPendingPrompt(scenario.agentId);
    await scenario.storage.insertPendingPromptPreflight(
      scenario.agentId,
      "message-after-unproven-boundary",
      {
        key: "claude_context_compaction",
        prompt: "/compact [PASEO_INTERNAL_CONTEXT_PREFLIGHT] preserve state",
      },
    );
    await scenario.storage.claimPendingPrompt(scenario.agentId);
    const stored = await scenario.storage.get(scenario.agentId);
    if (!stored) throw new Error("Expected stored agent");
    await scenario.storage.upsert({
      ...stored,
      lastUsage: {
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 120_000,
      },
    });
    await scenario.storage.flush();

    const reloaded = new AgentStorage(join(scenario.workdir, "agents"), scenario.logger);
    const recoveredClient = new QueuedPromptAgentClient();
    recoveredManager = new AgentManager({
      clients: { "claude-acc": recoveredClient },
      registry: reloaded,
      logger: scenario.logger,
    });
    await resumePendingAgentPrompts({
      agentManager: recoveredManager,
      agentStorage: reloaded,
      logger: scenario.logger,
    });

    await vi.waitFor(() => expect(recoveredClient.session.prompts).toHaveLength(1));
    expect(isClaudeContextPreflightPrompt(recoveredClient.session.prompts[0]!)).toBe(true);
    recoveredClient.session.complete();
    await vi.waitFor(() =>
      expect(recoveredClient.session.prompts[1]).toBe(
        "compact before this request despite stale storage",
      ),
    );
    recoveredClient.session.complete();
  } finally {
    await recoveredManager?.closeAgent(scenario.agentId).catch(() => undefined);
    await recoveredManager?.flush().catch(() => undefined);
    await scenario.cleanup();
  }
});

test("releases a claimed user prompt when admission planning throws", async () => {
  const scenario = await createContextPreflightScenario({ retryDelayMs: 5 });
  try {
    const admission = vi
      .spyOn(scenario.client.session, "planPromptAdmission")
      .mockImplementationOnce(() => {
        throw new Error("admission probe failed");
      })
      .mockReturnValue({ type: "dispatch" });
    await scenario.storage.enqueuePendingPrompt(scenario.agentId, {
      id: "message-admission-exception",
      prompt: "run after the admission probe recovers",
    });

    await scenario.agentManager.drainStoredPendingPrompts(scenario.agentId);
    await expect(scenario.storage.listPendingPrompts(scenario.agentId)).resolves.toMatchObject([
      { id: "message-admission-exception", state: "queued" },
    ]);
    expect(scenario.client.session.prompts).toEqual([]);

    const recoveredDrain = scenario.agentManager.drainStoredPendingPrompts(scenario.agentId);
    await vi.waitFor(() =>
      expect(scenario.client.session.prompts).toEqual(["run after the admission probe recovers"]),
    );
    scenario.client.session.complete();
    await recoveredDrain;
    await vi.waitFor(async () => {
      await expect(scenario.storage.listPendingPrompts(scenario.agentId)).resolves.toEqual([]);
    });
    admission.mockRestore();
  } finally {
    await scenario.cleanup();
  }
});

test("completes a rejected queue item and continues with the next user prompt", async () => {
  const scenario = await createContextPreflightScenario({ retryDelayMs: 5 });
  try {
    const admission = vi
      .spyOn(scenario.client.session, "planPromptAdmission")
      .mockReturnValueOnce({ type: "reject", message: "message exceeds safe context limit" })
      .mockReturnValue({ type: "dispatch" });
    await scenario.storage.enqueuePendingPrompt(scenario.agentId, {
      id: "message-rejected",
      prompt: "an oversized message",
    });
    await scenario.storage.enqueuePendingPrompt(scenario.agentId, {
      id: "message-after-rejected",
      prompt: "a later independent request",
    });

    const drain = scenario.agentManager.drainStoredPendingPrompts(scenario.agentId);
    await vi.waitFor(() =>
      expect(scenario.client.session.prompts).toEqual(["a later independent request"]),
    );
    await expect(scenario.storage.listPendingPrompts(scenario.agentId)).resolves.toMatchObject([
      { id: "message-after-rejected", state: "dispatching" },
    ]);
    expect(scenario.agentManager.getTimeline(scenario.agentId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "user_message",
          text: "an oversized message",
          clientMessageId: "message-rejected",
        }),
      ]),
    );
    expect(scenario.agentManager.hasSubmittedPrompt(scenario.agentId, "message-rejected")).toBe(
      false,
    );
    scenario.client.session.complete();
    await drain;
    await vi.waitFor(async () => {
      await expect(scenario.storage.listPendingPrompts(scenario.agentId)).resolves.toEqual([]);
    });
    admission.mockRestore();
  } finally {
    await scenario.cleanup();
  }
});

test("does not treat a locally rejected timeline row as provider submission", async () => {
  const scenario = await createContextPreflightScenario({ retryDelayMs: 5 });
  try {
    const admission = vi
      .spyOn(scenario.client.session, "planPromptAdmission")
      .mockReturnValueOnce({ type: "reject", message: "message exceeds safe context limit" })
      .mockReturnValue({ type: "dispatch" });
    const messageId = "message-rejected-then-retried";
    const prompt = "retry this literal only after admission changes";
    await scenario.storage.enqueuePendingPrompt(scenario.agentId, { id: messageId, prompt });
    await scenario.agentManager.drainStoredPendingPrompts(scenario.agentId);

    expect(scenario.agentManager.hasSubmittedPrompt(scenario.agentId, messageId)).toBe(false);
    expect(
      scenario.agentManager
        .getTimeline(scenario.agentId)
        .filter((item) => item.type === "user_message" && item.clientMessageId === messageId),
    ).toEqual([expect.objectContaining({ deliveryStatus: "rejected", text: prompt })]);

    await scenario.storage.enqueuePendingPrompt(scenario.agentId, { id: messageId, prompt });
    const retry = scenario.agentManager.drainStoredPendingPrompts(scenario.agentId);
    await vi.waitFor(() => expect(scenario.client.session.prompts).toEqual([prompt]));
    expect(scenario.agentManager.hasSubmittedPrompt(scenario.agentId, messageId)).toBe(true);
    expect(
      scenario.agentManager
        .getTimeline(scenario.agentId)
        .filter((item) => item.type === "user_message" && item.clientMessageId === messageId),
    ).toEqual([expect.not.objectContaining({ deliveryStatus: "rejected" })]);
    scenario.client.session.complete();
    await retry;
    admission.mockRestore();
  } finally {
    await scenario.cleanup();
  }
});

test("queues an in-flight steer when high context requires compaction", async () => {
  const logger = createTestLogger();
  const steerOrReplaceActiveTurn = vi.fn(async () => ({ status: "steered" as const }));
  const agentManager = Object.create(AgentManager.prototype) as AgentManager;
  Reflect.set(agentManager, "getAgent", () => ({
    provider: "claude-acc",
    persistence: null,
    capabilities: { supportsInFlightSteering: true },
    pendingPermissions: new Map(),
  }));
  Reflect.set(agentManager, "planPromptAdmission", () => ({
    type: "preflight",
    key: "claude_context_compaction",
    prompt: "/compact [PASEO_INTERNAL_CONTEXT_PREFLIGHT] preserve state",
  }));
  Reflect.set(agentManager, "hasInFlightRun", () => true);
  Reflect.set(agentManager, "tryRunOutOfBand", () => false);
  Reflect.set(agentManager, "hasSubmittedPrompt", () => false);
  Reflect.set(agentManager, "drainStoredPendingPrompts", async () => undefined);
  Reflect.set(agentManager, "steerOrReplaceActiveTurn", steerOrReplaceActiveTurn);
  const agentStorage = Object.create(AgentStorage.prototype) as AgentStorage;
  Reflect.set(agentStorage, "get", async () => null);
  const enqueuePendingPrompt = vi.fn(async () => ({ enqueued: true, position: 1 }));
  Reflect.set(agentStorage, "enqueuePendingPrompt", enqueuePendingPrompt);

  await expect(
    sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: "running-agent",
      prompt: "change direction without interrupting",
      activeTurnBehavior: "steer",
      logger,
    }),
  ).resolves.toEqual({ disposition: "queued" });
  expect(steerOrReplaceActiveTurn).not.toHaveBeenCalled();
  expect(enqueuePendingPrompt).toHaveBeenCalledWith(
    "running-agent",
    expect.objectContaining({ prompt: "change direction without interrupting" }),
  );
});

test("rejects a user message id in Paseo's reserved preflight namespace", async () => {
  const logger = createTestLogger();
  await expect(
    sendPromptToAgent({
      agentManager: Object.create(AgentManager.prototype) as AgentManager,
      agentStorage: Object.create(AgentStorage.prototype) as AgentStorage,
      agentId: "direct-agent",
      prompt: "keep this visible",
      messageId: "paseo-internal-preflight:user-spoof",
      logger,
    }),
  ).rejects.toThrow("reserved internal prefix");
});

test("queues an ordinary steer while the synthetic compact turn owns the provider", async () => {
  const scenario = await createContextPreflightScenario();
  try {
    await sendPromptToAgent({
      agentManager: scenario.agentManager,
      agentStorage: scenario.storage,
      agentId: scenario.agentId,
      prompt: "first request after compact",
      messageId: "message-after-synthetic",
      activeTurnBehavior: "queue",
      logger: scenario.logger,
    });
    await vi.waitFor(() => expect(scenario.client.session.prompts).toHaveLength(1));
    expect(isClaudeContextPreflightPrompt(scenario.client.session.prompts[0]!)).toBe(true);

    await expect(
      sendPromptToAgent({
        agentManager: scenario.agentManager,
        agentStorage: scenario.storage,
        agentId: scenario.agentId,
        prompt: "follow-up sent during compact",
        messageId: "message-during-synthetic",
        activeTurnBehavior: "steer",
        logger: scenario.logger,
      }),
    ).resolves.toEqual({ disposition: "queued" });
    expect(scenario.client.session.prompts).toHaveLength(1);
    await expect(scenario.storage.listPendingPrompts(scenario.agentId)).resolves.toMatchObject([
      { id: expect.stringMatching(/^paseo-internal-preflight:/), state: "dispatching" },
      { id: "message-after-synthetic", state: "queued" },
      { id: "message-during-synthetic", state: "queued" },
    ]);

    scenario.client.session.complete();
    await vi.waitFor(() =>
      expect(scenario.client.session.prompts[1]).toBe("first request after compact"),
    );
    scenario.client.session.complete();
    await vi.waitFor(() =>
      expect(scenario.client.session.prompts[2]).toBe("follow-up sent during compact"),
    );
    scenario.client.session.complete();
    await vi.waitFor(async () => {
      await expect(scenario.storage.listPendingPrompts(scenario.agentId)).resolves.toEqual([]);
    });
  } finally {
    await scenario.cleanup();
  }
});

test("serializes all queue-mode prompts through one durable FIFO", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-durable-prompt-queue-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new QueuedPromptAgentClient();
  const agentManager = new AgentManager({
    clients: { "claude-acc": client },
    registry: storage,
    logger,
  });
  const snapshot = await agentManager.createAgent(
    { provider: "claude-acc", cwd: workdir },
    undefined,
    { workspaceId: undefined },
  );

  try {
    await expect(
      sendPromptToAgent({
        agentManager,
        agentStorage: storage,
        agentId: snapshot.id,
        prompt: "first request",
        messageId: "message-1",
        activeTurnBehavior: "queue",
        logger,
      }),
    ).resolves.toEqual({ disposition: "queued" });
    await vi.waitFor(() => expect(client.session.prompts).toEqual(["first request"]));

    await expect(
      sendPromptToAgent({
        agentManager,
        agentStorage: storage,
        agentId: snapshot.id,
        prompt: "second request",
        messageId: "message-2",
        activeTurnBehavior: "queue",
        logger,
      }),
    ).resolves.toEqual({ disposition: "queued" });
    expect(client.session.prompts).toEqual(["first request"]);
    expect(client.session.interruptCount).toBe(0);
    await expect(storage.listPendingPrompts(snapshot.id)).resolves.toMatchObject([
      { id: "message-1", prompt: "first request", state: "dispatching" },
      { id: "message-2", prompt: "second request", state: "queued" },
    ]);

    client.session.complete();
    await vi.waitFor(() =>
      expect(client.session.prompts).toEqual(["first request", "second request"]),
    );
    expect(client.session.interruptCount).toBe(0);
    client.session.complete();
    await vi.waitFor(async () => {
      await expect(storage.listPendingPrompts(snapshot.id)).resolves.toEqual([]);
    });
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    await agentManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("falls back from unsafe in-flight steering to the durable FIFO", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-durable-prompt-steer-fallback-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new QueuedPromptAgentClient();
  const agentManager = new AgentManager({
    clients: { "claude-acc": client },
    registry: storage,
    logger,
  });
  const snapshot = await agentManager.createAgent(
    { provider: "claude-acc", cwd: workdir },
    undefined,
    { workspaceId: undefined },
  );

  try {
    await sendPromptToAgent({
      agentManager,
      agentStorage: storage,
      agentId: snapshot.id,
      prompt: "first request",
      messageId: "message-1",
      activeTurnBehavior: "queue",
      logger,
    });
    await vi.waitFor(() => expect(client.session.prompts).toEqual(["first request"]));

    await expect(
      sendPromptToAgent({
        agentManager,
        agentStorage: storage,
        agentId: snapshot.id,
        prompt: "follow-up while working",
        messageId: "message-2",
        activeTurnBehavior: "steer",
        logger,
      }),
    ).resolves.toEqual({ disposition: "queued" });

    expect(client.session.prompts).toEqual(["first request"]);
    expect(client.session.interruptCount).toBe(0);
    await expect(storage.listPendingPrompts(snapshot.id)).resolves.toMatchObject([
      { id: "message-1", state: "dispatching" },
      { id: "message-2", prompt: "follow-up while working", state: "queued" },
    ]);

    client.session.complete();
    await vi.waitFor(() =>
      expect(client.session.prompts).toEqual(["first request", "follow-up while working"]),
    );
    client.session.complete();
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    await agentManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("routes an idle unsafe steer through the durable FIFO before starting it", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-durable-prompt-idle-steer-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const enqueueSpy = vi.spyOn(storage, "enqueuePendingPrompt");
  const client = new QueuedPromptAgentClient();
  const agentManager = new AgentManager({
    clients: { "claude-acc": client },
    registry: storage,
    logger,
  });
  const snapshot = await agentManager.createAgent(
    { provider: "claude-acc", cwd: workdir },
    undefined,
    { workspaceId: undefined },
  );

  try {
    await expect(
      sendPromptToAgent({
        agentManager,
        agentStorage: storage,
        agentId: snapshot.id,
        prompt: "idle follow-up",
        messageId: "message-idle-steer",
        activeTurnBehavior: "steer",
        logger,
      }),
    ).resolves.toEqual({ disposition: "queued" });

    expect(enqueueSpy).toHaveBeenCalledWith(snapshot.id, {
      id: "message-idle-steer",
      prompt: "idle follow-up",
    });
    await vi.waitFor(() => expect(client.session.prompts).toEqual(["idle follow-up"]));
    client.session.complete();
    await vi.waitFor(async () => {
      await expect(storage.listPendingPrompts(snapshot.id)).resolves.toEqual([]);
    });
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    await agentManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("retires a permission-blocked unsafe turn before replacing it", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-permission-steer-replacement-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new QueuedPromptAgentClient();
  const agentManager = new AgentManager({
    clients: { "claude-acc": client },
    registry: storage,
    logger,
  });
  const snapshot = await agentManager.createAgent(
    { provider: "claude-acc", cwd: workdir },
    undefined,
    { workspaceId: undefined },
  );

  try {
    await sendPromptToAgent({
      agentManager,
      agentStorage: storage,
      agentId: snapshot.id,
      prompt: "request awaiting approval",
      messageId: "message-before-permission",
      activeTurnBehavior: "queue",
      logger,
    });
    await vi.waitFor(() => expect(client.session.prompts).toEqual(["request awaiting approval"]));

    const live = agentManager.getAgent(snapshot.id);
    if (!live) throw new Error("Expected live test agent");
    live.pendingPermissions.set("permission-1", {
      id: "permission-1",
      provider: "claude-acc",
      name: "ExitPlanMode",
      kind: "plan",
    } satisfies AgentPermissionRequest);

    await expect(
      sendPromptToAgent({
        agentManager,
        agentStorage: storage,
        agentId: snapshot.id,
        prompt: "replace the blocked plan",
        messageId: "message-after-permission",
        activeTurnBehavior: "steer",
        clearPendingPermissions: true,
        logger,
      }),
    ).resolves.toEqual({ disposition: "turn_started" });

    expect(client.session.interruptCount).toBe(1);
    expect(client.session.prompts).toEqual([
      "request awaiting approval",
      "replace the blocked plan",
    ]);
    expect(agentManager.getAgent(snapshot.id)?.pendingPermissions.size).toBe(0);
    client.session.complete();
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    await agentManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a repeated client message id is not enqueued after provider acceptance", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-durable-prompt-dedupe-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new QueuedPromptAgentClient();
  const agentManager = new AgentManager({
    clients: { "claude-acc": client },
    registry: storage,
    logger,
  });
  const snapshot = await agentManager.createAgent(
    { provider: "claude-acc", cwd: workdir },
    undefined,
    { workspaceId: undefined },
  );

  try {
    const send = (prompt: string) =>
      sendPromptToAgent({
        agentManager,
        agentStorage: storage,
        agentId: snapshot.id,
        prompt,
        messageId: "stable-message-id",
        activeTurnBehavior: "queue",
        logger,
      });
    await send("run this once");
    await vi.waitFor(() => expect(client.session.prompts).toEqual(["run this once"]));
    await expect(send("browser retried this request")).resolves.toEqual({
      disposition: "queued",
    });
    expect(client.session.prompts).toEqual(["run this once"]);
    await expect(storage.listPendingPrompts(snapshot.id)).resolves.toHaveLength(1);

    client.session.complete();
    await vi.waitFor(async () => {
      await expect(storage.listPendingPrompts(snapshot.id)).resolves.toEqual([]);
    });
    await send("browser retried after completion");
    expect(client.session.prompts).toEqual(["run this once"]);
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    await agentManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a terminal failure advances the durable prompt FIFO instead of wedging it", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-durable-prompt-failure-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new QueuedPromptAgentClient();
  const agentManager = new AgentManager({
    clients: { "claude-acc": client },
    registry: storage,
    logger,
  });
  const snapshot = await agentManager.createAgent(
    { provider: "claude-acc", cwd: workdir },
    undefined,
    { workspaceId: undefined },
  );
  const send = (prompt: string, messageId: string) =>
    sendPromptToAgent({
      agentManager,
      agentStorage: storage,
      agentId: snapshot.id,
      prompt,
      messageId,
      activeTurnBehavior: "queue",
      logger,
    });

  try {
    await send("first request", "message-1");
    await vi.waitFor(() => expect(client.session.prompts).toEqual(["first request"]));
    await send("second request", "message-2");
    await send("third request", "message-3");

    client.session.fail();
    await vi.waitFor(() =>
      expect(client.session.prompts).toEqual(["first request", "second request"]),
    );
    client.session.fail();
    await vi.waitFor(() =>
      expect(client.session.prompts).toEqual(["first request", "second request", "third request"]),
    );
    client.session.complete();
    await vi.waitFor(async () => {
      await expect(storage.listPendingPrompts(snapshot.id)).resolves.toEqual([]);
    });
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    await agentManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a retryable pre-work API failure retains the durable prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-durable-prompt-transient-api-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new QueuedPromptAgentClient();
  const agentManager = new AgentManager({
    clients: { "claude-acc": client },
    registry: storage,
    logger,
  });
  const snapshot = await agentManager.createAgent(
    { provider: "claude-acc", cwd: workdir },
    undefined,
    { workspaceId: undefined },
  );

  try {
    await sendPromptToAgent({
      agentManager,
      agentStorage: storage,
      agentId: snapshot.id,
      prompt: "run this after the gateway recovers",
      messageId: "message-transient-api",
      activeTurnBehavior: "queue",
      logger,
    });
    await vi.waitFor(() =>
      expect(client.session.prompts).toEqual(["run this after the gateway recovers"]),
    );

    client.session.fail("API Error: 502 status code (no body)", "retryable_api");

    await vi.waitFor(async () => {
      await expect(storage.listPendingPrompts(snapshot.id)).resolves.toMatchObject([
        {
          id: "message-transient-api",
          prompt: "run this after the gateway recovers",
          state: "queued",
          attemptCount: 1,
        },
      ]);
    });
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    await agentManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a retained transient prompt retries automatically as a continuation", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-durable-prompt-transient-retry-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new QueuedPromptAgentClient();
  const agentManager = new AgentManager({
    clients: { "claude-acc": client },
    registry: storage,
    transientPromptRetryBaseDelayMs: 5,
    transientPromptRetryMaxDelayMs: 5,
    logger,
  });
  const snapshot = await agentManager.createAgent(
    { provider: "claude-acc", cwd: workdir },
    undefined,
    { workspaceId: undefined },
  );

  try {
    await sendPromptToAgent({
      agentManager,
      agentStorage: storage,
      agentId: snapshot.id,
      prompt: "finish the interrupted regression",
      messageId: "message-transient-retry",
      activeTurnBehavior: "queue",
      logger,
    });
    await vi.waitFor(() =>
      expect(client.session.prompts).toEqual(["finish the interrupted regression"]),
    );

    client.session.fail("API Error: 502 status code (no body)", "retryable_api");

    await vi.waitFor(() => expect(client.session.prompts).toHaveLength(2));
    expect(client.session.prompts[1]).toContain("<paseo-system>");
    expect(client.session.prompts[1]).toContain("Continue that unfinished request now");
    client.session.complete();
    await vi.waitFor(async () => {
      await expect(storage.listPendingPrompts(snapshot.id)).resolves.toEqual([]);
    });
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    await agentManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("daemon recovery preserves a queued retry whose user message is already recorded", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-durable-prompt-transient-restart-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new QueuedPromptAgentClient();
  const agentManager = new AgentManager({
    clients: { "claude-acc": client },
    registry: storage,
    logger,
  });
  const snapshot = await agentManager.createAgent(
    { provider: "claude-acc", cwd: workdir },
    undefined,
    { workspaceId: undefined },
  );

  try {
    await storage.enqueuePendingPrompt(snapshot.id, {
      id: "message-transient-restart",
      prompt: "finish after both the API and daemon recover",
    });
    await storage.claimPendingPrompt(snapshot.id);
    await storage.releasePendingPrompt(snapshot.id, "message-transient-restart");
    await agentManager.appendTimelineItem(snapshot.id, {
      type: "user_message",
      text: "finish after both the API and daemon recover",
      clientMessageId: "message-transient-restart",
    });

    await resumePendingAgentPrompts({
      agentManager,
      agentStorage: storage,
      logger,
    });
    await vi.waitFor(() => expect(client.session.prompts).toHaveLength(1));
    expect(client.session.prompts[0]).toContain("<paseo-system>");
    expect(client.session.prompts[0]).toContain("Continue that unfinished request now");
    client.session.complete();
    await vi.waitFor(async () => {
      await expect(storage.listPendingPrompts(snapshot.id)).resolves.toEqual([]);
    });
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    await agentManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("daemon recovery reclaims an interrupted dispatch without blocking startup", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-durable-prompt-restart-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new QueuedPromptAgentClient();
  const agentManager = new AgentManager({
    clients: { "claude-acc": client },
    registry: storage,
    logger,
  });
  const snapshot = await agentManager.createAgent(
    { provider: "claude-acc", cwd: workdir },
    undefined,
    { workspaceId: undefined },
  );

  try {
    await storage.enqueuePendingPrompt(snapshot.id, {
      id: "stable-recovery-message",
      prompt: "resume this after daemon restart",
    });
    await storage.claimPendingPrompt(snapshot.id);

    await resumePendingAgentPrompts({
      agentManager,
      agentStorage: storage,
      logger,
    });
    await vi.waitFor(() =>
      expect(client.session.prompts).toEqual(["resume this after daemon restart"]),
    );
    await expect(storage.listPendingPrompts(snapshot.id)).resolves.toMatchObject([
      { id: "stable-recovery-message", state: "dispatching", attemptCount: 2 },
    ]);

    client.session.complete();
    await vi.waitFor(async () => {
      await expect(storage.listPendingPrompts(snapshot.id)).resolves.toEqual([]);
    });
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    await agentManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("daemon recovery retires a dispatch already committed to the durable timeline", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-durable-prompt-committed-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new QueuedPromptAgentClient();
  const agentManager = new AgentManager({
    clients: { "claude-acc": client },
    registry: storage,
    logger,
  });
  const snapshot = await agentManager.createAgent(
    { provider: "claude-acc", cwd: workdir },
    undefined,
    { workspaceId: undefined },
  );

  try {
    await storage.enqueuePendingPrompt(snapshot.id, {
      id: "accepted-before-restart",
      prompt: "do not replay me",
    });
    await storage.claimPendingPrompt(snapshot.id);
    await agentManager.appendTimelineItem(snapshot.id, {
      type: "user_message",
      text: "do not replay me",
      clientMessageId: "accepted-before-restart",
    });

    await resumePendingAgentPrompts({
      agentManager,
      agentStorage: storage,
      logger,
    });
    await expect(storage.listPendingPrompts(snapshot.id)).resolves.toEqual([]);
    expect(client.session.prompts).toEqual([]);
  } finally {
    await agentManager.closeAgent(snapshot.id).catch(() => undefined);
    await agentManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

/**
 * Real AgentManager driving a real agent, so the run-start wait exercises the production
 * run-state and agent_state subscription path rather than a replaced method.
 */
async function createRunStartScenario(startDelayMs: number | null): Promise<{
  agentManager: AgentManager;
  agentId: string;
  startRun: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const workdir = mkdtempSync(join(tmpdir(), "agent-run-start-budget-"));
  const client = new SlowStartAgentClient(startDelayMs);
  const agentManager = new AgentManager({
    clients: { codex: client },
    logger: createTestLogger(),
  });
  const snapshot = await agentManager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  let drained: Promise<void> = Promise.resolve();
  return {
    agentManager,
    agentId: snapshot.id,
    // streamAgent registers the pending run synchronously, so the wait always observes it.
    startRun: async () => {
      const run = agentManager.streamAgent(snapshot.id, "start the run");
      drained = (async () => {
        for await (const _event of run) {
          // Drain whatever the turn produces.
        }
      })().catch(() => undefined);
    },
    cleanup: async () => {
      // Release any turn still held open, then close. The drain is deliberately not
      // awaited: depending on how far the turn got, the stream ends either from the
      // release or from the close, and teardown must not depend on which.
      for (const session of client.sessions) {
        session.release();
      }
      await agentManager.closeAgent(snapshot.id).catch(() => undefined);
      void drained;
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

test("waiting for a run start outlasts the slowest provider startup budget", async () => {
  // A provider is still allowed to be starting here, so the outer wait must not abort it.
  const scenario = await createRunStartScenario(SLOWEST_PROVIDER_STARTUP_BUDGET_MS + 5_000);
  vi.useFakeTimers();

  try {
    await scenario.startRun();
    const wait = waitForAgentRunStartWithTimeout(scenario.agentManager, scenario.agentId);
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void wait.then(markSettled, markSettled);

    await vi.advanceTimersByTimeAsync(SLOWEST_PROVIDER_STARTUP_BUDGET_MS);
    expect(settled).toBe(false);
    expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).not.toBe("running");

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(wait).resolves.toBeUndefined();
    expect(scenario.agentManager.getAgent(scenario.agentId)?.lifecycle).toBe("running");
  } finally {
    vi.useRealTimers();
    await scenario.cleanup();
  }
});

test("waiting for a run start still gives up at the run start budget", async () => {
  const scenario = await createRunStartScenario(null);
  vi.useFakeTimers();

  try {
    await scenario.startRun();
    const wait = waitForAgentRunStartWithTimeout(scenario.agentManager, scenario.agentId);
    const rejection = expect(wait).rejects.toThrow(
      "codex run did not start within 60 seconds (phase: run start)",
    );
    let settled = false;
    const markSettled = () => {
      settled = true;
    };
    void wait.then(markSettled, markSettled);

    await vi.advanceTimersByTimeAsync(EXPECTED_RUN_START_BUDGET_MS - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
    await scenario.cleanup();
  }
});
