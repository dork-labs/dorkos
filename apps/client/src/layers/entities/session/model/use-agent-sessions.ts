import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { useSessionId } from './use-session-id';
// Same-slice imports via sibling modules (not the entities/session barrel) to
// avoid a self-referential barrel import within this slice.
import { sessionListQueryOptions } from '../api/session-list-query';
import { selectAgentSessions } from '../lib/select-agent-sessions';

/**
 * Sessions belonging to one agent's project directory, newest-first — THE
 * canonical per-agent membership rule (DOR-203).
 *
 * Every surface that answers "which sessions belong to this agent?" (the session
 * sidebar, the profile's Sessions page, the command palette agent preview) must
 * consume this hook instead of filtering `useSessions()` itself: the left/right
 * divergence it replaces is exactly how cwd-less ghost sessions showed under
 * every agent on one surface and none on the other (DOR-202).
 *
 * The list is fetched for the AGENT's own `projectPath`, not the window's
 * selected directory. Borrowing `useSessions()` — which is hard-keyed on the
 * window's `selectedCwd` — meant an agent whose directory this window had never
 * opened filtered an empty list and always looked empty, even while it was
 * working: the profile's Sessions page and the command-palette preview both take
 * an agent path that need not match the window, so both showed nothing (DOR-929).
 * This runs its own query against the SAME shared `sessionListQueryOptions`, so
 * it fills and reads the one cache entry (`['sessions', projectPath]`) that the
 * session resolver and the global stream bridge (`useGlobalSessionStream`) also
 * keep live — no second fetch shape, no new cache namespace.
 *
 * Membership is an exact `cwd` match, mirroring the server's per-project list
 * semantics — a session without a cwd belongs to no agent. `null` (no agent
 * selected) resolves to an empty list and fetches nothing.
 *
 * @param projectPath - The agent's project directory, or null when none is active
 */
export function useAgentSessions(projectPath: string | null) {
  const [activeSessionId, setActiveSession] = useSessionId();
  const transport = useTransport();
  const queryClient = useQueryClient();

  const sessionsQuery = useQuery({
    ...sessionListQueryOptions({ transport, queryClient }, projectPath),
    enabled: projectPath !== null,
  });

  const { data } = sessionsQuery;
  const agentSessions = useMemo(
    () => selectAgentSessions(data ?? [], projectPath),
    [data, projectPath]
  );

  return {
    sessions: agentSessions,
    isLoading: sessionsQuery.isLoading,
    // An empty list has three causes and they are not the same sentence: still
    // asking, asked and got nothing, and could not ask. A caller that draws
    // "no conversations yet" over the first or the third is telling the
    // operator something false (DOR-1253).
    isError: sessionsQuery.isError,
    activeSessionId,
    setActiveSession,
  };
}
