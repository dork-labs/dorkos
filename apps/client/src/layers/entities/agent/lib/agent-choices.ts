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
import type { AgentVisualSource } from '@/layers/shared/lib';
import { resolveAgentVisual, type AgentVisual } from '@/layers/shared/lib';

/** One agent the operator can put in a conversation. */
export interface AgentPickerCandidate {
  /** The agent's directory — its stable identity (ADR 260726-170126). */
  agentPath: string;
  /** What to call it on screen, already disambiguated across the roster. */
  displayName: string;
  /**
   * The agent's face — the same colour and emoji every other surface draws for
   * it — or `null` when its manifest could not be read.
   *
   * **`null` means "we do not know what this agent looks like", and a picker
   * has to say so rather than invent one.** The face is hashed from the
   * manifest's id, so with no manifest there is nothing to hash: the only other
   * handle is the directory, and hashing THAT produces a perfectly stable,
   * perfectly confident face that matches nothing — the sidebar, the message
   * gutter and this list would each show the same agent differently, and the
   * one place that guessed would look the most certain. This is the same
   * mistake DOR-582 fixed in a DM's mark, where the tempting id was the
   * `authors` row. Draw a letter instead; a letter is honest about not knowing.
   */
  visual: AgentVisual | null;
}

/**
 * The fleet a picker may offer, **and whether we actually know it**.
 *
 * The three states are carried separately rather than collapsed into an empty
 * array, because "you have no agents" and "we could not find out" are different
 * sentences and only one of them is ever true. Collapsing them tells somebody
 * with three agents that they have none, next to a roster drawing their faces,
 * with nothing to press — which is worse than a spinner, because a spinner is
 * at least honest about not knowing.
 */
export interface AgentRoster {
  /**
   * Every agent that may be picked, sorted by name. Empty is only meaningful
   * once {@link AgentRoster.isLoading} and {@link AgentRoster.isError} are both
   * false; before that it means "not yet" and "we do not know" respectively.
   */
  candidates: AgentPickerCandidate[];
  /** Still being read. Nothing can be concluded from `candidates` yet. */
  isLoading: boolean;
  /** Could not be read at all. Offer the reader a way to ask again. */
  isError: boolean;
  /** Ask again. */
  retry: () => void;
}

/**
 * Turn a `path → display name` map into the sorted list every agent picker
 * reads, with each agent's face on it.
 *
 * Sorted by the name on screen rather than by path, because that is the order
 * the reader is scanning in. `localeCompare` rather than `<`, so accented names
 * land where a person expects them rather than after `Z`.
 *
 * **The face is resolved here rather than at each picker**, from the same
 * manifest `disambiguateDisplayNames` names the agent from and through
 * the same `resolveAgentVisual` the sidebar and the message gutter use. That is
 * what makes one agent look like itself everywhere. An agent with no manifest
 * gets no face at all — see {@link AgentPickerCandidate.visual} for why the
 * directory is not a substitute.
 *
 * @param displayNames - Display names keyed by agent directory, as
 *   `disambiguateDisplayNames` returns them.
 * @param agents - Resolved manifests keyed by the same directories. A path that
 *   is missing, `null` or `undefined` here yields a candidate with no face.
 * @returns The candidates, sorted by display name.
 */
export function toAgentPickerCandidates(
  displayNames: Record<string, string>,
  agents: Record<string, AgentVisualSource | null | undefined>
): AgentPickerCandidate[] {
  return Object.entries(displayNames)
    .map(([agentPath, displayName]) => {
      const agent = agents[agentPath];
      return { agentPath, displayName, visual: agent ? resolveAgentVisual(agent) : null };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
