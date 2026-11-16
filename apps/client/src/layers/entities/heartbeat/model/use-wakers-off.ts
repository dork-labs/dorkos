import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import { heartbeatKeys } from './heartbeat-keys';

/** How often the team page re-reads. No single event covers every way a waker stops. */
const REFRESH_MS = 60_000;

/**
 * Every schedule and heartbeat that cannot wake now, since when, and who it
 * waits on (DOR-3641). Re-read every minute and on window focus while shown.
 *
 * @returns The TanStack Query result for `GET /api/heartbeats/wakers-off`.
 */
export function useWakersOff() {
  const transport = useTransport();
  return useQuery({
    queryKey: heartbeatKeys.wakersOff(),
    queryFn: () => transport.listWakersOff(),
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
  });
}
