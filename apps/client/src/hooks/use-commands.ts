import { useQuery } from '@tanstack/react-query';
import { useTransport } from '../contexts/TransportContext';
import type { CommandRegistry } from '@lifeos/shared/types';

export function useCommands() {
  const transport = useTransport();
  return useQuery<CommandRegistry>({
    queryKey: ['commands'],
    queryFn: () => transport.getCommands(),
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
}

export function useRefreshCommands() {
  const transport = useTransport();
  return useQuery<CommandRegistry>({
    queryKey: ['commands', 'refresh'],
    queryFn: () => transport.getCommands(true),
    enabled: false,
  });
}
