import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { ServerConfig } from '@dorkos/shared/types';
import { configKeys, CONFIG_STALE_TIME_MS } from '../api/query-keys';

/**
 * Read the current server configuration.
 *
 * Returns the merged view of `~/.dork/config.json` plus runtime-derived state
 * (version, uptime, port, feature toggles, telemetry consent, etc.). Used by
 * any UI that needs to read user-level settings — pair with
 * {@link useUpdateConfig} to mutate.
 *
 * @param options - `refetchInterval` re-asks on a timer for as long as the
 *   CALLER is mounted, which is how a surface that exists because the server is
 *   not answering (`ServerUnreachableScreen`) keeps asking without minting a
 *   second query for the same fact. Every observer shares one cache entry, so
 *   the answer it eventually gets is the answer every other reader gets.
 */
export function useConfig(options: { refetchInterval?: number } = {}) {
  const transport = useTransport();
  return useQuery<ServerConfig>({
    queryKey: configKeys.current(),
    queryFn: () => transport.getConfig(),
    staleTime: CONFIG_STALE_TIME_MS,
    // **The browser's idea of "offline" is about the internet, and this server
    // is not on it.** TanStack's default `networkMode: 'online'` PAUSES a fetch
    // whenever `navigator.onLine` is false — which on the desktop app would
    // freeze the one request that asks whether the local child process is
    // answering, on a machine where it certainly still is. Dropped wifi is not
    // a reason to stop asking localhost, and a paused query reports neither an
    // answer nor a failure, so the shell's unreachable gate would have had
    // nothing to go on either.
    networkMode: 'always',
    ...(options.refetchInterval === undefined ? {} : { refetchInterval: options.refetchInterval }),
  });
}
