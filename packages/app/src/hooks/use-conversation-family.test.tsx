/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationFamily } from "./use-conversation-family";

const { fetchAgentTimeline, members } = vi.hoisted(() => ({
  fetchAgentTimeline: vi.fn(async () => ({ hasOlder: false, startCursor: null })),
  members: [
    { agentId: "older", title: "Older", position: 0 },
    { agentId: "current", title: "Current", position: 1 },
  ],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/data/query", () => ({
  useFetchQuery: () => ({ data: members, isPending: false, error: null }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: () => ({ fetchAgentHistory: vi.fn() }),
    fetchAgentTimeline,
  }),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ sessions: { server: { agentStreamTail: new Map() } } }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function Harness({ loadHistory }: { loadHistory: boolean }) {
  useConversationFamily({
    serverId: "server",
    agentId: "current",
    labels: {
      "paseo.family.id": "family",
      "paseo.family.name": "Family",
      "paseo.family.position": "1",
      "paseo.family.current": "current",
    },
    loadHistory,
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchAgentTimeline.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("useConversationFamily hydration", () => {
  it("does not hydrate predecessor timelines until full history is requested", async () => {
    await act(async () => {
      root?.render(<Harness loadHistory={false} />);
    });
    expect(fetchAgentTimeline).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(<Harness loadHistory />);
    });
    expect(fetchAgentTimeline).toHaveBeenCalledTimes(2);
  });
});
