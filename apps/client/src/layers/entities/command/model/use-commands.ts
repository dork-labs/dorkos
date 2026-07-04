import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { QUERY_TIMING } from '@/layers/shared/lib';
import type { CommandRegistry } from '@dorkos/shared/types';

/**
 * Fetch the command registry for a given working directory.
 *
 * @param cwd - Working directory scope.
 * @param sessionId - Optional active session id. When provided, the server
 *   resolves the runtime that owns the session. When absent, the server falls
 *   back to the default runtime (cold-discovery path — onboarding, command
 *   palette before any session is active).
 * @param runtime - Optional runtime type (e.g. `'codex'`). Threads the
 *   client-known runtime so a not-yet-started session — which has no
 *   server-side metadata row to resolve `sessionId` against — still gets the
 *   correct runtime's commands instead of the default runtime's. Also keys the
 *   cache, so switching the pre-launch runtime selection refetches rather than
 *   serving a stale list.
 */
export function useCommands(cwd?: string | null, sessionId?: string, runtime?: string) {
  const transport = useTransport();
  return useQuery<CommandRegistry>({
    queryKey: [
      'commands',
      { cwd: cwd ?? null, sessionId: sessionId ?? null, runtime: runtime ?? null },
    ],
    queryFn: () => transport.getCommands(false, cwd ?? undefined, { sessionId, runtime }),
    staleTime: QUERY_TIMING.COMMANDS_STALE_TIME_MS,
    gcTime: QUERY_TIMING.COMMANDS_GC_TIME_MS,
  });
}
