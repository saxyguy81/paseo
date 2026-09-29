import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentProvider } from "./agent-sdk-types.js";
import type {
  ProviderSubagentDescriptor,
  ProviderSubagentStatus,
  ProviderSubagentStoreEvent,
} from "./provider-subagents/store.js";
import type { TurnFailureNotice } from "./turn-failure-outbox.js";

/**
 * Provider background tasks (a Claude Monitor-owned `local_bash`, for example) run inside the
 * provider process. They die with the session that launched them: a daemon restart, a reload or a
 * rollover ends them without the provider ever reporting a terminal status. The ledger keeps a
 * durable record of each one so that ending is noticed, reported once, and shown after restart.
 *
 * It records identity, ownership and liveness only. Task semantics (what the command watches,
 * its output) stay with the provider.
 */
export type BackgroundMonitorStatus = ProviderSubagentStatus | "lost";

export type BackgroundMonitorLostReason = "daemon_restart" | "session_ended";

export interface BackgroundMonitorRecord {
  parentAgentId: string;
  subagentId: string;
  provider: AgentProvider;
  title: string | null;
  description: string | null;
  subtitle: string | null;
  status: BackgroundMonitorStatus;
  createdAt: string;
  lastObservedAt: string;
  /** Daemon boot that last observed the task running. A task cannot outlive its boot. */
  bootId: string;
  endedAt: string | null;
  lostReason: BackgroundMonitorLostReason | null;
  /** Set once the failure event is durably handed to the outbox. */
  reportedAt: string | null;
}

interface LedgerFile {
  version: 1;
  monitors: BackgroundMonitorRecord[];
}

const DEFAULT_RETAIN_ENDED_MS = 7 * 24 * 60 * 60_000;

function recordKey(parentAgentId: string, subagentId: string): string {
  return `${parentAgentId}\0${subagentId}`;
}

export function backgroundMonitorFailureNotice(record: BackgroundMonitorRecord): TurnFailureNotice {
  const lost = record.status === "lost";
  return {
    agentId: record.parentAgentId,
    turnId: `background-monitor:${record.subagentId}`,
    provider: record.provider,
    code: lost ? `background_monitor_${record.lostReason ?? "lost"}` : "background_monitor_failed",
    failureKind: lost ? "background_monitor_lost" : "background_monitor_failed",
  };
}

export class BackgroundMonitorLedger {
  private readonly records = new Map<string, BackgroundMonitorRecord>();
  private shuttingDown = false;
  private writing: Promise<void> = Promise.resolve();
  private reporting: Promise<void> = Promise.resolve();
  private readonly now: () => Date;
  private readonly retainEndedMs: number;

  constructor(
    private readonly options: {
      path: string;
      bootId: string;
      /** Durable, idempotent per notice. Absent means failures are only logged. */
      report?: (notice: TurnFailureNotice) => Promise<void>;
      warn: (error: unknown, message: string) => void;
      now?: () => Date;
      retainEndedMs?: number;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.retainEndedMs = options.retainEndedMs ?? DEFAULT_RETAIN_ENDED_MS;
  }

  /** Load the previous boot's records; anything still running then was ended by the restart. */
  async start(): Promise<void> {
    let file: LedgerFile | null = null;
    try {
      file = JSON.parse(await readFile(this.options.path, "utf8")) as LedgerFile;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        this.options.warn(error, "Background monitor ledger unreadable; starting empty");
      }
    }
    const nowIso = this.now().toISOString();
    const cutoff = this.now().getTime() - this.retainEndedMs;
    for (const record of file?.version === 1 ? file.monitors : []) {
      if (record.status === "running" && record.bootId !== this.options.bootId) {
        record.status = "lost";
        record.lostReason = "daemon_restart";
        record.endedAt = nowIso;
      }
      if (record.endedAt && Date.parse(record.endedAt) < cutoff) continue;
      this.records.set(recordKey(record.parentAgentId, record.subagentId), record);
    }
    await this.persist();
    await this.reportPending();
  }

