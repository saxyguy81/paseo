import { afterEach, expect, test } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundMonitorLedger } from "./background-monitor-ledger.js";
import type {
  ProviderSubagentDescriptor,
  ProviderSubagentStoreEvent,
} from "./provider-subagents/store.js";
import { TurnFailureOutbox, type TurnFailureNotice } from "./turn-failure-outbox.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function ledgerPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-background-monitors-"));
  directories.push(directory);
  return join(directory, "background-monitors.json");
}

function upsert(overrides: Partial<ProviderSubagentDescriptor> = {}): ProviderSubagentStoreEvent {
  return {
    type: "upsert",
    subagent: {
      id: "task-1",
      parentAgentId: "agent-1",
      parentSubagentId: null,
      provider: "claude",
      title: "Background task",
      description: "watch the Diff UPF run",
      status: "running",
      createdAt: "2026-09-28T10:00:00.000Z",
      updatedAt: "2026-09-28T10:00:00.000Z",
      toolCallId: "tool-1",
      cwd: null,
      subtitle: null,
      activityKind: "background_task",
      ...overrides,
    },
  };
}

function ledger(
  path: string,
  bootId: string,
  reports: TurnFailureNotice[],
  now = () => new Date("2026-09-28T10:05:00.000Z"),
) {
  return new BackgroundMonitorLedger({
    path,
    bootId,
    report: async (notice) => {
      reports.push(notice);
    },
    warn: () => undefined,
    now,
  });
}

test("a monitor running at restart is reported lost exactly once across later restarts", async () => {
  const path = await ledgerPath();
  const reports: TurnFailureNotice[] = [];
  const first = ledger(path, "boot-1", reports);
  await first.start();
  first.observe(upsert());
  await first.flush();
  expect(first.list()[0]).toMatchObject({ status: "running", bootId: "boot-1" });

  const second = ledger(path, "boot-2", reports);
  await second.start();
  expect(second.list()[0]).toMatchObject({
    status: "lost",
    lostReason: "daemon_restart",
    parentAgentId: "agent-1",
  });
  expect(reports).toEqual([
    {
      agentId: "agent-1",
      turnId: "background-monitor:task-1",
      provider: "claude",
      code: "background_monitor_daemon_restart",
      failureKind: "background_monitor_lost",
    },
  ]);

  const third = ledger(path, "boot-3", reports);
  await third.start();
  expect(third.list()[0].status).toBe("lost");
  expect(reports).toHaveLength(1);
});

test("shutdown cancellation does not end a monitor; the next boot reports it lost", async () => {
  const path = await ledgerPath();
  const reports: TurnFailureNotice[] = [];
  const first = ledger(path, "boot-1", reports);
  await first.start();
  first.observe(upsert());
  first.prepareForShutdown();
  first.sessionEnded("agent-1");
  first.observe(upsert({ status: "canceled" }));
  await first.flush();
  expect(reports).toHaveLength(0);

  const second = ledger(path, "boot-2", reports);
  await second.start();
  expect(reports.map((notice) => notice.failureKind)).toEqual(["background_monitor_lost"]);
});

test("a closing session ends its monitors once, ignoring the cancellation that follows", async () => {
  const path = await ledgerPath();
  const reports: TurnFailureNotice[] = [];
  const monitors = ledger(path, "boot-1", reports);
  await monitors.start();
  monitors.observe(upsert());
  monitors.observe(upsert({ id: "task-2", parentAgentId: "agent-2" }));
  monitors.sessionEnded("agent-1");
  monitors.observe(upsert({ status: "canceled" }));
  monitors.sessionEnded("agent-1");
  await monitors.flush();
  await new Promise((resolve) => setImmediate(resolve));

  const byId = Object.fromEntries(monitors.list().map((view) => [view.subagentId, view]));
  expect(byId["task-1"]).toMatchObject({ status: "lost", lostReason: "session_ended" });
  expect(byId["task-2"].status).toBe("running");
  expect(reports.map((notice) => notice.code)).toEqual(["background_monitor_session_ended"]);
});

test("a provider-reported failure is reported; completion and user cancellation are not", async () => {
  const path = await ledgerPath();
  const reports: TurnFailureNotice[] = [];
  const monitors = ledger(path, "boot-1", reports);
  await monitors.start();
  monitors.observe(upsert({ id: "fails" }));
  monitors.observe(upsert({ id: "fails", status: "failed" }));
  monitors.observe(upsert({ id: "done" }));
  monitors.observe(upsert({ id: "done", status: "completed" }));
  monitors.observe(upsert({ id: "stopped" }));
  monitors.observe(upsert({ id: "stopped", status: "canceled" }));
  await new Promise((resolve) => setImmediate(resolve));
  await monitors.flush();

  expect(reports.map((notice) => [notice.turnId, notice.failureKind])).toEqual([
    ["background-monitor:fails", "background_monitor_failed"],
  ]);
  const statuses = Object.fromEntries(
    monitors.list().map((view) => [view.subagentId, view.status]),
  );
  expect(statuses).toEqual({ fails: "failed", done: "completed", stopped: "canceled" });
});

test("foreground commands never become monitors, and a demoted task is dropped", async () => {
  const path = await ledgerPath();
  const monitors = ledger(path, "boot-1", []);
  await monitors.start();
  monitors.observe(upsert({ id: "cmd", activityKind: "foreground_task", title: "Command" }));
  monitors.observe(upsert({ id: "sub", activityKind: "subagent", title: "Explore" }));
  monitors.observe(upsert({ id: "flip" }));
  monitors.observe(upsert({ id: "flip", activityKind: "foreground_task", title: "Command" }));
  monitors.observe({ type: "remove", parentAgentId: "agent-1", subagentId: "cmd" });
  await monitors.flush();
  expect(monitors.list()).toEqual([]);
  expect(JSON.parse(await readFile(path, "utf8")).monitors).toEqual([]);
});

test("old ended records are pruned at start; running ones are kept", async () => {
  const path = await ledgerPath();
  let now = new Date("2026-09-28T10:05:00.000Z");
  const first = ledger(path, "boot-1", [], () => now);
  await first.start();
  first.observe(upsert());
  first.observe(upsert({ id: "old" }));
  first.observe(upsert({ id: "old", status: "completed" }));
  await first.flush();

  now = new Date("2026-10-06T11:00:00.000Z");
  const second = ledger(path, "boot-1", [], () => now);
  await second.start();
  expect(second.list().map((record) => record.subagentId)).toEqual(["task-1"]);
});

test("through the real outbox, a lost monitor becomes one durable incident", async () => {
  const path = await ledgerPath();
  const outboxDirectory = join(path, "..", "turn-failure-outbox");
  const delivered: string[] = [];
  const makeOutbox = () =>
    new TurnFailureOutbox(
      outboxDirectory,
      async (incident) => {
        delivered.push(incident.turnId);
      },
      () => undefined,
    );
  const first = ledger(path, "boot-1", []);
  await first.start();
  first.observe(upsert());
  await first.flush();

  for (const bootId of ["boot-2", "boot-3"]) {
    const outbox = makeOutbox();
    await outbox.start();
    const monitors = new BackgroundMonitorLedger({
      path,
      bootId,
      report: (notice) => outbox.record(notice),
      warn: () => undefined,
    });
    await monitors.start();
    await outbox.flush();
    await outbox.stop();
  }
  expect(delivered).toEqual(["background-monitor:task-1"]);
  expect((await readdir(outboxDirectory)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
});
