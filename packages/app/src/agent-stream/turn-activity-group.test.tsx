/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnActivityGroupView } from "./turn-activity-group";

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
    t: (key: string, values?: Record<string, number>) =>
      (key.endsWith(".hide") ? "Hide work · {{count}}" : "Show work · {{count}}").replace(
        "{{count}}",
        String(values?.count ?? ""),
      ),
  }),
}));

vi.mock("lucide-react-native", () => ({
  ChevronDown: () => React.createElement("span", { "data-icon": "chevron-down" }),
  ChevronRight: () => React.createElement("span", { "data-icon": "chevron-right" }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

function renderDisclosure(expanded: boolean, onExpandedChange = vi.fn()): void {
  act(() => {
    root?.render(
      <TurnActivityGroupView
        groupId="turn-1"
        itemCount={7}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
      >
        <div data-testid="work-detail">Detailed work</div>
      </TurnActivityGroupView>,
    );
  });
}

function disclosure(): HTMLElement | null {
  return container?.querySelector('[role="button"]') ?? null;
}

describe("TurnActivityGroupView", () => {
  it("is collapsed by default and reports its hidden item count", () => {
    renderDisclosure(false);

    expect(disclosure()?.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure()?.getAttribute("aria-label")).toBe("Show work · 7");
    expect(container?.textContent).toContain("Show work · 7");
    expect(container?.querySelector('[data-testid="work-detail"]')).toBeNull();
  });

  it("shows the original work and can be collapsed again", () => {
    const onExpandedChange = vi.fn();
    renderDisclosure(true, onExpandedChange);

    expect(disclosure()?.getAttribute("aria-expanded")).toBe("true");
    expect(container?.querySelector('[data-testid="work-detail"]')).not.toBeNull();
    expect(container?.textContent).toContain("Hide work · 7");

    act(() => disclosure()?.click());
    expect(onExpandedChange).toHaveBeenCalledWith("turn-1", false);
  });
});
