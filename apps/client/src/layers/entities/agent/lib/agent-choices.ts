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
  /**
   * What this agent says it is for, in its own words — or `null` when it has
   * not said.
   *
   * `null` and not `''`, because the two decide different renderings: a picker
   * draws a second line for a description and draws NO second line for the
   * absence of one. An empty string sliding through as a value is how a list
   * grows a row of blank lines that push everything apart for nothing.
   *
   * The field is the operator's own (`description` on the manifest, editable in
   * the agent's settings) and defaults to empty, so most fleets will have a mix.
   * That is the right shape for a second line: it appears where somebody wrote
   * something worth reading and stays out of the way everywhere else.
   */
  description: string | null;
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

/** A manifest, as much of it as a candidate is built from. */
type CandidateSource = AgentVisualSource & { description?: string };

/**
 * Turn a `path → display name` map into the sorted list every agent picker
 * reads, with each agent's face on it.
 *
 * **Alphabetical, and that is a conclusion rather than a default.** The obvious
 * improvement is recently-used first, and the cockpit has no honest signal for
 * it. The three that look like one are all false in a way a reader could not
 * see:
 *
 * - A room list is warm everywhere, but `RoomSummary.participants` is carried
 *   for direct messages only and is `null` for every channel, always — the
 *   server resolves it for `kind === 'dm'` and nothing else. A count or an
 *   order built on it would be *direct messages* wearing the word "rooms", and
 *   would report zero for an agent sitting in six channels.
 * - `agentActivity` on the recent-sessions read is an agent's latest session
 *   `updatedAt` across every session it has, of any origin. It cannot tell a
 *   room turn from a coding session opened against the same directory, and it
 *   is only warm while the dashboard sidebar is mounted — so the same picker
 *   would offer two different orders depending on where it was opened from.
 * - Per-room rosters would answer it exactly, and cost one request per room.
 *
 * So the list is ordered the way `useRooms` orders channels, for the same
 * reason: a list that stops moving is one you learn, and you can hit the same
 * row without reading it. An order that looks meaningful and is not would be
 * worse than this one.
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
 *   is missing, `null` or `undefined` here yields a candidate with no face and
 *   nothing to say about itself.
 * @returns The candidates, sorted by display name.
 */
export function toAgentPickerCandidates(
  displayNames: Record<string, string>,
  agents: Record<string, CandidateSource | null | undefined>
): AgentPickerCandidate[] {
  return Object.entries(displayNames)
    .map(([agentPath, displayName]) => {
      const agent = agents[agentPath];
      return {
        agentPath,
        displayName,
        visual: agent ? resolveAgentVisual(agent) : null,
        // Trimmed before it is judged: a manifest holding only whitespace has
        // said nothing, and would otherwise buy a blank second line.
        description: agent?.description?.trim() || null,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}
