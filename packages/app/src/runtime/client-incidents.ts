import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export type ClientIncident = Parameters<DaemonClient["reportDiagnosticIncident"]>[0];
interface StoredIncident extends ClientIncident {
  serverId: string;
  createdAt: number;
  delivered: boolean;
}
interface IncidentStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
const STORAGE_KEY = "paseo.client-incidents.v1";
const CODES = new Set([
  "client_history_failed",
  "client_history_empty",
  "client_render_failed",
  "client_connection_lost",
  "client_queue_failed",
]);

/** Persist metadata only; unavailable transport never blocks the user's action. */
export class ClientIncidentQueue {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private storage: IncidentStorage,
    private createId: () => string,
    private now = Date.now,
  ) {}

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => undefined).then(action);
    this.tail = next;
    return next;
  }

  private async read(): Promise<StoredIncident[]> {
    const raw = await this.storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Invalid client incident queue");
    return parsed.filter(
      (item): item is StoredIncident =>
        item &&
        typeof item.serverId === "string" &&
        typeof item.incidentId === "string" &&
        typeof item.createdAt === "number" &&
        typeof item.delivered === "boolean" &&
        (item.agentId === undefined || typeof item.agentId === "string") &&
        CODES.has(item.code) &&
        this.now() - item.createdAt < 7 * 86400_000,
    );
  }

  capture(serverId: string, code: ClientIncident["code"], agentId?: string): Promise<void> {
    return this.serialize(async () => {
      const records = await this.read();
      if (
        records.some(
          (item) =>
            item.serverId === serverId &&
            item.agentId === agentId &&
            item.code === code &&
            this.now() - item.createdAt < 300_000,
        )
      )
        return;
      records.push({
        serverId,
        code,
        ...(agentId ? { agentId } : {}),
        incidentId: this.createId(),
        createdAt: this.now(),
        delivered: false,
      });
      await this.storage.setItem(STORAGE_KEY, JSON.stringify(records.slice(-64)));
    });
  }

  flush(serverId: string, client: Pick<DaemonClient, "reportDiagnosticIncident">): Promise<void> {
    return this.serialize(async () => {
      const records = await this.read();
      for (const item of records) {
        if (item.serverId !== serverId || item.delivered) continue;
        const accepted = await client.reportDiagnosticIncident({
          incidentId: item.incidentId,
          code: item.code,
          ...(item.agentId ? { agentId: item.agentId } : {}),
        });
        // Unsupported or unconfigured daemons have not persisted the event.
        // Keep it until support returns, rather than treating false as delivery.
        if (!accepted) continue;
        item.delivered = true;
        await this.storage.setItem(STORAGE_KEY, JSON.stringify(records));
      }
    });
  }
}
