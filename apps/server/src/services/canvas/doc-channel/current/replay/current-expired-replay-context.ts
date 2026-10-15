import type { Db, DbTransaction } from '@dorkos/db';
import type {
  DocChannelAuthorization,
  DocChannelActor,
  DocChannelAuthorityPorts,
} from '../../authorization.js';
import type { DocChannelStore } from '../../store.js';
import type { DocChannelGrants } from '../../grants.js';
import type {
  CurrentDocOperationEngineCore,
  CurrentOperationScope,
  DocEventCondition,
  OriginalCurrentDocumentAuthority,
  OriginalCurrentDocumentData,
} from '../current-operation-types.js';
import type {
  createOriginalDocTokenFileSourceReader,
  OriginalDocTokenFileSource,
} from '../../tokens/token-native-file-source.js';
import type { CurrentRoomOperation } from '../../operations/room-current-operation.js';
/** Fixed delegates to the unreachable original engine; this interface does not issue owner membership. */
export interface OriginalExpiredReplayFacet {
  readonly db: Db;
  readonly authorization: DocChannelAuthorization;
  readonly fixedPorts: DocChannelAuthorityPorts;
  readonly core: CurrentDocOperationEngineCore;
  readonly room: CurrentRoomOperation | undefined;
  tokenFileSourceReader: ReturnType<typeof createOriginalDocTokenFileSourceReader> | undefined;
  readonly preflightCurrent: (
    documentId: string,
    actor: DocChannelActor,
    write: boolean
  ) => Promise<void>;
  readonly captureDocument: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    documentId: string,
    actor: DocChannelActor,
    ids: readonly string[],
    authority?: OriginalCurrentDocumentAuthority,
    source?: OriginalDocTokenFileSource
  ) => Promise<OriginalCurrentDocumentData>;
  readonly readDocumentAuthority: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    authority: OriginalCurrentDocumentAuthority
  ) => { writeObservation?: import('../../grant-policy.js').DocOriginalWriteObservation };
  readonly ensureRoom: () => void;
  readonly beginCurrent: (
    store: DocChannelStore,
    tx: DbTransaction,
    documentId: string,
    actor: DocChannelActor,
    write: boolean,
    condition: DocEventCondition | 'server-initial-replay',
    authority?: OriginalCurrentDocumentAuthority
  ) => CurrentOperationScope;
  readonly finalCurrent: (store: DocChannelStore, tx: DbTransaction) => void;
  readonly retireCurrent: (tx: DbTransaction) => void;
}
