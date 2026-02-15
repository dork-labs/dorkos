import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { CommandRegistry } from '@dorkos/shared/types';

export function useCommands(cwd?: string | null) {
  const transport = useTransport();
  return useQuery<CommandRegistry>({
    queryKey: ['commands', { cwd: cwd ?? null }],
    queryFn: () => transport.getCommands(false, cwd ?? undefined),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}
