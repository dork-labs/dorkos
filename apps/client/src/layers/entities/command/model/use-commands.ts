import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { QUERY_TIMING } from '@/layers/shared/lib';
import type { CommandRegistry } from '@dorkos/shared/types';

/** Fetch the command registry for a given working directory. */
export function useCommands(cwd?: string | null) {
  const transport = useTransport();
  return useQuery<CommandRegistry>({
    queryKey: ['commands', { cwd: cwd ?? null }],
    queryFn: () => transport.getCommands(false, cwd ?? undefined),
    staleTime: QUERY_TIMING.COMMANDS_STALE_TIME_MS,
    gcTime: QUERY_TIMING.COMMANDS_GC_TIME_MS,
  });
}
