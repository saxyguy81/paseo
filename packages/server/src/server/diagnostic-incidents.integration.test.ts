import { expect, test, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { DaemonClient } from "./test-utils/daemon-client.js";

test("client diagnostic RPC persists and delivers once through the real daemon outbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-diagnostic-delivery-"));
  const destination = join(root, "received.jsonl");
  const sink = join(root, "sink.cjs");
  await writeFile(
    sink,
    'let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>require("node:fs").appendFileSync(process.argv[2],s+"\\n"));',
  );
  vi.stubEnv("PASEO_TURN_FAILURE_COMMAND", JSON.stringify([process.execPath, sink, destination]));
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.7.2" });
  try {
    await client.connect();
    await client.fetchAgents();
    const incident = { incidentId: randomUUID(), code: "client_history_failed" as const };
    expect(await client.reportDiagnosticIncident(incident)).toBe(true);
    expect(await client.reportDiagnosticIncident(incident)).toBe(true);
    await expect
      .poll(
        async () =>
          (await readFile(destination, "utf8").catch(() => "")).trim().split("\n").filter(Boolean)
            .length,
      )
      .toBe(1);
    const delivered = JSON.parse((await readFile(destination, "utf8")).trim());
    expect(delivered).toMatchObject({
      turnId: incident.incidentId,
      code: incident.code,
      failureKind: "client_failure",
    });
    expect(Object.keys(delivered).sort()).toEqual(
      [
        "version",
        "id",
        "detectedAt",
        "agentId",
        "turnId",
        "provider",
        "code",
        "failureKind",
      ].sort(),
    );
  } finally {
    await client.close();
    await daemon.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
