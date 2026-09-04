import type {
  AgentPromptInput,
  AgentPromptPreflight,
  AgentPromptAdmissionDecision,
  AgentUsage,
} from "../../agent-sdk-types.js";

export const CLAUDE_CONTEXT_PREFLIGHT_KEY = "claude_context_compaction";

const CLAUDE_CONTEXT_PREFLIGHT_MARKER = "[PASEO_INTERNAL_CONTEXT_PREFLIGHT]";
const MINIMUM_CONTEXT_RESERVE_TOKENS = 40_000;
// A compacted Claude Code session still contains its summary, system prompt,
// project instructions, and tool schemas. Reserve a second bounded floor so a
// prompt admitted for preflight cannot immediately overflow the compacted run.
const POST_COMPACTION_CONTEXT_FLOOR_TOKENS = 40_000;
const CONTEXT_RESERVE_FRACTION = 0.2;
const APPROXIMATE_CHARACTERS_PER_TOKEN = 4;
// Inline images are tokenized by vision encoding, not as their base64 transport
// bytes. Keep a conservative fixed estimate rather than rejecting ordinary
// screenshots as enormous text prompts.
const APPROXIMATE_IMAGE_TOKENS = 1_600;
// Claude expands slash commands such as /team after Paseo has admitted the
// literal message. Reserve enough room for a substantial skill prompt without
// coupling the server to profile-specific command files.
const SLASH_COMMAND_EXPANSION_RESERVE_TOKENS = 20_000;

const CONTEXT_PREFLIGHT_PROMPT =
  `/compact ${CLAUDE_CONTEXT_PREFLIGHT_MARKER} ` +
  "Preserve the active goal, every unresolved user instruction, decisions already made, " +
  "modified files, validation evidence, commands still running, blockers, and exact next steps.";

function estimatePromptTokens(prompt: AgentPromptInput): number {
  if (typeof prompt === "string") {
    return Math.ceil(prompt.length / APPROXIMATE_CHARACTERS_PER_TOKEN);
  }
  return prompt.reduce((total, block) => {
    if (block.type === "text") {
      return total + Math.ceil(block.text.length / APPROXIMATE_CHARACTERS_PER_TOKEN);
    }
    if (block.type === "image") return total + APPROXIMATE_IMAGE_TOKENS;
    return total + Math.ceil(JSON.stringify(block).length / APPROXIMATE_CHARACTERS_PER_TOKEN);
  }, 0);
}

function isCompactCommand(prompt: AgentPromptInput): boolean {
  if (typeof prompt !== "string") return false;
  return /^\s*\/compact(?:\s|$)/i.test(prompt);
}

function isSlashCommand(prompt: AgentPromptInput): boolean {
  return typeof prompt === "string" && /^\s*\/[^\s/]+(?:\s|$)/.test(prompt);
}

export function isClaudeContextPreflightPrompt(prompt: AgentPromptInput): boolean {
  return (
    typeof prompt === "string" &&
    /^\s*\/compact\s+\[PASEO_INTERNAL_CONTEXT_PREFLIGHT\](?:\s|$)/.test(prompt)
  );
}

function buildContextPreflight(): AgentPromptPreflight {
  return {
    key: CLAUDE_CONTEXT_PREFLIGHT_KEY,
    prompt: CONTEXT_PREFLIGHT_PROMPT,
  };
}

export function planClaudePromptAdmission(input: {
  prompt: AgentPromptInput;
  usage: AgentUsage | undefined;
}): AgentPromptAdmissionDecision {
  if (isCompactCommand(input.prompt)) return { type: "dispatch" };

  const maxTokens = input.usage?.contextWindowMaxTokens;
  const usedTokens = input.usage?.contextWindowUsedTokens;
  if (
    typeof maxTokens !== "number" ||
    !Number.isFinite(maxTokens) ||
    maxTokens <= 0 ||
    typeof usedTokens !== "number" ||
    !Number.isFinite(usedTokens) ||
    usedTokens < 0
  ) {
    return { type: "dispatch" };
  }

  const estimatedPromptTokens =
    estimatePromptTokens(input.prompt) +
    (isSlashCommand(input.prompt) ? SLASH_COMMAND_EXPANSION_RESERVE_TOKENS : 0);
  const reserveTokens = Math.max(
    MINIMUM_CONTEXT_RESERVE_TOKENS,
    Math.ceil(maxTokens * CONTEXT_RESERVE_FRACTION),
  );
  const maximumPromptTokens = maxTokens - reserveTokens - POST_COMPACTION_CONTEXT_FLOOR_TOKENS;
  if (estimatedPromptTokens >= maximumPromptTokens) {
    return {
      type: "reject",
      message:
        `This message is approximately ${estimatedPromptTokens.toLocaleString()} tokens, ` +
        `which exceeds the ${maximumPromptTokens.toLocaleString()}-token safe prompt limit ` +
        `for this ${maxTokens.toLocaleString()}-token model. Shorten the message or attach ` +
        "the large content as files.",
    };
  }

  if (usedTokens + estimatedPromptTokens + reserveTokens >= maxTokens) {
    return { type: "preflight", ...buildContextPreflight() };
  }
  return { type: "dispatch" };
}
