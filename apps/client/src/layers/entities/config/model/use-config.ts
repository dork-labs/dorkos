import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { ServerConfig } from '@dorkos/shared/types';
import { configKeys } from '../api/query-keys';

/**
 * Read the current server configuration.
 *
 * Returns the merged view of `~/.dork/config.json` plus runtime-derived state
 * (version, uptime, port, feature toggles, telemetry consent, etc.). Used by
 * any UI that needs to read user-level settings — pair with
 * {@link useUpdateConfig} to mutate.
 */
export function useConfig() {
  const transport = useTransport();
  return useQuery<ServerConfig>({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: 30_000,
  });
}
