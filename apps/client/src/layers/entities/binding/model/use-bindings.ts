import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

export const BINDINGS_QUERY_KEY = ['relay', 'bindings'] as const;

/**
 * Fetch all adapter-agent bindings from the server.
 */
export function useBindings() {
  const transport = useTransport();
  return useQuery({
    queryKey: [...BINDINGS_QUERY_KEY],
    queryFn: () => transport.getBindings(),
  });
}
