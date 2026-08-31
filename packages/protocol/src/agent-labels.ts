export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
export const CONVERSATION_FAMILY_ID_LABEL = "paseo.family.id";
export const CONVERSATION_FAMILY_CURRENT_LABEL = "paseo.family.current";
export const CONVERSATION_FAMILY_NAME_LABEL = "paseo.family.name";
export const CONVERSATION_FAMILY_POSITION_LABEL = "paseo.family.position";
export const CONVERSATION_FAMILY_HIDDEN_LABEL = "paseo.family.hidden";
export const CONVERSATION_FAMILY_PREDECESSOR_LABEL = "paseo.family.predecessor";
/**
 * Marks the one fresh-session escape from a resumed Claude session that was
 * rejected with the SDK's synthetic model_not_found error. This is deliberately
 * not inherited by later family successors.
 */
export const CONVERSATION_FAMILY_RESUME_MODEL_ROLLOVER_LABEL = "paseo.family.resume-model-rollover";
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";

export function getOpenAgentTabLabel(clientId: string): string {
  return `${OPEN_AGENT_TAB_LABEL_PREFIX}${clientId}`;
}

export function isOpenAgentTabLabel(label: string): boolean {
  return label.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX);
}

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function hasOpenAgentTab(labels: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(labels ?? {}).some(
    ([label, value]) => isOpenAgentTabLabel(label) && value === "true",
  );
}
