import { describe, expect, test } from "vitest";

import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { readTerminalContextOverflowFailure } from "./context-overflow.js";

function rows(...items: AgentTimelineRow["item"][]): AgentTimelineRow[] {
  return items.map((item, index) => ({
    seq: index + 1,
    timestamp: new Date(index).toISOString(),
    item,
  }));
}

describe("readTerminalContextOverflowFailure", () => {
  test("recognizes a hydrated provider API error at the end of history", () => {
    expect(
      readTerminalContextOverflowFailure(
        rows(
          { type: "user_message", text: "Continue the review" },
          { type: "assistant_message", text: "Prompt is too long" },
        ),
      ),
    ).toBe("Prompt is too long");
  });

  test("does not revive an old overflow after later conversation activity", () => {
    expect(
      readTerminalContextOverflowFailure(
        rows(
          { type: "assistant_message", text: "Prompt is too long" },
          { type: "user_message", text: "Start a separate task" },
        ),
      ),
    ).toBeNull();
  });

  test("recognizes a terminal normalized error timeline item", () => {
    expect(
      readTerminalContextOverflowFailure(
        rows({ type: "error", message: "Maximum context window exceeded" }),
      ),
    ).toBe("Maximum context window exceeded");
  });
});
