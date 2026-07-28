/**
 * The fleet as something a person can choose from.
 *
 * Lives at the entity layer rather than beside the picker that renders it,
 * because two features derive the same list: the sidebar hands it to every room
 * row, and the room view builds its own when the sidebar is not mounted. One
 * home is what keeps them offering the same agents in the same order — a
 * reader who sees "Ana, Bo, Kai" in one place and "Bo, Ana, Kai" in another has
 * been told the two lists are different things.
 *
 * @module entities/agent/lib/agent-choices
 */

/** One agent the operator can put in a conversation. */
export interface AgentPickerCandidate {
  /** The agent's directory — its stable identity (ADR 260726-170126). */
  agentPath: string;
  /** What to call it on screen, already disambiguated across the roster. */
  displayName: string;
}

/**
 * Turn a `path → display name` map into the sorted list every agent picker
 * reads.
 *
 * Sorted by the name on screen rather than by path, because that is the order
 * the reader is scanning in. `localeCompare` rather than `<`, so accented names
 * land where a person expects them rather than after `Z`.
 *
 * @param displayNames - Display names keyed by agent directory, as
 *   `disambiguateDisplayNames` returns them.
 * @returns The candidates, sorted by display name.
 */
export function toAgentPickerCandidates(
  displayNames: Record<string, string>
): AgentPickerCandidate[] {
  return Object.entries(displayNames)
    .map(([agentPath, displayName]) => ({ agentPath, displayName }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
