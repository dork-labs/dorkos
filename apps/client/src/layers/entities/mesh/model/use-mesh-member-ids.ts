/**
 * The bridge from an agent's DIRECTORY to the id the team roster files it under.
 *
 * @module entities/mesh/model/use-mesh-member-ids
 */
import { useMemo } from 'react';
import { useMeshAgentPaths } from './use-mesh-agent-paths';

/** One shared empty answer, so a surface reading this before the fleet lands costs nothing. */
const NOTHING_KNOWN: ReadonlyMap<string, string> = new Map();

/**
 * Every registered agent's project path mapped to its registry id.
 *
 * **Why this join exists at all.** Half the cockpit knows an agent by where it
 * lives — the sidebar row, the chat status chip, the command palette all carry
 * a `projectPath` and nothing else. The team roster (`GET /api/team`), and so
 * the profile drawer that reads it, keys agents by the id the mesh registered.
 * `GET /api/mesh/agent-paths` is the one payload the client already holds that
 * carries BOTH, which makes it the honest join and the only one:
 *
 * - Not the on-disk manifest's own `id`. It usually agrees, but an agent
 *   present on disk and absent from the mesh would hand back an id the roster
 *   does not hold — a click that opens an empty drawer.
 * - Not the display name. Two agents can share one.
 *
 * An id this map does not have is an id the roster does not have either, so
 * `undefined` is the answer a caller must render as "no profile to open" rather
 * than as a control that opens nothing.
 *
 * Reads the same cached query the sidebar and every agent picker already keep
 * warm — no request of its own.
 */
export function useMeshMemberIds(): ReadonlyMap<string, string> {
  const { data } = useMeshAgentPaths();
  return useMemo(() => {
    if (!data) return NOTHING_KNOWN;
    return new Map(data.agents.map((entry) => [entry.projectPath, entry.id]));
  }, [data]);
}

/**
 * The roster id for one agent's project path, or `undefined` when the fleet
 * cannot name it — see {@link useMeshMemberIds} for why that is not the same as
 * "no such agent".
 *
 * @param projectPath - The agent's directory, or `undefined` when the surface
 *   has not resolved one yet.
 */
export function useMeshMemberId(projectPath: string | undefined): string | undefined {
  const byPath = useMeshMemberIds();
  return projectPath === undefined ? undefined : byPath.get(projectPath);
}
