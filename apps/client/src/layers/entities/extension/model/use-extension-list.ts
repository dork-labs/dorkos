/**
 * Every discovered extension with its current status — the one read Settings →
 * Extensions and the Activity inbox share.
 *
 * It lived in `features/extensions` until the inbox needed it too (DOR-2517):
 * a "Turn it on" link on an inbox history row has to know whether that
 * extension is still off, and a feature may not read a sibling feature's model.
 *
 * @module entities/extension/model/use-extension-list
 */
import { useQuery } from '@tanstack/react-query';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { resolveApiBaseUrl } from '@/layers/shared/lib';
import { extensionQueryKeys } from './use-pending-extension-approvals';
import { runningCopiesOnly } from '../lib/running-copies';

/**
 * Fetch all discovered extensions with their current status.
 *
 * Polls every 30 seconds so newly compiled extensions appear without a page
 * refresh. Background polling is disabled to avoid unnecessary requests when
 * the tab is hidden.
 */
export function useExtensionList() {
  return useQuery<ExtensionRecordPublic[]>({
    queryKey: extensionQueryKeys.list(),
    queryFn: async () => {
      const res = await fetch(`${resolveApiBaseUrl()}/extensions`);
      if (!res.ok) throw new Error(`Failed to fetch extensions: ${res.status}`);
      // An older copy a newer one shadows is listed for extensions to read,
      // never for the app to draw or toggle (spec `flow-multiproject` §9.2).
      return runningCopiesOnly((await res.json()) as ExtensionRecordPublic[]);
    },
    staleTime: 10_000,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}
