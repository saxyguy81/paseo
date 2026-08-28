import type { Logger } from "pino";

import {
  CONVERSATION_FAMILY_CURRENT_LABEL,
  CONVERSATION_FAMILY_PREDECESSOR_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { AgentProvider } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import {
  isContextOverflowFailureText,
  readTerminalContextOverflowFailure,
} from "./context-overflow.js";
import {
  buildConfigOverrides,
  buildSessionConfig,
  extractTimestamps,
  isStoredAgentProviderAvailable,
  toAgentPersistenceHandle,
} from "../persistence-hooks.js";

interface PendingAgentInitialization {
  promise: Promise<ManagedAgent>;
  options: { broadcastTimeline: boolean };
}

const pendingAgentInitializations = new Map<string, PendingAgentInitialization>();

export type AgentLoaderManager = Pick<
  AgentManager,
  | "createAgent"
  | "getAgent"
  | "getRegisteredProviderIds"
  | "hydrateTimelineFromProvider"
  | "resumeAgentFromPersistence"
> &
  Partial<Pick<AgentManager, "waitForAgentClose">>;

export interface EnsureAgentLoadedDeps {
  agentManager: AgentLoaderManager;
  agentStorage: AgentStorage;
  validProviders?: Iterable<AgentProvider>;
  broadcastTimeline?: boolean;
  logger: Logger;
}

export interface ContextOverflowReconciliationResult {
  predecessorId: string;
  successorId: string;
}

/**
 * Recover context overflows that were recorded before the daemon exited.
 * Loading the predecessor hydrates its native history so the fresh session
 * receives a bounded handoff rather than a copy of the exhausted transcript.
 */
export async function reconcileStoredContextOverflowContinuations(deps: {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}): Promise<ContextOverflowReconciliationResult[]> {
  const records = await deps.agentStorage.list();
  const recordById = new Map(records.map((record) => [record.id, record]));
  const candidates = records.filter((record) => {
    if (
      record.archivedAt ||
      record.internal ||
      (record.lastStatus !== "error" && !isContextOverflowFailureText(record.lastError))
    ) {
      return false;
    }
    const current = record.labels?.[CONVERSATION_FAMILY_CURRENT_LABEL]?.trim();
    if (!current || current === record.id) {
      return true;
    }
    const successor = recordById.get(current);
    return successor?.labels?.[CONVERSATION_FAMILY_PREDECESSOR_LABEL] === record.id;
  });

  const reconciled: ContextOverflowReconciliationResult[] = [];
  for (const predecessor of candidates) {
    try {
      await ensureAgentLoaded(predecessor.id, deps);
      const hydratedFailureText = readTerminalContextOverflowFailure(
        await deps.agentManager.getTimelineRows(predecessor.id),
      );
      const successorId = await deps.agentManager.ensureAgentContextOverflowContinuation(
        predecessor.id,
        hydratedFailureText ?? predecessor.lastError ?? undefined,
      );
      if (successorId && successorId !== predecessor.id) {
        reconciled.push({ predecessorId: predecessor.id, successorId });
      }
    } catch (error) {
      deps.logger.error(
        { err: error, agentId: predecessor.id },
        "Failed to reconcile persisted context overflow",
      );
    }
  }
  return reconciled;
}

export async function ensureUnarchivedAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps & {
    agentManager: AgentLoaderManager & Pick<AgentManager, "closeAgent">;
  },
): Promise<ManagedAgent> {
  const record = await deps.agentStorage.get(agentId);
  if (record?.archivedAt) {
    throw new Error(`Agent is archived: ${agentId}`);
  }

  const agent = await ensureAgentLoaded(agentId, deps);
  const latestRecord = await deps.agentStorage.get(agentId);
  if (latestRecord?.archivedAt) {
    await deps.agentManager.closeAgent(agentId).catch((error: unknown) => {
      deps.logger.warn({ err: error, agentId }, "Failed to close concurrently archived agent");
    });
    throw new Error(`Agent is archived: ${agentId}`);
  }

  return agent;
}

export async function ensureAgentLoaded(
  agentId: string,
  deps: EnsureAgentLoadedDeps,
): Promise<ManagedAgent> {
  await deps.agentManager.waitForAgentClose?.(agentId);

  const inflight = pendingAgentInitializations.get(agentId);
  if (inflight) {
    inflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
    return inflight.promise;
  }

  const existing = deps.agentManager.getAgent(agentId);
  if (existing) {
    return existing;
  }

  // A close may have started after the first barrier observed no in-flight
  // work. Once the live lookup is empty, this second barrier closes that gap
  // before storage-backed resume begins.
  await deps.agentManager.waitForAgentClose?.(agentId);

  const laterInflight = pendingAgentInitializations.get(agentId);
  if (laterInflight) {
    laterInflight.options.broadcastTimeline ||= deps.broadcastTimeline === true;
    return laterInflight.promise;
  }

  const pendingOptions = {
    broadcastTimeline: deps.broadcastTimeline === true,
  };
  const initPromise = (async () => {
    const record = await deps.agentStorage.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const validProviders = deps.validProviders ?? deps.agentManager.getRegisteredProviderIds();
    if (!isStoredAgentProviderAvailable(record, validProviders)) {
      throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
    }

    const handle = toAgentPersistenceHandle(validProviders, record.persistence);

    let snapshot: ManagedAgent;
    if (handle) {
      snapshot = await deps.agentManager.resumeAgentFromPersistence(
        handle,
        buildConfigOverrides(record),
        agentId,
        extractTimestamps(record),
        record.archivedAt ? { purpose: "history" } : undefined,
      );
      deps.logger.info({ agentId, provider: record.provider }, "Agent resumed from persistence");
    } else {
      const config = buildSessionConfig(record, {
        validProviders,
      });
      if (!config) {
        throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
      }
      snapshot = await deps.agentManager.createAgent(config, agentId, {
        labels: record.labels,
        workspaceId: record.workspaceId,
        owner: record.owner,
      });
      deps.logger.info({ agentId, provider: record.provider }, "Agent created from stored config");
    }

    await deps.agentManager.hydrateTimelineFromProvider(agentId, {
      broadcast: () => pendingOptions.broadcastTimeline,
    });
    return deps.agentManager.getAgent(agentId) ?? snapshot;
  })();

  const pending: PendingAgentInitialization = { promise: initPromise, options: pendingOptions };
  pendingAgentInitializations.set(agentId, pending);

  try {
    return await initPromise;
  } finally {
    const current = pendingAgentInitializations.get(agentId);
    if (current === pending) {
      pendingAgentInitializations.delete(agentId);
    }
  }
}
