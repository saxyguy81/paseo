import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CONVERSATION_FAMILY_CURRENT_LABEL,
  CONVERSATION_FAMILY_ID_LABEL,
  CONVERSATION_FAMILY_POSITION_LABEL,
  CONVERSATION_FAMILY_PREDECESSOR_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { expect, test, vi } from "vitest";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunResult,
  AgentSession,
  AgentStreamEvent,
} from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

const CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

const MODES: AgentMode[] = [
  { id: "bypassPermissions", label: "Bypass permissions", description: "Do not ask" },
];

const MODELS: AgentModelDefinition[] = [
  { provider: "claude", id: "claude-opus-5", label: "Claude Opus 5" },
];

interface DeferredGate {
  promise: Promise<void>;
  release: () => void;
}

function createDeferredGate(): DeferredGate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

class ContextOverflowSession implements AgentSession {
  readonly provider = "claude" as const;
  readonly capabilities = CAPABILITIES;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnOrdinal = 0;

  constructor(
    readonly id: string,
    private readonly kind: "predecessor" | "successor",
    private readonly client: ContextOverflowClient,
  ) {}

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(prompt: AgentPromptInput): Promise<{ turnId: string }> {
    const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
    this.client.startedPrompts.push({ nativeSessionId: this.id, text });
    const turnId = `${this.kind}-turn-${++this.turnOrdinal}`;

    if (this.kind === "predecessor") {
      setTimeout(() => {
        this.emit({ type: "turn_started", provider: this.provider, turnId });
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "user_message",
            text: "Finish the MR review and report any remaining blockers.",
          },
        });
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: {
            type: "assistant_message",
            text: "The implementation review is complete. The test matrix remains.",
          },
        });
        void this.client.allowPredecessorOverflow.promise.then(() => {
          const overflow: AgentStreamEvent = {
            type: "turn_failed",
            provider: this.provider,
            turnId,
            error: "Prompt is too long",
            failureKind: "context_overflow",
          };
          this.emit(overflow);
          this.emit(overflow);
          return undefined;
        });
      }, 0);
      return { turnId };
    }

    const isHandoff = this.turnOrdinal === 1;
    if (isHandoff) this.client.successorTurnStarted.release();
    setTimeout(() => {
      this.emit({ type: "turn_started", provider: this.provider, turnId });
      if (!isHandoff) {
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "assistant_message", text: "The queued follow-up completed cleanly." },
        });
        this.emit({ type: "turn_completed", provider: this.provider, turnId });
      }
    }, 0);
    if (isHandoff) {
      void this.client.allowSuccessorCompletion.promise.then(() => {
        this.emit({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "assistant_message", text: "The rollover review completed cleanly." },
        });
        this.emit({ type: "turn_completed", provider: this.provider, turnId });
        return undefined;
      });
    }
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: "claude-opus-5",
      modeId: "bypassPermissions",
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return MODES;
  }

  async getCurrentMode(): Promise<string> {
    return "bypassPermissions";
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

class ContextOverflowClient implements AgentClient {
  readonly provider = "claude" as const;
  readonly capabilities = CAPABILITIES;
  readonly startedPrompts: Array<{ nativeSessionId: string; text: string }> = [];
  readonly createdSessionIds: string[] = [];
  readonly resumedSessionIds: string[] = [];
  readonly allowPredecessorOverflow = createDeferredGate();
  readonly successorTurnStarted = createDeferredGate();
  readonly allowSuccessorCompletion = createDeferredGate();

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    const nativeSessionId =
      this.createdSessionIds.length === 0
        ? "native-context-overflow-predecessor"
        : `native-context-overflow-successor-${this.createdSessionIds.length}`;
    this.createdSessionIds.push(nativeSessionId);
    return new ContextOverflowSession(
      nativeSessionId,
      this.createdSessionIds.length === 1 ? "predecessor" : "successor",
      this,
    );
  }

  async resumeSession(handle: AgentPersistenceHandle): Promise<AgentSession> {
    this.resumedSessionIds.push(handle.sessionId);
    throw new Error("Context overflow rollover must create a fresh native session");
  }

  async fetchCatalog() {
    return { models: MODELS, modes: MODES, defaultModeId: "bypassPermissions" };
  }
}

