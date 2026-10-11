import type { DbTransaction } from '@dorkos/db';
import type { DocChannelStore } from '../../store.js';
import type { DocChannelGrants } from '../../grants.js';
import type { DocChannelActor } from '../../authorization.js';
import type { DocChannelIngest } from '../../ingest.js';
import type { PresencePlan } from '../../presence.js';
import type {
  OriginalCurrentDocumentData,
  OriginalCurrentDocumentAuthority,
} from '../current-operation-types.js';
import type { createOriginalEditorSelectionReader } from '../../editor/selection-source.js';
import type { OriginalExpiredReplayFacet } from '../replay/current-expired-replay-context.js';
import type { createOriginalDocPresenceLedger } from '../../presence.js';
/** Private original maps and delegates, usable only through original engine lookup. */
export interface OriginalEventAdmissionFacet extends OriginalExpiredReplayFacet {
  readonly roomPumpStopped: boolean;
  readonly currentEntry: boolean;
  readonly presenceLedger: ReturnType<typeof createOriginalDocPresenceLedger>;
  readonly requirePresenceFocusPreflight: (stage: object, store: DocChannelStore) => void;
  readonly captureDocument: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    id: string,
    actor: DocChannelActor,
    ids: readonly string[],
    authority?: OriginalCurrentDocumentAuthority,
    fileSource?: import('../../tokens/token-native-file-source.js').OriginalDocTokenFileSource,
    selectOriginalEvent?: import('@dorkos/shared/canvas-channel-schemas').StoredPageEvent
  ) => Promise<OriginalCurrentDocumentData>;
  readonly presenceFocusStages: WeakMap<
    object,
    {
      store: DocChannelStore;
      ingest: DocChannelIngest;
      grants: DocChannelGrants;
      actor: DocChannelActor;
      plan: PresencePlan;
      caller: string;
      event: import('@dorkos/shared/canvas-channel-schemas').StoredPageEvent;
      fileSource: import('../../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
    }
  >;
  readonly presenceFocusTransactions: WeakMap<DbTransaction, object>;
  readonly documentSaves: WeakMap<
    object,
    {
      store: DocChannelStore;
      grants: DocChannelGrants;
      actor: DocChannelActor;
      request: import('@dorkos/shared/schemas').CanvasDocumentSaveIdentity;
      authority: import('../current-operation-types.js').OriginalCurrentDocumentAuthority;
      fileSource: import('../../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
      event: import('@dorkos/shared/canvas-channel-schemas').StoredPageEvent;
      hash: string;
      consumed: boolean;
    }
  >;
  readonly documentSaveCompletions: WeakMap<
    DbTransaction,
    { scope: object; hash: string; path: string }
  >;
  readonly documentAuthorities: WeakMap<
    import('../current-operation-types.js').OriginalCurrentDocumentAuthority,
    {
      store: DocChannelStore;
      grants: DocChannelGrants;
      actor: DocChannelActor;
      documentId: string;
      grantIds: readonly string[];
      writeObservation?: import('../../grant-policy.js').DocOriginalWriteObservation;
      baseline: unknown;
      data: import('../current-operation-types.js').OriginalCurrentDocumentData;
    }
  >;
  readonly editorSelections: WeakMap<
    DbTransaction,
    {
      request: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelSelectionRequest;
      fileSource: import('../../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
      source: ReturnType<ReturnType<typeof createOriginalEditorSelectionReader>['read']>;
    }
  >;
}
