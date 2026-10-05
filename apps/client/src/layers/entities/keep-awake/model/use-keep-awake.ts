import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { KeepAwakeStatus } from '@dorkos/shared/schemas';
import { useEventSubscription, useTransport } from '@/layers/shared/model';

/** Query key for the keep-awake status. */
export const KEEP_AWAKE_KEY = ['keep-awake'] as const;

/**
 * How long the answer is trusted without asking again. Long, because the
 * `keep_awake_status` event is the real freshness mechanism; this only backstops
 * an event lost while the stream was down (a reconnect re-syncs every query).
 */
const STALE_TIME_MS = 5 * 60_000;

/**
 * Whether DorkOS is keeping this computer awake right now, and for what.
 *
 * Returns `undefined` until the first answer lands, which every surface reads as
 * "nothing to show": a cup that flashed on during page load would be a lie.
 */
export function useKeepAwake(): KeepAwakeStatus | undefined {
  const transport = useTransport();
  const { data } = useQuery({
    queryKey: [...KEEP_AWAKE_KEY],
    queryFn: () => transport.getKeepAwake(),
    staleTime: STALE_TIME_MS,
  });
  return data;
}

/** Whether a stream payload has the shape of a keep-awake status. */
function isKeepAwakeStatus(data: unknown): data is KeepAwakeStatus {
  if (typeof data !== 'object' || data === null) return false;
  const status = data as Partial<KeepAwakeStatus>;
  const working = status.working as Partial<KeepAwakeStatus['working']> | undefined;
  return (
    typeof status.enabled === 'boolean' &&
    typeof status.supported === 'boolean' &&
    typeof status.asserted === 'boolean' &&
    typeof working === 'object' &&
    working !== null &&
    typeof working.chats === 'number' &&
    typeof working.rooms === 'number' &&
    typeof working.tasks === 'number'
  );
}

/**
 * Keep the status live off `keep_awake_status`, which carries the whole status:
 * it is written straight into the cache rather than prompting a refetch. A
 * payload of the wrong shape is dropped, and the next one (or the next refetch)
 * puts things right.
 *
 * Mount once near the app root, beside the other `*Sync` hooks.
 */
export function useKeepAwakeSync(): void {
  const queryClient = useQueryClient();
  useEventSubscription('keep_awake_status', (data) => {
    if (isKeepAwakeStatus(data)) queryClient.setQueryData([...KEEP_AWAKE_KEY], data);
  });
}
