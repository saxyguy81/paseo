import { describe, expect, test } from "vitest";

import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import {
  readTerminalContextOverflowFailure,
  readTerminalConversationRolloverFailure,
} from "./context-overflow.js";

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

describe("readTerminalConversationRolloverFailure", () => {
  test("classifies a terminal unresolved prior turn", () => {
    expect(
      readTerminalConversationRolloverFailure(
        rows({
          type: "assistant_message",
          text: "API Error: 409 Conversation has an unresolved prior request",
        }),
      ),
    ).toEqual({
      kind: "conversation_unresolved",
      text: "API Error: 409 Conversation has an unresolved prior request",
    });
  });

  test("classifies a terminal active-request ambiguity as an unresolved conversation", () => {
    expect(
      readTerminalConversationRolloverFailure(
        rows({
          type: "assistant_message",
          text: "API Error: 409 Conversation already has an active request",
        }),
      ),
    ).toEqual({
      kind: "conversation_unresolved",
      text: "API Error: 409 Conversation already has an active request",
    });
  });

  test("classifies repeated continuation-matching unavailability as an unresolved conversation", () => {
    expect(
      readTerminalConversationRolloverFailure(
        rows({
          type: "assistant_message",
          text: "API Error: 503 Continuation matching is temporarily unavailable. This is a server-side issue, usually temporary.",
        }),
      ),
    ).toEqual({
      kind: "conversation_unresolved",
      text: "API Error: 503 Continuation matching is temporarily unavailable. This is a server-side issue, usually temporary.",
    });
  });

  test("classifies a missing CCProxy continuation as an unresolved conversation", () => {
    const text = "API Error: 409 Conversation continuation was not found";
    expect(
      readTerminalConversationRolloverFailure(
        rows({
          type: "assistant_message",
          text,
        }),
      ),
    ).toEqual({
      kind: "conversation_unresolved",
      text,
    });
  });

  test("rehydrates a terminal resumed-session model rejection as its own failure kind", () => {
    const text =
      "There's an issue with the selected model (claude-opus-5). It may not exist or you may not have access to it. Run --model to pick a different model.";
    expect(
      readTerminalConversationRolloverFailure(rows({ type: "assistant_message", text })),
    ).toEqual({
      kind: "resume_model_unavailable",
      text,
    });
  });
});
