import type { Db, DbTransaction } from '@dorkos/db';
import type { DocChannelTokenStore, OriginalStoredDocTokenData } from '../../tokens/token-store.js';
import type { OriginalDocTokenNativeFacts } from '../../tokens/token-native-facts.js';
import type { DocChannelStore } from '../../store.js';
import type { DocChannelGrants } from '../../grants.js';
import type {
  OriginalDocTokenIssuanceStage,
  OriginalDocTokenRevocationStage,
  OriginalCurrentDocumentAuthority,
} from '../current-operation-types.js';
import type { OriginalDocTokenFileSource } from '../../tokens/token-native-file-source.js';
import type { OriginalExpiredReplayFacet } from '../replay/current-expired-replay-context.js';
import type { OriginalEventAdmissionFacet } from '../projection/current-event-admission-context.js';
/** Original private token maps, live latches and captured intrinsics; no membership issuer. */
export interface OriginalTokenIssuanceFacet extends OriginalExpiredReplayFacet {
  readonly roomPumpStopped: boolean;
  readTokenNativeFacts: ((documentId: string) => OriginalDocTokenNativeFacts) | undefined;
  tokenNativeCloseFailure: { cause: unknown } | undefined;
  readonly retainTokenManifestOwner: (grants: DocChannelGrants, store: DocChannelStore) => void;
  readonly originalTokenStore: () => DocChannelTokenStore;
  readonly readDocumentAuthority: (
    store: DocChannelStore,
    grants: DocChannelGrants,
    authority: OriginalCurrentDocumentAuthority
  ) => NonNullable<ReturnType<OriginalEventAdmissionFacet['documentAuthorities']['get']>>;
  readonly tokenStages: WeakMap<
    OriginalDocTokenIssuanceStage,
    {
      store: DocChannelStore;
      grants: DocChannelGrants;
      authority: OriginalCurrentDocumentAuthority;
      state: 'prepared' | 'committing' | 'retired';
      fileSource: OriginalDocTokenFileSource;
    }
  >;
  readonly originalTokenIssues: WeakMap<
    OriginalDocTokenIssuanceStage,
    {
      db: Db;
      tokenStore: DocChannelTokenStore;
      activeTx?: DbTransaction;
      consumed: boolean;
      data: OriginalStoredDocTokenData;
      unsignedData: OriginalStoredDocTokenData;
      requireCurrent: () => void;
    }
  >;
  readonly originalTokenRevocations: WeakMap<
    OriginalDocTokenRevocationStage,
    {
      db: Db;
      store: DocChannelTokenStore;
      tx: DbTransaction;
      consumed: boolean;
      active: boolean;
      data: Readonly<{
        tokenId: string;
        tokenHash: string;
        documentId: string;
        createdAt: string;
        expiresAt: string;
        revokedAt: string;
      }>;
      requireCurrent: () => void;
    }
  >;
  readonly MaintenanceDate: typeof Date;
  readonly maintenanceNow: typeof Date.now;
  readonly maintenanceParse: typeof Date.parse;
  readonly maintenanceIso: Date['toISOString'];
  readonly tokenScalarJson: typeof JSON.stringify;
  readonly tokenOwnDescriptor: typeof Object.getOwnPropertyDescriptor;
  readonly tokenOwnKeys: typeof Object.keys;
  readonly tokenUtf8Bytes: typeof Buffer.byteLength;
}
