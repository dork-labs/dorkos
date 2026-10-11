import type { DbTransaction } from '@dorkos/db';
import type { DocChannelStore } from '../../store.js';
import type { DocChannelGrants } from '../../grants.js';
import type {
  CurrentOperationScope,
  OriginalNativeDocTokenScope,
} from '../current-operation-types.js';
import type { createOriginalDocTokenCurrentReader } from '../../tokens/token-native-current.js';
import type { createOriginalDocTokenEventReader } from '../../tokens/token-native-reads.js';
import type { DocChannelTokenStore } from '../../tokens/token-store.js';
import type { OriginalTokenIssuanceFacet } from './current-token-issuance-context.js';
import type {
  tokenNativeCurrent,
  prepareTokenNativeRead,
} from './current-token-native-input-facet.js';
/** Original private token dependencies and current SQL owner, never caller-provided context. */
export interface OriginalTokenNativeInputFacet extends OriginalTokenIssuanceFacet {
  readonly tokenStore: DocChannelTokenStore | undefined;
  tokenCurrentReader: ReturnType<typeof createOriginalDocTokenCurrentReader> | undefined;
  tokenEventReader: ReturnType<typeof createOriginalDocTokenEventReader> | undefined;
  readonly tokenSourceDependencies:
    { store: DocChannelStore; grants: DocChannelGrants } | undefined;
  readonly restoredTokens: WeakMap<
    OriginalNativeDocTokenScope,
    { store: DocChannelStore; grants: DocChannelGrants; hash: string }
  >;
  currentEntry: boolean;
  readonly activeCurrent: WeakSet<DbTransaction>;
  readonly scopes: WeakMap<DbTransaction, CurrentOperationScope>;
  readonly tokenNativeCurrent: (own: {
    store: DocChannelStore;
    grants: DocChannelGrants;
    hash: string;
  }) => ReturnType<typeof tokenNativeCurrent>;
  readonly prepareTokenNativeRead: (own: {
    store: DocChannelStore;
    grants: DocChannelGrants;
    hash: string;
  }) => ReturnType<typeof prepareTokenNativeRead>;
  readonly initializeTokenReaders: () => void;
}
