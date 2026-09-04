import { describe, expect, test } from "vitest";

import {
  CLAUDE_CONTEXT_PREFLIGHT_KEY,
  isClaudeContextPreflightPrompt,
  planClaudePromptAdmission,
} from "./prompt-admission.js";

describe("Claude prompt admission", () => {
  test("dispatches when measured usage leaves the required reserve", () => {
    expect(
      planClaudePromptAdmission({
        prompt: "continue",
        usage: {
          contextWindowMaxTokens: 200_000,
          contextWindowUsedTokens: 150_000,
        },
      }),
    ).toEqual({ type: "dispatch" });
  });

  test("precompacts before a prompt that would cross the 200K safety boundary", () => {
    const decision = planClaudePromptAdmission({
      prompt: "/team finish the current goal",
      usage: {
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 163_000,
      },
    });

    expect(decision).toMatchObject({
      type: "preflight",
      key: CLAUDE_CONTEXT_PREFLIGHT_KEY,
    });
    if (decision.type !== "preflight") throw new Error("Expected a preflight decision");
    expect(isClaudeContextPreflightPrompt(decision.prompt)).toBe(true);
  });

  test("reserves room for slash-command expansion before Claude sees the literal prompt", () => {
    expect(
      planClaudePromptAdmission({
        prompt: "continue",
        usage: {
          contextWindowMaxTokens: 200_000,
          contextWindowUsedTokens: 145_000,
        },
      }),
    ).toEqual({ type: "dispatch" });
    expect(
      planClaudePromptAdmission({
        prompt: "/team finish the current goal",
        usage: {
          contextWindowMaxTokens: 200_000,
          contextWindowUsedTokens: 145_000,
        },
      }),
    ).toMatchObject({ type: "preflight" });
  });

  test("scales the reserve for an explicitly selected 1M model", () => {
    expect(
      planClaudePromptAdmission({
        prompt: "continue",
        usage: {
          contextWindowMaxTokens: 1_000_000,
          contextWindowUsedTokens: 790_000,
        },
      }),
    ).toEqual({ type: "dispatch" });
    expect(
      planClaudePromptAdmission({
        prompt: "continue",
        usage: {
          contextWindowMaxTokens: 1_000_000,
          contextWindowUsedTokens: 810_000,
        },
      }),
    ).toMatchObject({ type: "preflight" });
  });

  test("does not recursively preflight a manual or internal compact command", () => {
    expect(
      planClaudePromptAdmission({
        prompt: "/compact preserve the active goal",
        usage: {
          contextWindowMaxTokens: 200_000,
          contextWindowUsedTokens: 190_000,
        },
      }),
    ).toEqual({ type: "dispatch" });
  });

  test("rejects a literal prompt that cannot fit even in an empty context", () => {
    const decision = planClaudePromptAdmission({
      prompt: "x".repeat(500_000),
      usage: {
        contextWindowMaxTokens: 200_000,
        contextWindowUsedTokens: 0,
      },
    });

    expect(decision).toMatchObject({ type: "reject" });
  });

  test("estimates an inline image by vision tokens rather than base64 transport size", () => {
    expect(
      planClaudePromptAdmission({
        prompt: [
          { type: "text", text: "inspect this screenshot" },
          { type: "image", data: "x".repeat(700_000), mimeType: "image/png" },
        ],
        usage: {
          contextWindowMaxTokens: 200_000,
          contextWindowUsedTokens: 100_000,
        },
      }),
    ).toEqual({ type: "dispatch" });
  });

  test("does not mistake pasted marker text for Paseo's compact command", () => {
    expect(
      isClaudeContextPreflightPrompt(
        "The log contains /compact [PASEO_INTERNAL_CONTEXT_PREFLIGHT] but this is my message",
      ),
    ).toBe(false);
  });

  test("dispatches when trustworthy context usage is unavailable", () => {
    expect(planClaudePromptAdmission({ prompt: "/team continue", usage: undefined })).toEqual({
      type: "dispatch",
    });
  });
});
