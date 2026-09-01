import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONVERSATION_FAMILY_CURRENT_LABEL,
  CONVERSATION_FAMILY_ID_LABEL,
  CONVERSATION_FAMILY_NAME_LABEL,
  CONVERSATION_FAMILY_POSITION_LABEL,
  CONVERSATION_FAMILY_PREDECESSOR_LABEL,
  CONVERSATION_FAMILY_RESUME_MODEL_ROLLOVER_LABEL,
} from "@getpaseo/protocol/agent-labels";
import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { ensureAgentLoaded, reconcileStoredConversationContinuations } from "./agent-loading.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

test("loads archived records for history and active records with the interactive default", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-purpose-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const resumeOptions: Array<AgentResumeSessionOptions | undefined> = [];
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (
      config: AgentSessionConfig,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> => await baseClient.createSession(config, launchContext),
    resumeSession: async (
      handle: AgentPersistenceHandle,
      overrides?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
      options?: AgentResumeSessionOptions,
    ): Promise<AgentSession> => {
      resumeOptions.push(options);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";

  try {
    const archived = await manager.createAgent({ provider: "codex", cwd: root }, archivedId, {
      workspaceId: "workspace-archived",
    });
    await manager.archiveAgent(archived.id);

    const active = await manager.createAgent({ provider: "codex", cwd: root }, activeId, {
      workspaceId: "workspace-active",
    });
    await manager.closeAgent(active.id);

    await ensureAgentLoaded(archived.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await ensureAgentLoaded(active.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });

    expect(resumeOptions).toEqual([{ purpose: "history" }, undefined]);
  } finally {
    await Promise.all([
      manager.closeAgent(archivedId).catch(() => undefined),
      manager.closeAgent(activeId).catch(() => undefined),
    ]);
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  ["context overflow", "Prompt is too long", "context_overflow" as const],
  [
    "unresolved prior turn",
    "API Error: 409 Conversation has an unresolved prior request",
    "conversation_unresolved" as const,
  ],
  [
    "active-request ambiguity",
    "API Error: 409 Conversation already has an active request",
    "conversation_unresolved" as const,
  ],
  [
    "resumed-session model rejection",
    "There's an issue with the selected model (claude-opus-5). It may not exist or you may not have access to it. Run --model to pick a different model.",
    "resume_model_unavailable" as const,
  ],
])(
  "reconciles %s persisted across restart into one fresh continuation",
  async (_, failureText, failureKind) => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-loading-rollover-restart-"));
    const logger = createTestLogger();
    const storage = new AgentStorage(path.join(root, "agents"), logger);
    const baseClient = createTestAgentClients().codex;
    if (!baseClient) {
      throw new Error("expected Codex test client");
    }

    const predecessorId = "00000000-0000-4000-8000-000000000401";
    const successorId = "00000000-0000-4000-8000-000000000402";
    const setupManager = new AgentManager({
      clients: { codex: baseClient },
      registry: storage,
      logger,
    });

    try {
      const predecessor = await setupManager.createAgent(
        { provider: "codex", cwd: root },
        predecessorId,
        { initialTitle: "Interrupted review", workspaceId: "workspace-review" },
      );
      await setupManager.closeAgent(predecessor.id);
      await setupManager.flush();

      const stored = await storage.get(predecessor.id);
      if (!stored) throw new Error("expected persisted predecessor");
      await storage.upsert({
        ...stored,
        lastStatus: "error",
        lastError: null,
        lastFailureKind:
          failureKind === "resume_model_unavailable" ? failureKind : stored.lastFailureKind,
        requiresAttention: true,
        attentionReason: "error",
        attentionTimestamp: new Date().toISOString(),
      });

      let resumeCount = 0;
      let createCount = 0;
      const client: AgentClient = {
        provider: baseClient.provider,
        capabilities: baseClient.capabilities,
        createSession: async (config, launchContext) => {
          createCount += 1;
          return await baseClient.createSession(config, launchContext);
        },
        resumeSession: async (handle, overrides, launchContext, options) => {
          resumeCount += 1;
          const session = await baseClient.resumeSession(handle, overrides, launchContext, options);
          return new Proxy(session, {
            get(target, property) {
              if (property === "streamHistory") {
                return async function* (): AsyncGenerator<AgentStreamEvent> {
                  yield {
                    type: "timeline",
                    provider: "codex",
                    item: {
                      type: "user_message",
                      text: "Finish the interrupted review and report the remaining blockers.",
                    },
                  };
                  yield {
                    type: "timeline",
                    provider: "codex",
                    item: {
                      type: "assistant_message",
                      text: "The implementation is complete; the test matrix remains.",
                    },
                  };
                  yield {
                    type: "timeline",
                    provider: "codex",
                    item: {
                      type: "assistant_message",
                      text: failureText,
                    },
                  };
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        },
        fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
        isAvailable: async () => await baseClient.isAvailable(),
      };
      const restartedManager = new AgentManager({
        clients: { codex: client },
        registry: storage,
        logger,
        idFactory: () => successorId,
      });

      const reconciled = await reconcileStoredConversationContinuations({
        agentManager: restartedManager,
        agentStorage: storage,
        logger,
      });

      expect(resumeCount).toBe(1);
      expect(createCount).toBe(1);
      expect(reconciled).toEqual([{ predecessorId, successorId }]);
      await vi.waitFor(async () => {
        expect((await storage.get(predecessorId))?.archivedAt).toBeTruthy();
      });
      expect((await storage.get(predecessorId))?.labels[CONVERSATION_FAMILY_CURRENT_LABEL]).toBe(
        successorId,
      );
      expect((await storage.get(successorId))?.labels[CONVERSATION_FAMILY_PREDECESSOR_LABEL]).toBe(
        predecessorId,
      );

      await expect(
        reconcileStoredConversationContinuations({
          agentManager: restartedManager,
          agentStorage: storage,
          logger,
        }),
      ).resolves.toEqual([]);
      expect(resumeCount).toBe(1);
      expect(createCount).toBe(1);

      await restartedManager.closeAgent(successorId).catch(() => undefined);
      await restartedManager.flush().catch(() => undefined);
    } finally {
      await setupManager.closeAgent(predecessorId).catch(() => undefined);
      await setupManager.flush().catch(() => undefined);
      await storage.flush().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("reconciles a persisted second-generation model rejection into exactly one third member", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-repeat-model-rollover-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) throw new Error("expected Codex test client");

  const firstId = "00000000-0000-4000-8000-000000000421";
  const secondId = "00000000-0000-4000-8000-000000000422";
  const thirdId = "00000000-0000-4000-8000-000000000423";
  const familyId = "00000000-0000-4000-8000-000000000424";
  const familyName = "Repeated model recovery";
  const setupManager = new AgentManager({
    clients: { codex: baseClient },
    registry: storage,
    logger,
  });

  try {
    await setupManager.createAgent({ provider: "codex", cwd: root }, firstId, {
      initialTitle: familyName,
      workspaceId: "workspace-review",
      labels: {
        [CONVERSATION_FAMILY_ID_LABEL]: familyId,
        [CONVERSATION_FAMILY_CURRENT_LABEL]: secondId,
        [CONVERSATION_FAMILY_NAME_LABEL]: familyName,
        [CONVERSATION_FAMILY_POSITION_LABEL]: "0",
      },
    });
    await setupManager.createAgent({ provider: "codex", cwd: root }, secondId, {
      initialTitle: familyName,
      workspaceId: "workspace-review",
      labels: {
        [CONVERSATION_FAMILY_ID_LABEL]: familyId,
        [CONVERSATION_FAMILY_CURRENT_LABEL]: secondId,
        [CONVERSATION_FAMILY_NAME_LABEL]: familyName,
        [CONVERSATION_FAMILY_POSITION_LABEL]: "1",
        [CONVERSATION_FAMILY_PREDECESSOR_LABEL]: firstId,
        [CONVERSATION_FAMILY_RESUME_MODEL_ROLLOVER_LABEL]: "true",
      },
    });
    await setupManager.archiveAgent(firstId);
    await setupManager.closeAgent(secondId);
    await setupManager.flush();

    const second = await storage.get(secondId);
    if (!second) throw new Error("expected persisted second-generation member");
    await storage.upsert({
      ...second,
      lastStatus: "error",
      lastError:
        "There's an issue with the selected model (claude-opus-5). It may not exist or you may not have access to it.",
      lastFailureKind: "resume_model_unavailable",
      requiresAttention: true,
      attentionReason: "error",
      attentionTimestamp: new Date().toISOString(),
    });

    let resumeCount = 0;
    let createCount = 0;
    const client: AgentClient = {
      provider: baseClient.provider,
      capabilities: baseClient.capabilities,
      createSession: async (config, launchContext) => {
        createCount += 1;
        return await baseClient.createSession(config, launchContext);
      },
      resumeSession: async (handle, overrides, launchContext, options) => {
        resumeCount += 1;
        const session = await baseClient.resumeSession(handle, overrides, launchContext, options);
        return new Proxy(session, {
          get(target, property) {
            if (property === "streamHistory") {
              return async function* (): AsyncGenerator<AgentStreamEvent> {
                yield {
                  type: "timeline",
                  provider: "codex",
                  item: { type: "user_message", text: "Finish the interrupted review." },
                };
                yield {
                  type: "timeline",
                  provider: "codex",
                  item: { type: "assistant_message", text: "The diff is already reviewed." },
                };
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
      isAvailable: async () => await baseClient.isAvailable(),
    };
    const restartedManager = new AgentManager({
      clients: { codex: client },
      registry: storage,
      logger,
      idFactory: () => thirdId,
    });

    const reconciled = await reconcileStoredConversationContinuations({
      agentManager: restartedManager,
      agentStorage: storage,
      logger,
    });
    expect(reconciled).toEqual([{ predecessorId: secondId, successorId: thirdId }]);
    expect(resumeCount).toBe(1);
    expect(createCount).toBe(1);

    const records = await storage.list();
    expect(records).toHaveLength(3);
    expect(records.find((record) => record.id === thirdId)?.labels).toMatchObject({
      [CONVERSATION_FAMILY_ID_LABEL]: familyId,
      [CONVERSATION_FAMILY_CURRENT_LABEL]: thirdId,
      [CONVERSATION_FAMILY_POSITION_LABEL]: "2",
      [CONVERSATION_FAMILY_PREDECESSOR_LABEL]: secondId,
    });
    for (const record of records) {
      expect(record.labels[CONVERSATION_FAMILY_CURRENT_LABEL]).toBe(thirdId);
    }
    await expect(
      reconcileStoredConversationContinuations({
        agentManager: restartedManager,
        agentStorage: storage,
        logger,
      }),
    ).resolves.toEqual([]);
    expect(createCount).toBe(1);

    await restartedManager.closeAgent(thirdId).catch(() => undefined);
    await restartedManager.flush().catch(() => undefined);
  } finally {
    await setupManager.closeAgent(firstId).catch(() => undefined);
    await setupManager.closeAgent(secondId).catch(() => undefined);
    await setupManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("does not infer a resumed-session model rollover from transcript prose without durable classification", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-rollover-uncorroborated-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) throw new Error("expected Codex test client");

  const predecessorId = "00000000-0000-4000-8000-000000000411";
  const setupManager = new AgentManager({
    clients: { codex: baseClient },
    registry: storage,
    logger,
  });

  try {
    const predecessor = await setupManager.createAgent(
      { provider: "codex", cwd: root },
      predecessorId,
      {
        initialTitle: "Uncorroborated model error",
        workspaceId: "workspace-review",
      },
    );
    await setupManager.closeAgent(predecessor.id);
    await setupManager.flush();

    const stored = await storage.get(predecessor.id);
    if (!stored) throw new Error("expected persisted predecessor");
    await storage.upsert({
      ...stored,
      lastStatus: "error",
      lastError: null,
      lastFailureKind: null,
    });

    let createCount = 0;
    const client: AgentClient = {
      provider: baseClient.provider,
      capabilities: baseClient.capabilities,
      createSession: async (config, launchContext) => {
        createCount += 1;
        return await baseClient.createSession(config, launchContext);
      },
      resumeSession: async (handle, overrides, launchContext, options) => {
        const session = await baseClient.resumeSession(handle, overrides, launchContext, options);
        return new Proxy(session, {
          get(target, property) {
            if (property === "streamHistory") {
              return async function* (): AsyncGenerator<AgentStreamEvent> {
                yield {
                  type: "timeline",
                  provider: "codex",
                  item: { type: "user_message", text: "Continue the review." },
                };
                yield {
                  type: "timeline",
                  provider: "codex",
                  item: {
                    type: "assistant_message",
                    text: "There's an issue with the selected model (claude-opus-5). It may not exist or you may not have access to it. Run --model to pick a different model.",
                  },
                };
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
      fetchCatalog: async (options) => await baseClient.fetchCatalog(options),
      isAvailable: async () => await baseClient.isAvailable(),
    };
    const restartedManager = new AgentManager({
      clients: { codex: client },
      registry: storage,
      logger,
    });

    await expect(
      reconcileStoredConversationContinuations({
        agentManager: restartedManager,
        agentStorage: storage,
        logger,
      }),
    ).resolves.toEqual([]);
    expect(createCount).toBe(0);
    expect((await storage.list()).map((record) => record.id)).toEqual([predecessorId]);

    await restartedManager.closeAgent(predecessorId).catch(() => undefined);
    await restartedManager.flush().catch(() => undefined);
  } finally {
    await setupManager.closeAgent(predecessorId).catch(() => undefined);
    await setupManager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
