import { afterEach, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TurnFailureOutbox,
  commandIncidentDelivery,
  incidentId,
  parseFailureDeliveryCommand,
  type TurnFailureNotice,
} from "./turn-failure-outbox.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
const notice: TurnFailureNotice = {
  agentId: "agent-1",
  turnId: "turn-1",
  provider: "claude",
  code: "model_not_found",
  failureKind: null,
};

test("a failed delivery survives restart, then the same turn is delivered only once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-failure-outbox-"));
  directories.push(directory);
  const first = new TurnFailureOutbox(
    directory,
    async () => {
      throw new Error("offline");
    },
    () => undefined,
  );
  await first.start();
  await first.record(notice);
  await first.flush();
  await first.stop();
  expect(
    JSON.parse(await readFile(join(directory, `${incidentId(notice)}.json`), "utf8")).delivered,
  ).toBe(false);

  const delivered: string[] = [];
  const second = new TurnFailureOutbox(
    directory,
    async (event) => {
      delivered.push(event.id);
    },
    () => undefined,
  );
  await second.start();
  await second.flush();
  await second.record(notice);
  await second.flush();
  await second.stop();
  expect(delivered).toEqual([incidentId(notice)]);
});

test("delivery uses a real executable and preserves JSON as data, not shell syntax", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-failure-command-"));
  directories.push(directory);
  const script = join(directory, "receive.cjs");
  const destination = join(directory, "received.json");
  await writeFile(
    script,
    'const fs=require("node:fs"); let data=""; process.stdin.on("data",b=>data+=b); process.stdin.on("end",()=>fs.writeFileSync(process.argv[2],data));',
  );
  const delivery = commandIncidentDelivery([process.execPath, script, destination]);
  await delivery({
    ...notice,
    agentId: "$(touch not-a-command)",
    id: incidentId(notice),
    version: 1,
    detectedAt: "2026-09-02T00:00:00Z",
  });
  expect(JSON.parse(await readFile(destination, "utf8")).agentId).toBe("$(touch not-a-command)");
  expect(() => parseFailureDeliveryCommand('"some shell command"')).toThrow("JSON argv");
  expect(parseFailureDeliveryCommand(undefined)).toBeNull();
});
