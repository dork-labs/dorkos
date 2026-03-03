import { useQuery } from '@tanstack/react-query';
import { useTransport } from './TransportContext';

type Subsystem = 'pulse' | 'relay';

const CONFIG_STALE_TIME = 5 * 60 * 1000;

/** Fetch server config and derive whether a subsystem feature flag is enabled. */
export function useFeatureEnabled(subsystem: Subsystem): boolean {
  const transport = useTransport();

  const { data } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: CONFIG_STALE_TIME,
  });

  return data?.[subsystem]?.enabled ?? false;
}
