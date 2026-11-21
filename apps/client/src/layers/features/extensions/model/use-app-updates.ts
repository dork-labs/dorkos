/**
 * Which apps the Marketplace's update check found a newer version of, for
 * the Settings line that asks an app kept on its old places to update
 * (DOR-4282).
 *
 * @module features/extensions/model/use-app-updates
 */
import { useQuery } from '@tanstack/react-query';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import type { InstallationUpdatesResult } from '@dorkos/shared/marketplace-schemas';
import { useOptionalTransport } from '@/layers/shared/model';
import { UPDATE_CHECK_STALE_MS, marketplaceKeys } from '@/layers/entities/marketplace';

/**
 * Whether a newer version of an app exists, by the same shared check the
 * Marketplace's Installed list reads. The check reaches every package's
 * source, so it runs only while `enabled`, and never where nothing provides
 * a server; until it answers, no app has an update.
 *
 * @param enabled - Run the check: some app needs the answer.
 */
export function useAppUpdates(enabled: boolean): (ext: ExtensionRecordPublic) => boolean {
  const transport = useOptionalTransport();
  const { data } = useQuery<InstallationUpdatesResult>({
    queryKey: marketplaceKeys.updates(undefined),
    // Never run without a transport: `enabled` below is false then.
    queryFn: () => {
      if (!transport) throw new Error('No server to check for updates.');
      return transport.checkMarketplaceUpdates(undefined);
    },
    enabled: enabled && transport !== null,
    staleTime: UPDATE_CHECK_STALE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  return (ext) =>
    (data?.checks ?? []).some(
      (check) => check.hasUpdate && check.packageName === (ext.sourcePlugin ?? ext.id)
    );
}
