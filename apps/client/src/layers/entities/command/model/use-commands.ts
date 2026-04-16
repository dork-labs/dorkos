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
 */
export function useCommands(cwd?: string | null, sessionId?: string) {
  const transport = useTransport();
  return useQuery<CommandRegistry>({
    queryKey: ['commands', { cwd: cwd ?? null, sessionId: sessionId ?? null }],
    queryFn: () => transport.getCommands(false, cwd ?? undefined, { sessionId }),
    staleTime: QUERY_TIMING.COMMANDS_STALE_TIME_MS,
    gcTime: QUERY_TIMING.COMMANDS_GC_TIME_MS,
  });
}
