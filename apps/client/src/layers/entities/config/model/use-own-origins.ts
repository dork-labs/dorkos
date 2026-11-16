import { useCallback, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import { configKeys } from '@/layers/shared/model';

/** The answer before the config has loaded, kept as one value so the snapshot stays stable. */
const NONE: readonly string[] = [];

/**
 * This server's own addresses beyond loopback (its tunnel, Wi-Fi and hub origins), read from the
 * config the app shell already loads, without another request (DOR-4132). Empty until that config
 * has arrived, and updated whenever it is read again.
 */
export function useOwnOrigins(): readonly string[] {
  const client = useQueryClient();
  const cache = client.getQueryCache();
  const subscribe = useCallback((notify: () => void) => cache.subscribe(notify), [cache]);
  const snapshot = useCallback(
    () => client.getQueryData<ServerConfig>(configKeys.current())?.ownOrigins ?? NONE,
    [client]
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