test("DaemonClient observes one clean fresh-session rollover after context overflow", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-context-overflow-e2e-"));
  const provider = new ContextOverflowClient();
  const daemon = await createTestPaseoDaemon({ agentClients: { claude: provider } });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  const oldTranscriptMarker = `old-transcript-marker-${"x".repeat(30_000)}`;

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "context-overflow-rollover-e2e" } });
    const predecessor = await client.createAgent({
      provider: "claude",
      cwd,
      title: "Long MR review",
      model: "claude-opus-5",
      modeId: "bypassPermissions",
    });

    await client.sendMessage(predecessor.id, oldTranscriptMarker);
    await client.waitForAgentUpsert(predecessor.id, (agent) => agent.status === "running", 5_000);
    await client.sendMessage(
      predecessor.id,
      "After rollover, verify the queued follow-up also runs.",
    );
    expect(provider.startedPrompts).toHaveLength(1);
    provider.allowPredecessorOverflow.release();
    await provider.successorTurnStarted.promise;

    let successorId: string | undefined;
    await vi.waitFor(async () => {
      const listing = await client.fetchAgents({ filter: { includeArchived: true } });
      successorId = listing.entries.find(
        (entry) => entry.agent.labels[CONVERSATION_FAMILY_PREDECESSOR_LABEL] === predecessor.id,
      )?.agent.id;
      expect(successorId).toBeTruthy();
    });
    const resolvedSuccessorId = successorId!;

    const runningSuccessor = await client.waitForAgentUpsert(
      resolvedSuccessorId,
      (agent) => agent.status === "running",
      5_000,
    );
    const archivedPredecessor = await client.fetchAgent({ agentId: predecessor.id });

    expect(provider.createdSessionIds).toEqual([
      "native-context-overflow-predecessor",
      "native-context-overflow-successor-1",
    ]);
    expect(provider.resumedSessionIds).toEqual([]);
    expect(runningSuccessor.persistence?.sessionId).toBe("native-context-overflow-successor-1");
    expect(archivedPredecessor?.agent.archivedAt).toBeTruthy();
    expect(archivedPredecessor?.agent.labels[CONVERSATION_FAMILY_ID_LABEL]).toBe(
      runningSuccessor.labels[CONVERSATION_FAMILY_ID_LABEL],
    );
    expect(archivedPredecessor?.agent.labels[CONVERSATION_FAMILY_CURRENT_LABEL]).toBe(
      resolvedSuccessorId,
    );
    expect(archivedPredecessor?.agent.labels[CONVERSATION_FAMILY_POSITION_LABEL]).toBe("0");
    expect(runningSuccessor.labels[CONVERSATION_FAMILY_CURRENT_LABEL]).toBe(resolvedSuccessorId);
    expect(runningSuccessor.labels[CONVERSATION_FAMILY_POSITION_LABEL]).toBe("1");
    expect(runningSuccessor.labels[CONVERSATION_FAMILY_PREDECESSOR_LABEL]).toBe(predecessor.id);

    expect(provider.startedPrompts).toHaveLength(2);
    const continuation = provider.startedPrompts[1];
    expect(continuation?.nativeSessionId).toBe("native-context-overflow-successor-1");
    expect(continuation?.text.length).toBeLessThanOrEqual(24_000);
    expect(continuation?.text).toContain("Finish the MR review and report any remaining blockers.");
    expect(continuation?.text).toContain(
      "The implementation review is complete. The test matrix remains.",
    );
    expect(continuation?.text).not.toContain("old-transcript-marker");

    provider.allowSuccessorCompletion.release();
    const completedSuccessor = await client.waitForAgentUpsert(
      resolvedSuccessorId,
      (agent) => agent.status === "idle",
      5_000,
    );
    expect(completedSuccessor.lastError).toBeUndefined();

    const timeline = await client.fetchAgentTimeline(resolvedSuccessorId, {
      direction: "tail",
      limit: 0,
      projection: "canonical",
    });
    expect(timeline.entries.map((entry) => entry.item)).toContainEqual({
      type: "assistant_message",
      text: "The rollover review completed cleanly.",
    });

    await vi.waitFor(() => expect(provider.startedPrompts).toHaveLength(3));
    expect(provider.startedPrompts[2]).toEqual({
      nativeSessionId: "native-context-overflow-successor-1",
      text: "After rollover, verify the queued follow-up also runs.",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(provider.createdSessionIds).toHaveLength(2);
    expect(provider.startedPrompts).toHaveLength(3);
  } finally {
    provider.allowPredecessorOverflow.release();
    provider.allowSuccessorCompletion.release();
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);