  observe(event: ProviderSubagentStoreEvent): void {
    // Removal is a presentation reset (reload, rehydrate), not the end of the task.
    if (event.type !== "upsert") return;
    const subagent = event.subagent;
    const key = recordKey(subagent.parentAgentId, subagent.id);
    const previous = this.records.get(key);
    if (subagent.activityKind !== "background_task") {
      // A task moved back to the foreground is an ordinary command, never a monitor.
      if (previous && previous.status === "running") {
        this.records.delete(key);
        this.schedulePersist();
      }
      return;
    }
    if (previous?.endedAt) return;
    // Shutdown cancels every running child. The restart, not the user, ended these tasks; leave
    // them running so the next boot reports them lost.
    if (this.shuttingDown && subagent.status !== "running" && previous) return;
    this.records.set(key, this.recordFrom(subagent, previous));
    this.schedulePersist();
    if (subagent.status === "failed") void this.reportPending();
  }

  /** The provider session that owns these tasks is going away; its tasks go with it. */
  sessionEnded(parentAgentId: string): void {
    if (this.shuttingDown) return;
    const nowIso = this.now().toISOString();
    let changed = false;
    for (const record of this.records.values()) {
      if (record.parentAgentId !== parentAgentId || record.status !== "running") continue;
      record.status = "lost";
      record.lostReason = "session_ended";
      record.endedAt = nowIso;
      changed = true;
    }
    if (!changed) return;
    this.schedulePersist();
    void this.reportPending();
  }

  prepareForShutdown(): void {
    this.shuttingDown = true;
  }

  async flush(): Promise<void> {
    await this.reporting;
    await this.writing;
  }

  list(): BackgroundMonitorRecord[] {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  private recordFrom(
    subagent: ProviderSubagentDescriptor,
    previous: BackgroundMonitorRecord | undefined,
  ): BackgroundMonitorRecord {
    const running = subagent.status === "running";
    return {
      parentAgentId: subagent.parentAgentId,
      subagentId: subagent.id,
      provider: subagent.provider,
      title: subagent.title,
      description: subagent.description,
      subtitle: subagent.subtitle,
      status: subagent.status,
      createdAt: previous?.createdAt ?? subagent.createdAt,
      lastObservedAt: subagent.updatedAt,
      bootId: this.options.bootId,
      endedAt: running ? null : subagent.updatedAt,
      lostReason: null,
      reportedAt: previous?.reportedAt ?? null,
    };
  }

  private reportPending(): Promise<void> {
    // One pass at a time, so a notice is never handed over twice concurrently.
    this.reporting = this.reporting.then(() => this.reportPendingOnce());
    return this.reporting;
  }

  private async reportPendingOnce(): Promise<void> {
    for (const record of this.records.values()) {
      if (record.reportedAt || (record.status !== "lost" && record.status !== "failed")) continue;
      const notice = backgroundMonitorFailureNotice(record);
      if (!this.options.report) {
        this.options.warn(notice, "Background monitor ended with no failure outbox configured");
        record.reportedAt = this.now().toISOString();
        continue;
      }
      try {
        await this.options.report(notice);
        record.reportedAt = this.now().toISOString();
      } catch (error) {
        this.options.warn(error, "Background monitor failure remains unreported");
      }
    }
    await this.persist();
  }

  private schedulePersist(): void {
    void this.persist();
  }

  private persist(): Promise<void> {
    // Serialize writes; each one captures the state current when it runs.
    this.writing = this.writing
      .then(() => this.write())
      .catch((error) => {
        this.options.warn(error, "Background monitor ledger write failed");
      });
    return this.writing;
  }

  private async write(): Promise<void> {
    const file: LedgerFile = { version: 1, monitors: [...this.records.values()] };
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    const temp = `${this.options.path}.tmp`;
    await writeFile(temp, JSON.stringify(file), { mode: 0o600 });
    await rename(temp, this.options.path);
  }
}
