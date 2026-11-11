/**
 * The name on a window an agent drives (DOR-3111).
 *
 * The orange frame says an agent is driving; the name says which one, so two
 * windows open at once can be told apart. Chromium shows a `--window-name` in
 * place of the page's title, so a page can't rename the window. The name is a
 * helper beside the frame, not proof: an agent chooses its own name.
 */

/** The most of an agent's name a window title shows. */
export const MAX_WINDOW_AGENT_NAME = 24;

/**
 * The title for an agent's window.
 *
 * @param agentName - The agent's name, or null when the chat's agent isn't known.
 */
export function agentWindowName(agentName: string | null | undefined): string {
  // An agent picks its own name, and control or direction characters could reorder the title.
  const whole = agentName?.replace(/[\p{Cc}\p{Cf}]/gu, '').trim();
  if (!whole) return 'An agent is using this window';
  const characters = Array.from(whole);
  const name =
    characters.length > MAX_WINDOW_AGENT_NAME
      ? `${characters.slice(0, MAX_WINDOW_AGENT_NAME).join('')}…`
      : whole;
  return `${name} is using this window`;
}

/**
 * The name a person knows an agent by: its display name, or its name without one.
 * The same rule names the agent on the handoff card, so the window and card agree.
 *
 * @param agent - The agent's manifest.
 */
export function agentWindowLabel(agent: { name: string; displayName?: string }): string {
  return agent.displayName?.trim() || agent.name;
}

/** The name of the agent a chat belongs to, for the title of the window it drives. */
export class AgentWindowNames {
  // None until startup wires the mesh.
  private lookup: (sessionId: string) => Promise<string | undefined> = async () => undefined;

  /**
   * Set once at startup.
   *
   * @param lookup - The agent's name for a chat, or undefined when it isn't known.
   */
  use(lookup: (sessionId: string) => Promise<string | undefined>): void {
    this.lookup = lookup;
  }

  /**
   * The chat's agent name, or null. Only the title needs it, so a failed lookup
   * opens an unnamed window rather than no window.
   *
   * @param sessionId - The chat the window opens for, if any.
   */
  async of(sessionId: string | undefined): Promise<string | null> {
    if (!sessionId) return null;
    return (await this.lookup(sessionId).catch(() => undefined)) ?? null;
  }
}

/**
 * The launch flag that names an agent's window.
 *
 * @param agentName - The agent's name, or null when the chat's agent isn't known.
 */
export function agentWindowNameArg(agentName: string | null | undefined): string {
  return `--window-name=${agentWindowName(agentName)}`;
}
