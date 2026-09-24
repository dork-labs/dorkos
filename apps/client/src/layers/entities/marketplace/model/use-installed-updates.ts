import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { InstallationUpdatesResult } from '@dorkos/shared/marketplace-schemas';
import { marketplaceKeys } from '../api/query-keys';

/**
 * How long an update check stays fresh. The check asks every installed
 * package's source for its newest version, so it runs once per visit rather
 * than on every mount, and "Check again" is how a person asks sooner.
 */
export const UPDATE_CHECK_STALE_MS = 10 * 60_000;

/** Options for {@link useInstalledUpdates}. */
export interface UseInstalledUpdatesOptions {
  /** Run the check at all (default `true`); pass `false` when nothing is installed. */
  enabled?: boolean;
}

/**
 * Check every installation in one view for a newer version, in one request
 * (`GET /api/marketplace/updates`).
 *
 * One check per installation, keyed by `installPath` — the key the installed
 * list's rows carry. Every consumer of the same view shares the one request
 * (the Installed tab's count and the Installed view both read it).
 *
 * The check never refetches on window focus or reconnect and never retries on
 * its own: it reaches out to every package's source, so it runs when a person
 * opens the Marketplace or asks again, and a failure is shown, not repeated.
 *
 * @param projectPath - Omit for every scope (what the Installed view lists).
 * @param options - `enabled: false` skips the check entirely.
 */
export function useInstalledUpdates(
  projectPath?: string,
  options: UseInstalledUpdatesOptions = {}
) {
  const transport = useTransport();
  return useQuery<InstallationUpdatesResult>({
    queryKey: marketplaceKeys.updates(projectPath),
    queryFn: () => transport.checkMarketplaceUpdates(projectPath),
    enabled: options.enabled ?? true,
    staleTime: UPDATE_CHECK_STALE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}
