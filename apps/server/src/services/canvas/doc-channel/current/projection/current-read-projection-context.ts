import type { OriginalExpiredReplayFacet } from '../replay/current-expired-replay-context.js';
import type { DbTransaction } from '@dorkos/db';
import type { DocChannelGrants } from '../../grants.js';
import type { createOriginalDocManagementReader } from '../../management/snapshot-data.js';
/** Private read projection delegates, registered only by original engine construction. */
export interface OriginalReadProjectionFacet extends OriginalExpiredReplayFacet {
  readonly currentEntry: boolean;
  readonly tokenSourceDependencies: { grants: DocChannelGrants } | undefined;
  managementReader: ReturnType<typeof createOriginalDocManagementReader> | undefined;
  readonly documentSaveInspections: WeakMap<
    DbTransaction,
    {
      scope: object;
      request: import('@dorkos/shared/schemas').CanvasDocumentSaveIdentity;
      hash: string;
      path: string;
    }
  >;
  readonly retainTokenManifestOwner: (
    grants: DocChannelGrants,
    store: import('../../store.js').DocChannelStore
  ) => void;
}
