/** The most of an agent's name a card shows. An agent picks its own name. */
const MAX_AGENT_NAME = 40;

/**
 * An agent's name as a handoff card shows it. An agent picks its own name, and
 * control or direction characters could reorder the sentence around it.
 *
 * @param agentName - The name the handoff carried, or null when it carried none.
 */
export function cardAgentName(agentName: string | null): string {
  const whole = agentName?.replace(/[\p{Cc}\p{Cf}]/gu, '') || 'The agent';
  return whole.length > MAX_AGENT_NAME ? `${whole.slice(0, MAX_AGENT_NAME)}…` : whole;
}
