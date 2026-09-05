import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

async function loadWorker() {
  const handlers = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn(async () => undefined);
  const navigate = vi.fn(async () => undefined);
  const focus = vi.fn(async () => undefined);
  const openWindow = vi.fn(async () => undefined);
  const source = await readFile(
    fileURLToPath(new URL("../../public/paseo-push-sw.js", import.meta.url)),
    "utf8",
  );
  vm.runInNewContext(source, {
    URL,
    TextEncoder,
    btoa: (value: string) => Buffer.from(value, "binary").toString("base64"),
    self: {
      location: { origin: "https://paseo.example" },
      registration: { showNotification },
      clients: {
        matchAll: vi.fn(async () => [{ url: "https://paseo.example/", navigate, focus }]),
        openWindow,
      },
      addEventListener: (type: string, handler: (event: unknown) => void) =>
        handlers.set(type, handler),
    },
  });
  return { handlers, showNotification, navigate, focus, openWindow };
}

describe("paseo push service worker", () => {
  it("shows a deduped attention notification without registering fetch handling", async () => {
    const worker = await loadWorker();
    const waitUntil = vi.fn();
    worker.handlers.get("push")?.({
      data: {
        json: () => ({
          title: "Needs input",
          body: "Review this",
          data: {
            serverId: "host",
            workspaceId: "workspace",
            agentId: "agent",
            reason: "permission",
          },
        }),
      },
      waitUntil,
    });
    await waitUntil.mock.calls[0][0];

    expect(worker.showNotification).toHaveBeenCalledWith(
      "Needs input",
      expect.objectContaining({
        tag: "host:agent:permission",
        data: expect.objectContaining({ workspaceId: "workspace", agentId: "agent" }),
      }),
    );
    expect(worker.handlers.has("fetch")).toBe(false);
  });

  it("navigates an existing same-origin client to the exact conversation route", async () => {
    const worker = await loadWorker();
    const close = vi.fn();
    const waitUntil = vi.fn();
    worker.handlers.get("notificationclick")?.({
      notification: {
        close,
        data: { serverId: "host", workspaceId: "workspace", agentId: "agent" },
      },
      waitUntil,
    });
    await waitUntil.mock.calls[0][0];

    expect(worker.navigate).toHaveBeenCalledWith(
      "https://paseo.example/h/host/workspace/workspace?open=agent%3Aagent",
    );
    expect(worker.focus).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
