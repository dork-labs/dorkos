/**
 * The fleet, as every agent picker in a room surface reads it.
 *
 * @module features/room-membership/model/use-agent-picker-candidates
 */
import { useMemo } from 'react';
import {
  disambiguateDisplayNames,
  toAgentPickerCandidates,
  useResolvedAgents,
  type AgentPickerCandidate,
} from '@/layers/entities/agent';
import { useMeshAgentPaths } from '@/layers/entities/mesh';

/**
 * Every agent you have, named the way the sidebar names it and sorted the same
 * way.
 *
 * The sidebar derives this list from state it already holds and passes it down
 * to its rows; the open room has no sidebar to ask, so it asks here. Both go
 * through the same two pure functions in `entities/agent`, which is what stops
 * the two surfaces offering different names for the same agent — two `server`
 * directories are "server (acme)" and "server (globex)" in both places or in
 * neither.
 *
 * Reads only. Both queries are shared cache entries the shell already has warm,
 * so mounting this costs a memo rather than a request.
 *
 * @returns The candidates, sorted by display name. Empty while the roster
 *   loads, and empty for a person who has no agents yet — the pickers tell
 *   those apart by what they were given to say, not by asking again.
 */
export function useAgentPickerCandidates(): AgentPickerCandidate[] {
  const { data: meshData } = useMeshAgentPaths();
  const paths = useMemo(() => (meshData?.agents ?? []).map((a) => a.projectPath), [meshData]);
  const { data: agents } = useResolvedAgents(paths);

  return useMemo(
    () => toAgentPickerCandidates(disambiguateDisplayNames(paths, agents ?? {})),
    [paths, agents]
  );
}
