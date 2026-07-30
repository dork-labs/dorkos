/**
 * The fleet, as every agent picker in a room surface reads it.
 *
 * @module features/room-management/model/use-agent-picker-candidates
 */
import { useCallback, useMemo } from 'react';
import {
  disambiguateDisplayNames,
  toAgentPickerCandidates,
  useResolvedAgents,
  type AgentRoster,
} from '@/layers/entities/agent';
import { useMeshAgentPaths } from '@/layers/entities/mesh';

/**
 * Every agent you have, named the way the sidebar names it and sorted the same
 * way — and whether that answer is known yet.
 *
 * One derivation for every surface that offers agents, through the same two
 * pure functions in `entities/agent`. That is what stops two surfaces offering
 * different names for the same agent: two `server` directories read as "server
 * (acme)" and "server (globex)" in both places or in neither.
 *
 * **The three states are kept apart** (see {@link AgentRoster}). An empty list
 * is a claim about somebody's account, and this hook is only entitled to make
 * it once it has actually read one.
 *
 * Two details in how they are derived, both load-bearing:
 *
 * - `useResolvedAgents` is disabled while there are no paths, so it stays
 *   pending forever for somebody who genuinely has no agents. Reading its
 *   pending flag unguarded would spin that person's picker for good, which is
 *   why waiting on it is conditioned on there being paths to resolve.
 * - **Only the mesh read can fail this roster.** Resolving manifests is what
 *   turns a directory into a display name and a face; when it fails the name
 *   falls back to the directory's own last segment and the face is dropped
 *   entirely — degraded, still usable, still the right agents. Blocking the
 *   picker on that would trade a worse label for no picker
 *   at all. A failed mesh read is different: it leaves nothing to offer, and
 *   presenting that as an empty fleet is the lie this shape exists to prevent.
 *
 * Reads only. Both queries are shared cache entries the shell already has warm,
 * so mounting this costs a memo rather than a request.
 */
export function useAgentPickerCandidates(): AgentRoster {
  const mesh = useMeshAgentPaths();
  const paths = useMemo(() => (mesh.data?.agents ?? []).map((a) => a.projectPath), [mesh.data]);
  const resolved = useResolvedAgents(paths);

  const candidates = useMemo(() => {
    // One manifest read feeds both halves of a candidate — its name and its
    // face — so the two can never disagree about which agent they describe.
    const manifests = resolved.data ?? {};
    return toAgentPickerCandidates(disambiguateDisplayNames(paths, manifests), manifests);
  }, [paths, resolved.data]);

  const meshRefetch = mesh.refetch;
  const resolvedRefetch = resolved.refetch;
  const hasPaths = paths.length > 0;
  const retry = useCallback(() => {
    void meshRefetch();
    // Guarded, because `refetch` runs a query even when `enabled` is false: the
    // failure being retried is usually the mesh read, which leaves no paths, and
    // resolving none of them posts an empty list the server answers 400 to. The
    // resolve follows from whatever the mesh read returns anyway.
    if (hasPaths) void resolvedRefetch();
  }, [meshRefetch, resolvedRefetch, hasPaths]);

  return {
    candidates,
    isLoading: mesh.isPending || (paths.length > 0 && resolved.isPending),
    isError: mesh.isError,
    retry,
  };
}
