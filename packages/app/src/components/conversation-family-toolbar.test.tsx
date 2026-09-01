/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationFamilyView } from "@/hooks/use-conversation-family";
import {
  ConversationFamilyToolbar,
  resolveConversationFamilySearchVisibility,
} from "./conversation-family-toolbar";

const { compactState } = vi.hoisted(() => ({ compactState: { value: true } }));

vi.mock("@/constants/layout", () => ({
  MAX_CONTENT_WIDTH: 820,
  useIsCompactFormFactor: () => compactState.value,
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: () =>
      new Proxy(
        {},
        {
          get: () => ({}),
        },
      ),
  },
  withUnistyles: (component: unknown) => component,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      (
        ({
          "agentStream.family.fullHistory": "Full history · {{count}} sessions",
          "agentStream.family.loadFailed": "Some history could not be loaded",
          "agentStream.family.searchPlaceholder": "Search this conversation",
          "agentStream.family.clearSearch": "Clear conversation search",
          "agentStream.family.matchCount": "{{current}} of {{total}}",
          "agentStream.family.noMatches": "No matches",
          "agentStream.family.previousMatch": "Previous match",
          "agentStream.family.nextMatch": "Next match",
          "agentStream.family.includeTools": "Include tools",
        })[key] ?? key
      )
        .replaceAll("{{count}}", String(values?.count ?? ""))
        .replaceAll("{{current}}", String(values?.current ?? ""))
        .replaceAll("{{total}}", String(values?.total ?? "")),
  }),
}));

vi.mock("lucide-react-native", () => ({
  ChevronDown: () => React.createElement("span", { "data-icon": "chevron-down" }),
  ChevronUp: () => React.createElement("span", { "data-icon": "chevron-up" }),
}));

vi.mock("@/components/ui/search-field", () => ({
  SearchField: ({ testID }: { testID?: string }) =>
    React.createElement("input", { "data-testid": testID }),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({ testID }: { testID?: string }) =>
    React.createElement("button", { "data-testid": testID, type: "button" }),
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => React.createElement("span", { "data-testid": "loading-spinner" }),
}));

const family: ConversationFamilyView = {
  familyId: "family-1",
  name: "Long review",
  memberCount: 4,
  streamItems: [],
  readOnlyItemIds: new Set<string>(),
  isLoading: false,
  error: null,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  compactState.value = true;
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

function renderToolbar(): void {
  act(() => {
    root?.render(<ConversationFamilyToolbar family={family} onJumpToMatch={vi.fn()} />);
  });
}

function byTestId(testID: string): HTMLElement | null {
  return container?.querySelector(`[data-testid="${testID}"]`) ?? null;
}

function click(element: HTMLElement): void {
  act(() => element.click());
}

describe("conversation family toolbar visibility", () => {
  it("keeps the desktop search visible regardless of the compact disclosure state", () => {
    expect(
      resolveConversationFamilySearchVisibility({
        isCompactFormFactor: false,
        isCompactExpanded: false,
      }),
    ).toBe(true);
  });

  it("collapses the search by default on compact screens and reveals it on demand", () => {
    renderToolbar();

    const disclosure = byTestId("conversation-family-disclosure");
    expect(disclosure).not.toBeNull();
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure?.getAttribute("aria-label")).toBe("Full history · 4 sessions");
    expect(byTestId("conversation-family-search")).toBeNull();

    click(disclosure as HTMLElement);

    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
    expect(byTestId("conversation-family-search")).not.toBeNull();
    expect(byTestId("conversation-family-include-tools")).not.toBeNull();

    click(disclosure as HTMLElement);

    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    expect(byTestId("conversation-family-search")).toBeNull();
  });

  it("preserves the always-open desktop toolbar", () => {
    compactState.value = false;
    renderToolbar();

    expect(byTestId("conversation-family-disclosure")).toBeNull();
    expect(byTestId("conversation-family-search")).not.toBeNull();
    expect(container?.textContent).toContain("Full history · 4 sessions");
  });
});
