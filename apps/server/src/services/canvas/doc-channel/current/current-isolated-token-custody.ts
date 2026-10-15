import type { Db, DbTransaction } from '@dorkos/db';
import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';
import { DocChannelNotFoundError } from '../authorization/authorization-data.js';
import type { DocChannelAuthorization } from '../authorization.js';
import type { DocChannelStore, EventInput } from '../store.js';
import {
  requireDocChannelTokenStoreDatabase,
  type DocChannelTokenStore,
  type OriginalStoredDocTokenData,
} from '../tokens/token-store.js';
import { encodeOriginalDocTokenIssuanceAuthentication } from '../tokens/token-authentication-message.js';

type OriginalRevocationData = Readonly<{
  tokenId: string;
  tokenHash: string;
  documentId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string;
}>;

/** Exact named isolated map/consumer contract; actual instance remains private to the engine. */
interface IsolatedCurrentTokenCustody {
  readonly originalPresenceAppends: WeakMap<
    DbTransaction,
    { authorization: DocChannelAuthorization; store: DocChannelStore; input: EventInput }
  >;
  readonly originalTokenIssues: WeakMap<
    import('./current-operation-types.js').OriginalDocTokenIssuanceStage,
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
    import('./current-operation-types.js').OriginalDocTokenRevocationStage,
    {
      db: Db;
      store: DocChannelTokenStore;
      tx: DbTransaction;
      consumed: boolean;
      active: boolean;
      data: OriginalRevocationData;
      requireCurrent: () => void;
    }
  >;
  readonly consumeOriginalDocPresenceAppend: (
    authorization: DocChannelAuthorization,
    store: DocChannelStore,
    tx: DbTransaction
  ) => EventInput;
  readonly consumeOriginalDocTokenIssuanceInsideCurrent: (
    stage: import('./current-operation-types.js').OriginalDocTokenIssuanceStage,
    store: DocChannelTokenStore,
    db: Db,
    tx: DbTransaction
  ) => OriginalStoredDocTokenData;
  readonly requireOriginalDocTokenIssuanceAuthenticationEntry: (
    stage: import('./current-operation-types.js').OriginalDocTokenIssuanceStage,
    db: Db,
    tx: DbTransaction
  ) => void;
  readonly readOriginalDocTokenIssuanceAuthenticationMessage: (
    stage: import('./current-operation-types.js').OriginalDocTokenIssuanceStage,
    db: Db,
    tx: DbTransaction
  ) => string;
  readonly consumeOriginalDocTokenRevocationInsideCurrent: (
    stage: import('./current-operation-types.js').OriginalDocTokenRevocationStage,
    store: DocChannelTokenStore,
    db: Db,
    tx: DbTransaction
  ) => OriginalRevocationData;
}

