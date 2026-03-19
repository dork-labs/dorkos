import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { TunnelStatus } from '@dorkos/shared/types';

/** TanStack Query hook for current tunnel status, extracted from server config. */
export function useTunnelStatus() {
  const transport = useTransport();

  const query = useQuery<TunnelStatus>({
    queryKey: ['tunnel-status'],
    queryFn: async () => {
      const config = await transport.getConfig();
      return config.tunnel;
    },
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  return query;
}
