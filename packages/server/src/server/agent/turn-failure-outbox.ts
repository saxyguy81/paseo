import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

/** Deliberately excludes prompts, tool output, credentials and raw provider errors. */
export interface TurnFailureNotice {
  agentId: string;
  turnId: string;
  provider: string;
  code: string | null;
  failureKind: string | null;
}

export interface TurnFailureIncident extends TurnFailureNotice {
  version: 1;
  id: string;
  detectedAt: string;
}

export function incidentId(notice: TurnFailureNotice): string {
  return createHash("sha256")
    .update(JSON.stringify([notice.agentId, notice.turnId, notice.provider]))
    .digest("hex");
}

export function parseFailureDeliveryCommand(value: string | undefined): string[] | null {
  if (!value) return null;
  const command: unknown = JSON.parse(value);
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === "string" && part.length > 0)
  ) {
    throw new Error("PASEO_TURN_FAILURE_COMMAND must be a nonempty JSON argv array");
  }
  return command;
}

/** Optional operator integration; its configuration and lifecycle stay together. */
export async function startConfiguredFailureOutbox(input: {
  paseoHome: string;
  command: string | undefined;
  warn: (error: unknown) => void;
}) {
  const command = parseFailureDeliveryCommand(input.command);
  const outbox = command
    ? new TurnFailureOutbox(
        join(input.paseoHome, "turn-failure-outbox"),
        commandIncidentDelivery(command),
        input.warn,
      )
    : null;
  await outbox?.start();
  return {
    onTurnFailure: outbox ? (notice: TurnFailureNotice) => outbox.record(notice) : undefined,
    stop: async () => {
      await outbox?.stop();
    },
  };
}

/** One durable event per failed turn. Delivery retries run in code, never an LLM. */
export class TurnFailureOutbox {
  private draining: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly directory: string,
    private readonly deliver: (incident: TurnFailureIncident) => Promise<void>,
    private readonly warn: (error: unknown) => void,
  ) {}

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json\.tmp$/.test(name)) continue;
      const temp = join(this.directory, name);
      try {
        const record = JSON.parse(await readFile(temp, "utf8"));
        if (record.incident?.id !== name.slice(0, 64)) throw new Error("Incomplete incident");
        await rename(temp, temp.slice(0, -4));
      } catch {
        await unlink(temp);
      }
    }
    this.timer = setInterval(() => {
      void this.flush();
    }, 60_000);
    this.timer.unref();
    void this.flush();
  }

  async record(notice: TurnFailureNotice): Promise<void> {
    const id = incidentId(notice);
    const path = join(this.directory, `${id}.json`);
    // Atomic publishing prevents the delivery loop seeing a partial event.
    const temp = `${path}.tmp`;
    const incident: TurnFailureIncident = {
      version: 1,
      id,
      detectedAt: new Date().toISOString(),
      ...notice,
    };
    try {
      await readFile(path);
      return;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const file = await open(temp, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return null;
      throw error;
    });
    if (!file) return;
    try {
      await file.writeFile(JSON.stringify({ incident, delivered: false }));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
    void this.flush();
  }

  flush(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.drain()
      .catch(this.warn)
      .finally(() => {
        this.draining = null;
      });
    return this.draining;
  }

  private async drain(): Promise<void> {
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(this.directory, name);
      const record = JSON.parse(await readFile(path, "utf8"));
      if (record.delivered) continue;
      try {
        await this.deliver(record.incident);
        const temp = `${path}.receipt`;
        const file = await open(temp, "w", 0o600);
        try {
          await file.writeFile(JSON.stringify({ incident: record.incident, delivered: true }));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temp, path);
      } catch (error) {
        this.warn(error);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.draining;
  }
}

/** A trusted operator-specified executable receives JSON on stdin; no shell. */
export function commandIncidentDelivery(
  command: readonly string[],
): (incident: TurnFailureIncident) => Promise<void> {
  return (incident) =>
    new Promise((resolve, reject) => {
      const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new Error("Failure notification delivery timed out"));
      }, 20_000);
      child.on("error", (error) => {
        finish(error);
      });
      child.on("exit", (code) => {
        finish(code === 0 ? undefined : new Error(`Failure notification delivery exited ${code}`));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(JSON.stringify(incident));
    });
}