/** Create unrelated private stage custody; only the original engine holds its actual instance. */
export function createIsolatedCurrentTokenCustody(): IsolatedCurrentTokenCustody {
  const originalPresenceAppends = new WeakMap<
    DbTransaction,
    { authorization: DocChannelAuthorization; store: DocChannelStore; input: EventInput }
  >();
  /** Only the original active private engine can stage this fixed quiet system append. */
  function consumeOriginalDocPresenceAppend(
    authorization: DocChannelAuthorization,
    store: DocChannelStore,
    tx: DbTransaction
  ): EventInput {
    const own = originalPresenceAppends.get(tx);
    if (!own || own.authorization !== authorization || own.store !== store)
      throw new DocChannelNotFoundError();
    originalPresenceAppends.delete(tx);
    return own.input;
  }
  const originalTokenIssues = new WeakMap<
    import('./current-operation-types.js').OriginalDocTokenIssuanceStage,
    {
      db: Db;
      tokenStore: DocChannelTokenStore;
      activeTx?: DbTransaction;
      consumed: boolean;
      data: OriginalStoredDocTokenData;
      unsignedData: OriginalStoredDocTokenData;
      requireCurrent: () => void;
    }
  >();
  /** Fixed native store writer may consume data only inside the owning engine entry. */
  function consumeOriginalDocTokenIssuanceInsideCurrent(
    stage: import('./current-operation-types.js').OriginalDocTokenIssuanceStage,
    store: DocChannelTokenStore,
    db: Db,
    tx: DbTransaction
  ): OriginalStoredDocTokenData {
    const own = originalTokenIssues.get(stage);
    if (
      !own ||
      own.db !== db ||
      own.tokenStore !== store ||
      own.activeTx !== tx ||
      own.consumed ||
      !db.$client.inTransaction
    )
      throw new DocChannelNotFoundError();
    requireServerNativeDatabaseQueryCustody(db);
    requireDocChannelTokenStoreDatabase(store, db);
    own.requireCurrent();
    own.consumed = true; // Before the first actual insert; failed stages cannot be retried.
    return own.data;
  }
  /** Lookup-only active stage entry before any configured currentness callbacks. */
  function requireOriginalDocTokenIssuanceAuthenticationEntry(
    stage: import('./current-operation-types.js').OriginalDocTokenIssuanceStage,
    db: Db,
    tx: DbTransaction
  ): void {
    const own = originalTokenIssues.get(stage);
    if (!own || own.db !== db || own.activeTx !== tx || own.consumed)
      throw new DocChannelNotFoundError();
    requireServerNativeDatabaseQueryCustody(db);
    if (!db.$client.inTransaction) throw new DocChannelNotFoundError();
    requireDocChannelTokenStoreDatabase(own.tokenStore, db);
  }
  /** Authentication bytes only for the actual once-only active original issuance stage. */
  function readOriginalDocTokenIssuanceAuthenticationMessage(
    stage: import('./current-operation-types.js').OriginalDocTokenIssuanceStage,
    db: Db,
    tx: DbTransaction
  ): string {
    requireOriginalDocTokenIssuanceAuthenticationEntry(stage, db, tx);
    const own = originalTokenIssues.get(stage)!;
    own.requireCurrent();
    return encodeOriginalDocTokenIssuanceAuthentication(own.unsignedData);
  }
  const originalTokenRevocations = new WeakMap<
    import('./current-operation-types.js').OriginalDocTokenRevocationStage,
    {
      db: Db;
      store: DocChannelTokenStore;
      tx: DbTransaction;
      consumed: boolean;
      active: boolean;
      data: OriginalRevocationData;
      requireCurrent: () => void;
    }
  >();
  /** Consume revocation DATA only inside its exact original issuance-store transaction. */
  function consumeOriginalDocTokenRevocationInsideCurrent(
    stage: import('./current-operation-types.js').OriginalDocTokenRevocationStage,
    store: DocChannelTokenStore,
    db: Db,
    tx: DbTransaction
  ): OriginalRevocationData {
    const own = originalTokenRevocations.get(stage);
    if (
      !own ||
      !own.active ||
      own.consumed ||
      own.db !== db ||
      own.store !== store ||
      own.tx !== tx
    )
      throw new DocChannelNotFoundError();
    // Retain the attempted one-use latch before any effectful native/source currentness gate can reenter.
    own.consumed = true;
    requireServerNativeDatabaseQueryCustody(db);
    requireDocChannelTokenStoreDatabase(store, db);
    if (!db.$client.inTransaction) throw new DocChannelNotFoundError();
    own.requireCurrent();
    return own.data;
  }
  return Object.freeze({
    originalPresenceAppends,
    originalTokenIssues,
    originalTokenRevocations,
    consumeOriginalDocPresenceAppend,
    consumeOriginalDocTokenIssuanceInsideCurrent,
    requireOriginalDocTokenIssuanceAuthenticationEntry,
    readOriginalDocTokenIssuanceAuthenticationMessage,
    consumeOriginalDocTokenRevocationInsideCurrent,
  });
}
