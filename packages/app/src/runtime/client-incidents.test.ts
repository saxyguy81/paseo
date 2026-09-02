import { expect, test } from "vitest";
import { ClientIncidentQueue } from "./client-incidents";

test("offline client incidents survive recreation and replay with the same identity", async () => {
  let saved: string | null = null;
  const storage = {
    getItem: async () => saved,
    setItem: async (_key: string, value: string) => {
      saved = value;
    },
  };
  const first = new ClientIncidentQueue(
    storage,
    () => "3d2521fb-2d6a-46cf-bf78-262c98be82c1",
    () => 1000,
  );
  await first.capture("server", "client_history_failed", "agent");
  await expect(
    first.flush("server", {
      reportDiagnosticIncident: async () => {
        throw new Error("offline");
      },
    }),
  ).rejects.toThrow("offline");
  const delivered: unknown[] = [];
  const second = new ClientIncidentQueue(
    storage,
    () => "not-needed",
    () => 2000,
  );
  await second.capture("server", "client_history_failed", "agent");
  await second.flush("server", { reportDiagnosticIncident: async () => false });
  const receiver = {
    reportDiagnosticIncident: async (item: unknown) => {
      delivered.push(item);
      return true;
    },
  };
  await second.flush("server", receiver);
  await second.flush("server", receiver);
  expect(delivered).toEqual([
    {
      incidentId: "3d2521fb-2d6a-46cf-bf78-262c98be82c1",
      code: "client_history_failed",
      agentId: "agent",
    },
  ]);
});
