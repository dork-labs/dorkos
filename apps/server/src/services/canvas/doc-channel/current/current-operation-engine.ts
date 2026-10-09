import { queueCommittedDocEvent } from '../committed-events.js';
import { createOriginalDocPresenceLedger, type PresencePlan } from '../presence.js';
import {
  CanvasChannelPresenceRequestSchema,
  CanvasChannelPresenceResponseSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  appendOriginalDocPresenceEvent,
  auditCurrentDocAppendIntentions,
  type EventInput,
} from '../store.js';
const originalPresenceAppends = new WeakMap<
  DbTransaction,
  { authorization: DocChannelAuthorization; store: DocChannelStore; input: EventInput }
>();
/** Only the original active private engine can stage this fixed quiet system append. */
export function consumeOriginalDocPresenceAppend(
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
import {
  checkInstallationFileSaveScope,
  readOriginalDocumentFileSaveCurrent,
  readOriginalDocumentFileSave,
  requireOriginalDocumentFileSaveCompleted,
} from '../writes/installation-file-writes.js';
import { createOriginalEditorSelectionReader } from '../editor/selection-source.js';
import { requireOriginalRoomEmissionFrameTransaction } from '../operations/room-responder-operation.js';
import { readOriginalReviewedDocReplayRoute } from '../grant-revalidation.js';
import { readCurrentStoreGetBatch } from './current-operation-row-audit.js';
import { requireOriginalNativeDownstreamStore } from '../store.js';
import { readOriginalDocIngestLimits } from '../ingest.js';
import { protectedCapacityQuery } from './accounting.js';
import { scanCheckboxReservationPolicies } from '../writes/reservations/reservation-policy-census.js';
import {
  createOriginalDocManagementReader,
  projectDocManagementRows,
} from '../management/snapshot-data.js';
import { requireServiceOriginalTokenDependencies } from '../service.js';
import { requireOriginalTokenDocumentManifestClosed } from '../grant-revalidation.js';
import { sameOriginalDocTokenData } from '../tokens/token-native-comparison.js';
import { createOriginalDocTokenFileSourceReader } from '../tokens/token-native-file-source.js';
import { parseOriginalDocTokenCapsuleData } from '../tokens/token-native-data.js';
import { createOriginalDocTokenCurrentReader } from '../tokens/token-native-current.js';
import { createOriginalDocTokenEventReader } from '../tokens/token-native-reads.js';
import { readOriginalTokenDocumentManifest } from '../grant-revalidation.js';
import {
  authenticateOriginalDocTokenIssuance,
  verifyOriginalDocTokenNativeCapsule,
} from '../../../core/auth/index.js';
import {
  encodeOriginalDocTokenIssuanceAuthentication,
  encodeOriginalDocTokenHeaderAuthentication,
} from '../tokens/token-authentication-message.js';
import { createOriginalDocTokenNativeFactsReader } from '../tokens/token-native-facts.js';
import type { OriginalDocTokenNativeFacts } from '../tokens/token-native-facts.js';
import { requireServerNativeDatabaseQueryCustody } from '@dorkos/db/internal-server';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  DocChannelTokenStore,
  readOriginalDocTokenRevocationData,
  writeOriginalDocTokenRevocationInsideCurrent,
  requireDocChannelTokenStoreDatabase,
  writeOriginalDocTokenIssuanceInsideCurrent,
  readOriginalNativeDocTokenHeaderByHash,
  type OriginalStoredDocTokenData,
} from '../tokens/token-store.js';
import {
  CurrentRoomOperation,
  readOriginalRoomPendingWriteCount,
  readOriginalRoomTokenSource,
  readOriginalRoomOperatorSource,
  readOriginalRoomReplayAvailability,
} from '../operations/room-current-operation.js';
import { retainDocHistory } from '../retention.js';
const MaintenanceDate = Date;
const maintenanceNow = Date.now;
const maintenanceParse = Date.parse;
const tokenStreamDelay = setTimeout,
  tokenStreamCancel = clearTimeout;
type TokenStreamState = {
  scope: import('./current-operation-types.js').OriginalNativeDocTokenScope;
  cursor: number;
  closed: boolean;
  reading: boolean;
  closedPromise: Promise<void>;
  resolveClosed: () => void;
  timer?: ReturnType<typeof setTimeout>;
  wake?: () => void;
};
const tokenScalarJson = JSON.stringify;
const tokenOwnDescriptor = Object.getOwnPropertyDescriptor;
const tokenOwnKeys = Object.keys;
const tokenUtf8Bytes = Buffer.byteLength;
const maintenanceIso = Date.prototype.toISOString;
import {
  readCurrentDocAccessRows,
  auditCurrentDocFinalRows,
  readCurrentGrantSourceRows,
} from './current-operation-row-audit.js';
import {
  readCurrentDocBirthRows,
  captureCurrentDocCondition,
  publicCurrentDelivery,
} from './current-operation-intentions.js';
import {
  captureNativePrincipalTime,
  readCurrentNativePrincipal,
} from '../../../connectors/principal/runtime-principal-service.js';

/** Document authorization resolves private identity before disclosing channel data. */
import {
  and,
  eq,
  sql,
  canvasDocBatches,
  canvasDocDeliveries,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import { isServerPrincipal } from '../../../connectors/principal/server-principal.js';

import { type CanvasDocumentStore } from '../../canvas-document-store.js';
import {
  CanvasChannelSelectionRequestSchema,
  StoredPageEventSchema,
  PageEventSchema,
  CanvasChannelBatchReplayRequestSchema,
  CanvasChannelBatchReplayResultSchema,
  matchesCanvasChannelEvent,
  CanvasChannelManagementSnapshotSchema,
  CanvasChannelTokenRequestSchema,
  CanvasChannelCheckboxBindingSchema,
  type CanvasChannelEventReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import { requireDocChannelStoreDatabase, type DocChannelStore } from '../store.js';
import {
  type DocChannelIngest,
  acceptCurrentDocEventInTransaction,
  captureCurrentDocIngestClock,
  auditCurrentDocIngestRows,
} from '../ingest.js';

import { type DocChannelGrants } from '../grants.js';
import {
  prepareOriginalTokenGrantInput,
  prepareCurrentDocGrantRoutes,
  readOriginalCurrentDocReplayRouting,
  prepareCurrentDocCheckboxGrantRoutes,
  captureCurrentDocumentGrantDependencies,
  documentDependenciesBeforeOriginalGrantInsertion,
  requireCurrentDocumentGrantFinal,
  requireCurrentDocGrantEngine,
  auditCurrentDocGrantRows,
  refreshCurrentDocGrantAuthority,
} from '../grant-revalidation.js';
import { documentTransaction } from '../storage/store-transaction.js';
import { withCheckboxReadOnlyGate, checkboxAuthoritySync } from '../writes/authority-snapshot.js';
import { readDocEventRow } from '../writes/reservations/reservation-policy-census.js';
import {
  captureCurrentDocConfiguration,
  copyCurrentDocData,
  sameCurrentDocData,
} from './current-operation-data.js';
import {
  readCurrentDocReplayInTransaction,
  projectCurrentDocReplay,
  projectCurrentDocReceipt,
  readCurrentReceiptChannelRow,
  readCurrentReplayChannelRow,
} from '../replay.js';
import { envelopeIdentity } from '../envelope.js';
import { isSqliteStorageError } from '../ingest.js';
import { DocIngestRefusal } from '../ingest-types.js';
import {
  type CurrentOperationScope,
  type CurrentDocOperationEngineCore,
  type DocCurrentReplayResponse,
  type DocEventCondition,
  type DocReceiptInspection,
} from './current-operation-types.js';

import {
  readCurrentDocIngressInput,
  captureCurrentHttpDocActor,
  DocChannelNotFoundError,
  DocChannelArchivedError,
  requireCurrentDocConstructorEngines,
  requireCurrentDocEngineOrigin,
  failCurrentDocOperation,
  type DocChannelAuthorization,
  type DocChannelActor,
  type DocChannelAuthorityPorts,
} from '../authorization.js';

import {
  requireOriginalCheckboxCompletionOwner,
  readOriginalCheckboxCompletionStage,
  consumeOriginalCheckboxCompletionStage,
  requireOriginalCheckboxCompletionCommitted,
} from '../writes/completion.js';
import { prepareCurrentCheckboxIngest, finishCurrentCheckboxIngest } from '../ingest.js';
export type { CurrentOperationScope, CurrentDocOperationEngineCore };
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
export function consumeOriginalDocTokenIssuanceInsideCurrent(
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
export function requireOriginalDocTokenIssuanceAuthenticationEntry(
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
export function readOriginalDocTokenIssuanceAuthenticationMessage(
  stage: import('./current-operation-types.js').OriginalDocTokenIssuanceStage,
  db: Db,
  tx: DbTransaction
): string {
  requireOriginalDocTokenIssuanceAuthenticationEntry(stage, db, tx);
  const own = originalTokenIssues.get(stage)!;
  own.requireCurrent();
  return encodeOriginalDocTokenIssuanceAuthentication(own.unsignedData);
}
type OriginalRevocationData = Readonly<{
  tokenId: string;
  tokenHash: string;
  documentId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string;
}>;
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
export function consumeOriginalDocTokenRevocationInsideCurrent(
  stage: import('./current-operation-types.js').OriginalDocTokenRevocationStage,
  store: DocChannelTokenStore,
  db: Db,
  tx: DbTransaction
): OriginalRevocationData {
  const own = originalTokenRevocations.get(stage);
  if (!own || !own.active || own.consumed || own.db !== db || own.store !== store || own.tx !== tx)
    throw new DocChannelNotFoundError();
  // Retain the attempted one-use latch before any effectful native/source currentness gate can reenter.
  own.consumed = true;
  requireServerNativeDatabaseQueryCustody(db);
  requireDocChannelTokenStoreDatabase(store, db);
  if (!db.$client.inTransaction) throw new DocChannelNotFoundError();
  own.requireCurrent();
  return own.data;
}
class CurrentDocOperationEngine {
  readonly #documentSaves = new WeakMap<
    object,
    {
      store: DocChannelStore;
      grants: DocChannelGrants;
      actor: DocChannelActor;
      request: import('@dorkos/shared/schemas').CanvasDocumentSaveIdentity;
      authority: import('./current-operation-types.js').OriginalCurrentDocumentAuthority;
      fileSource: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
      event: import('@dorkos/shared/canvas-channel-schemas').StoredPageEvent;
      hash: string;
      consumed: boolean;
    }
  >();
  readonly #documentSaveInspections = new WeakMap<
    DbTransaction,
    {
      scope: object;
      request: import('@dorkos/shared/schemas').CanvasDocumentSaveIdentity;
      hash: string;
      path: string;
    }
  >();
  readonly #documentSaveCompletions = new WeakMap<
    DbTransaction,
    { scope: object; hash: string; path: string }
  >();
  #tokenSourceDependencies?: {
    service: import('../service.js').DocChannelService;
    store: DocChannelStore;
    grants: DocChannelGrants;
  };
  readonly #restoredTokens = new WeakMap<
    import('./current-operation-types.js').OriginalNativeDocTokenScope,
    { store: DocChannelStore; grants: DocChannelGrants; hash: string }
  >();
  #tokenFileSourceReader?: ReturnType<typeof createOriginalDocTokenFileSourceReader>;
  #tokenCurrentReader?: ReturnType<typeof createOriginalDocTokenCurrentReader>;
  #tokenEventReader?: ReturnType<typeof createOriginalDocTokenEventReader>;
  #managementReader?: ReturnType<typeof createOriginalDocManagementReader>;
  #tokenStore?: DocChannelTokenStore;
  #readTokenNativeFacts?: (documentId: string) => OriginalDocTokenNativeFacts;
  readonly #activeTokenOperations = new Set<Promise<unknown>>();
  readonly #presenceLedger = createOriginalDocPresenceLedger();
  readonly #presenceDocuments = new Map<
    string,
    {
      store: DocChannelStore;
      actor: DocChannelActor;
      birth: CurrentOperationScope['birth'];
      scope: string;
      callers: Map<string, DocChannelActor>;
    }
  >();
  readonly #presenceNow = Date.now.bind(Date);
  readonly #presenceSetTimeout = setTimeout;
  readonly #presenceClearTimeout = clearTimeout;
  #presenceTimer: ReturnType<typeof setTimeout> | undefined;
  #presenceTail: Promise<void> = Promise.resolve();
  #presenceFailure: { cause: unknown } | undefined;
  readonly #presenceFailures = new Map<string, { cause: unknown }>();
  readonly #presenceFocusStages = new WeakMap<
    object,
    {
      store: DocChannelStore;
      ingest: DocChannelIngest;
      grants: DocChannelGrants;
      actor: DocChannelActor;
      plan: PresencePlan;
      caller: string;
      event: import('@dorkos/shared/canvas-channel-schemas').StoredPageEvent;
      fileSource: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
    }
  >();
  readonly #presenceFocusTransactions = new WeakMap<DbTransaction, object>();

  readonly #tokenStreams = new WeakMap<
    import('./current-operation-types.js').OriginalNativeDocTokenStream,
    TokenStreamState
  >();
  readonly #liveTokenStreams = new Set<TokenStreamState>();
  #tokenRoomPeerClosed = false;
  readonly #tokenManifestOwners: { grants: DocChannelGrants; store: DocChannelStore }[] = [];
  #tokenNativeCloseFailure: { cause: unknown } | undefined;
  readonly #tokenStages = new WeakMap<
    import('./current-operation-types.js').OriginalDocTokenIssuanceStage,
    {
      store: DocChannelStore;
      grants: DocChannelGrants;
      authority: import('./current-operation-types.js').OriginalCurrentDocumentAuthority;
      state: 'prepared' | 'committing' | 'retired';
      fileSource: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
    }
  >();
  readonly #nativePrepare: Db['$client']['prepare'];
  readonly #documentAuthorities = new WeakMap<
    import('./current-operation-types.js').OriginalCurrentDocumentAuthority,
    {
      store: DocChannelStore;
      grants: DocChannelGrants;
      actor: DocChannelActor;
      documentId: string;
      grantIds: readonly string[];
      writeObservation?: import('../grant-policy.js').DocOriginalWriteObservation;
      baseline: unknown;
      data: import('./current-operation-types.js').OriginalCurrentDocumentData;
    }
  >();
  readonly #core: CurrentDocOperationEngineCore;
  readonly #activeCurrent = new WeakSet<DbTransaction>();
  #currentEntry = false;
  readonly #editorSelectionReader = createOriginalEditorSelectionReader();
  readonly #editorSelections = new WeakMap<
    DbTransaction,
    {
      request: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelSelectionRequest;
      fileSource: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
      source: ReturnType<ReturnType<typeof createOriginalEditorSelectionReader>['read']>;
    }
  >();
  #room?: CurrentRoomOperation;
  readonly #checkboxCommits = new WeakMap<
    DbTransaction,
    {
      owner: object;
      store: DocChannelStore;
      now: string;
      generation: string;
      physical: Record<string, unknown>;
      channelBirth: Record<string, unknown>;
      roomPrepared: boolean;
    }
  >();
  #roomPumpStopped = false;
  #roomConstruction: 'unstarted' | 'constructing' | 'ready' | 'failed' = 'unstarted';
  #roomConstructionFailure: { cause: unknown } | undefined;
  #roomStop: Promise<void> | undefined;
  #resolveRoomStop: (() => void) | undefined;
  #rejectRoomStop: ((cause: unknown) => void) | undefined;
  #roomStopStarted = false;
  readonly #fixedPorts: DocChannelAuthorityPorts;
  readonly #authorization: DocChannelAuthorization;
  readonly #db: Db;
  readonly #scopes: WeakMap<DbTransaction, CurrentOperationScope>;
  constructor(
    authorization: DocChannelAuthorization,
    db: Db,
    documents: CanvasDocumentStore,
    ports: DocChannelAuthorityPorts,
    scopes: WeakMap<DbTransaction, CurrentOperationScope>
  ) {
    this.#authorization = authorization;
    this.#db = db;
    this.#nativePrepare = db.$client.prepare.bind(db.$client);
    this.#scopes = scopes;
    this.#fixedPorts = captureCurrentDocConfiguration(ports);
    this.#core = Object.freeze<CurrentDocOperationEngineCore>({
      roomPendingWrites: (tx) =>
        this.#room ? readOriginalRoomPendingWriteCount(this.#room, tx) : 0,
      presence: (store, ingest, grants, id, rawActor, raw) => {
        const actor = captureCurrentHttpDocActor(rawActor);
        if (actor.surface !== 'http') throw new DocChannelNotFoundError();
        const request = copyCurrentDocData(CanvasChannelPresenceRequestSchema.parse(raw));
        return this.#queuePresence(async () => {
          const response =
            request.action === 'focus'
              ? await this.#focusPresence(store, ingest, grants, id, actor, request)
              : await this.#updatePresence(store, id, actor, request);
          if (!response) throw new DocChannelNotFoundError();
          return response;
        });
      },

      requireCurrentAccess: (documentId, rawActor, write, tx) => {
        requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
        const actor = captureCurrentHttpDocActor(rawActor);
        return withCheckboxReadOnlyGate(this.#db, () =>
          this.#fixedCurrent(documentId, actor, write, tx, true)
        );
      },

      captureRoomOperatorProducer: (store, tx) => this.#captureRoomOperatorProducer(store, tx),
      requireRoomOperatorSource: (source) => this.#requireRoomOperatorSource(source),
      requireRoomOperatorNativeSource: (source, stage, tx, emitter) => {
        requireOriginalRoomEmissionFrameTransaction(stage, this.#db, tx, emitter);
        const own = readOriginalRoomOperatorSource(source, this.#core, this.#db);
        this.#requireOperatorRows(own.producer, tx);
        requireOriginalRoomEmissionFrameTransaction(stage, this.#db, tx, emitter);
        if (!sameCurrentDocData(readOriginalRoomOperatorSource(source, this.#core, this.#db), own))
          throw new DocChannelNotFoundError();
      },
      tokenIngressCurrent: (scope) =>
        this.#trackTokenOperation(() => {
          const own = this.#restoredTokens.get(scope);
          if (!own) throw new DocChannelNotFoundError();
          const current = this.#prepareTokenNativeRead(own);
          if (
            !current.data.permissions.includes('ingest') ||
            !current.data.directions.includes('upstream')
          )
            throw new DocChannelNotFoundError();
          return Promise.resolve(
            Object.freeze({
              documentId: current.header.documentId,
              generation: current.header.generation,
            })
          );
        }),
      bindTokenService: (service, store, grants) => {
        if (this.#tokenSourceDependencies) throw new DocChannelNotFoundError();
        requireServiceOriginalTokenDependencies(service, this.#authorization, store, grants);
        // The genuine constructor tuple is retained before any manifest/native reader acquisition.
        this.#tokenSourceDependencies = { service, store, grants };
      },
      inspectTokenInputReceipt: (scope, eventId) =>
        this.#trackTokenOperation(() => this.#inspectTokenInputReceipt(scope, eventId)),
      submitToken: (store, ingest, grants, scope, raw) =>
        this.#trackTokenOperation(() =>
          this.#submitTokenCurrent(store, ingest, grants, scope, raw)
        ),
      captureRoomTokenProducer: (store, tx) => this.#captureRoomTokenProducer(store, tx),
      requireRoomTokenSource: (source) => this.#requireRoomTokenSource(source),
      revokeToken: (store, grants, actor, documentId, tokenId) =>
        this.#trackTokenOperation(() =>
          this.#revokeToken(store, grants, actor, documentId, tokenId)
        ),
      tokenOpenStream: (scope, since) =>
        this.#trackTokenOperation(() => this.#openTokenStream(scope, since)),
      tokenStreamNext: (stream) => this.#trackTokenOperation(() => this.#nextTokenStream(stream)),
      tokenDrainData: () =>
        Object.freeze({
          roomPeerClosed: this.#tokenRoomPeerClosed,
          roomConstructed: this.#room !== undefined,
          activeTokenOperations: this.#activeTokenOperations.size,
          liveTokenStreams: this.#liveTokenStreams.size,
        }),
      tokenStreamState: (stream) => {
        const state = this.#tokenStreams.get(stream);
        if (!state) throw new DocChannelNotFoundError();
        return Object.freeze({ waiting: state.timer !== undefined, closed: state.closed });
      },
      tokenStreamClosed: (stream) => {
        const state = this.#tokenStreams.get(stream);
        if (!state) throw new DocChannelNotFoundError();
        return state.closedPromise;
      },
      tokenCloseStream: (stream) => this.#closeTokenStream(stream),
      restoreTokenScope: (store, grants, hash) =>
        this.#trackTokenOperation(() => this.#restoreTokenScope(store, grants, hash)),
      tokenReplay: (scope, since, limit, permission) =>
        this.#trackTokenOperation(() => this.#readTokenReplay(scope, since, limit, permission)),
      tokenEvent: (scope, eventId, permission) =>
        this.#trackTokenOperation(() => this.#readTokenEvent(scope, eventId, permission)),
      prepareTokenIssuance: (store, grants, actor, request, grantIds) =>
        this.#trackTokenOperation(() =>
          this.#prepareTokenIssuance(store, grants, actor, request, grantIds)
        ),
      commitTokenIssuance: (stage) =>
        this.#trackTokenOperation(() => this.#commitTokenIssuance(stage)),
      replayExpired: (store, ingest, grants, raw, actor) =>
        this.#trackTokenOperation(() =>
          this.#replayExpiredCurrent(store, ingest, grants, raw, actor)
        ),
      captureDocument: (store, grants, documentId, actor, grantIds) =>
        this.#captureDocument(store, grants, documentId, actor, grantIds),
      documentReplay: (store, grants, authority, since, limit) => {
        const own = this.#readDocumentAuthority(store, grants, authority);
        return this.#replayCurrent(store, own.documentId, own.actor, since, limit, authority);
      },
      documentInspect: (store, grants, authority, eventId) => {
        const own = this.#readDocumentAuthority(store, grants, authority);
        return this.#inspectCurrent(
          store,
          own.documentId,
          eventId,
          own.actor,
          { expectedGeneration: own.data.generation },
          authority
        );
      },
      documentSubmit: (store, ingest, grants, authority, raw) => {
        const own = this.#readDocumentAuthority(store, grants, authority);
        return this.#submitCurrent(
          store,
          ingest,
          grants,
          own.documentId,
          raw,
          own.actor,
          { expectedGeneration: own.data.generation },
          authority
        );
      },
      requireDocumentInTransaction: (store, grants, authority, tx) => {
        const own = this.#readDocumentAuthority(store, grants, authority);
        const scope = this.#beginCurrent(
          store,
          tx,
          own.documentId,
          own.actor,
          true,
          { expectedGeneration: own.data.generation },
          authority
        );
        try {
          this.#finalCurrent(store, tx);
        } catch (cause) {
          if (!scope.failure) scope.failure = { cause };
          throw scope.failure.cause;
        } finally {
          this.#retireCurrent(tx);
        }
      },
      requireDocument: (store, grants, authority) => {
        const own = this.#documentAuthorities.get(authority);
        if (!own || own.store !== store || own.grants !== grants)
          throw new DocChannelNotFoundError();
        return this.#captureDocument(
          store,
          grants,
          own.documentId,
          own.actor,
          own.grantIds,
          authority
        );
      },
      commitRoomResponder: (runtime, prepared) => {
        if (this.#roomPumpStopped) throw new Error('Original Room pump admission is stopped.');
        if (!this.#room) throw new Error('Original Room source is unavailable.');
        return this.#room.commitResponder(runtime, prepared);
      },
      prepareRoomResponder: (runtime, holder, key) => {
        if (this.#roomPumpStopped) throw new Error('Original Room pump admission is stopped.');
        if (!this.#room) throw new Error('Original Room source is unavailable.');
        return this.#room.prepareResponder(runtime, holder, key);
      },
      prepareCheckbox: (store, owner) => {
        requireOriginalCheckboxCompletionOwner(owner, store);
        requireDocChannelStoreDatabase(store, this.#db);
        if (this.#db.$client.inTransaction || this.#currentEntry)
          throw new Error('Original checkbox source preparation cannot nest.');
        this.#ensureRoom();
      },
      completeCheckbox: (store, grants, owner, tx) =>
        this.#completeCheckbox(store, grants, owner, tx),
      publishCheckbox: (store, owner, tx) => {
        requireOriginalCheckboxCompletionCommitted(owner, store, tx);
        if (this.#db.$client.inTransaction) throw new Error('Checkbox source lacks outer commit.');
        const own = this.#checkboxCommits.get(tx);
        if (!own) return;
        if (own.owner !== owner || own.store !== store)
          throw new Error('Foreign checkbox source commit.');
        this.#checkboxCommits.delete(tx);
        // Only Room ingress has a sealed original producer draft to publish.
        if (own.roomPrepared) this.#room!.committed(tx, own.now);
        // A session FILE inverse still owns the same genuine writer COMMIT tuple.
        // The original native facade independently refuses any admitted/claimed/ACKed batch.
        this.#room!.cancelOriginalCheckboxUndoPair(store, owner, tx, own);
      },
      abandonCheckbox: (owner, tx) => {
        const own = this.#checkboxCommits.get(tx);
        if (own && own.owner !== owner) throw new Error('Foreign checkbox source abandonment.');
        this.#checkboxCommits.delete(tx);
        this.#room?.abandoned(tx);
      },
      maintainHistory: (store) => this.#maintainHistory(store),
      nextRoomDueAt: () => (this.#roomPumpStopped ? undefined : this.#ensureRoom()?.nextDueAt()),
      wakeRoomDue: () => {
        if (!this.#roomPumpStopped) this.#ensureRoom()?.freezeDue();
      },
      hintRoomRelay: (documentId, batchId, generation) =>
        !this.#roomPumpStopped && (this.#room?.hintRelay(documentId, batchId, generation) ?? false),
      subscribeRoomRelay: (listener) =>
        this.#roomPumpStopped
          ? () => {}
          : (this.#ensureRoom()?.subscribeRelay(listener) ?? (() => {})),
      pumpRoomDue: async (registry) => {
        if (!this.#roomPumpStopped) await this.#ensureRoom()?.pump(registry);
      },
      stopRoomPump: () => this.#stopRoomPump(),
      readRoomScenarioEvidence: (documentId, batchId, generation) =>
        this.#room?.readScenarioEvidence(documentId, batchId, generation),
      prepareDocumentSave: (store, grants, scope, actor) =>
        this.#trackTokenOperation(() => this.#prepareDocumentSave(store, grants, scope, actor)),
      completeDocumentSave: (store, ingest, grants, scope, actor) =>
        this.#trackTokenOperation(() =>
          this.#completeDocumentSave(store, ingest, grants, scope, actor)
        ),
      selection: (store, ingest, grants, raw, actor) =>
        this.#trackTokenOperation(() => this.#selectionCurrent(store, ingest, grants, raw, actor)),
      submit: (store, ingest, grants, documentId, raw, actor, condition) =>
        this.#submitCurrent(store, ingest, grants, documentId, raw, actor, condition),
      inspect: (store, documentId, eventId, actor, condition) =>
        this.#inspectCurrent(store, documentId, eventId, actor, condition),
      management: (store, documentId, actor) => this.#managementCurrent(store, documentId, actor),
      replay: (store, documentId, actor, since, limit) =>
        this.#replayCurrent(store, documentId, actor, since, limit),
      final: (store, tx) => {
        try {
          this.#finalCurrent(store, tx);
        } catch (cause) {
          return failCurrentDocOperation(store, tx, cause);
        }
      },
    });
  }
  #completeCheckbox(
    store: DocChannelStore,
    grants: DocChannelGrants,
    owner: object,
    tx: DbTransaction
  ) {
    requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
    const original = readOriginalCheckboxCompletionStage(owner, store, tx);
    // Recovery has no authenticated live ingress actor. It cannot reconstruct one from its row.
    const { data, ingest } = original;
    if (data.subject.kind !== 'live')
      throw new Error(
        'Native checkbox Room source requires original authenticated producer custody.'
      );
    const scope = this.#beginCurrent(store, tx, data.access.documentId, data.subject.actor, true, {
      expectedGeneration: data.subject.approved.documentGeneration,
    });
    scope.event = data.event;
    scope.ingest = ingest;
    scope.grants = grants;
    scope.absentAdmission = true;
    scope.now = data.receivedAt;
    try {
      const selected = prepareCurrentDocCheckboxGrantRoutes(
        grants,
        store,
        this.#authorization,
        owner,
        tx
      );
      const route = data.access.routes[0];
      const current = selected.routes.find((candidate) => candidate.route.id === route?.route.id);
      if (
        data.access.routes.length !== 1 ||
        !current ||
        current.reason ||
        !sameCurrentDocData(current.route, route.route) ||
        current.grantId !== route.grantId ||
        current.grantRevision !== route.grantRevision
      )
        throw new Error('Original checkbox route differs from current consumed authority.');
      scope.access = data.access;
      scope.documentGrantSelection = {
        grants,
        ids: [route.grantId!],
        writeObservation: data.writeObservation,
      };
      const hasRoom = route.route.to === 'room:self' && route.route.turn.mode !== 'none';
      if (hasRoom && (this.#roomPumpStopped || !this.#room))
        throw new Error('Original checkbox Room source admission is unavailable.');
      this.#finalCurrent(store, tx);
      const physical = copyCurrentDocData(
        tx.get<Record<string, unknown>>(
          sql`SELECT * FROM canvas_documents WHERE id=${data.access.documentId}`
        )
      );
      const channelBirth = copyCurrentDocData(
        tx.get<Record<string, unknown>>(
          sql`SELECT document_id,scope,created_at,declaration,declaration_hash,opener_agent_id,manifest_hash
          FROM canvas_doc_channels WHERE document_id=${data.access.documentId}`
        )
      );
      if (!physical || !channelBirth)
        throw new Error('Original checkbox native birth is unavailable.');
      if (hasRoom) this.#room!.prepare(store, grants, tx);
      this.#finalCurrent(store, tx);
      prepareCurrentCheckboxIngest(ingest, store, this.#authorization, tx, original.phase);
      const receipt = consumeOriginalCheckboxCompletionStage(owner, store, tx);
      if (receipt.status !== 'changed')
        throw new Error('Original checkbox source did not commit a change.');
      scope.acceptedDocSeq = receipt.receipt.docSeq;
      finishCurrentCheckboxIngest(ingest, store, tx);
      if (hasRoom) this.#room!.seal(store, tx, readOriginalDocIngestLimits(ingest, store));
      this.#finalCurrent(store, tx);
      auditCurrentDocIngestRows(ingest, store, this.#authorization, tx);
      auditCurrentDocGrantRows(grants, store, this.#authorization, tx);
      if (hasRoom) this.#room!.audit(store, grants, tx);
      if (this.#room && route.route.turn.mode !== 'none') {
        this.#checkboxCommits.set(tx, {
          owner,
          store,
          now: data.receivedAt,
          generation: scope.generation,
          physical,
          channelBirth,
          roomPrepared: hasRoom,
        });
      }
      return receipt;
    } catch (cause) {
      this.#room?.abandoned(tx);
      if (!scope.failure) scope.failure = { cause };
      throw scope.failure.cause;
    } finally {
      this.#retireCurrent(tx);
    }
  }
  #readDocumentAuthority(
    store: DocChannelStore,
    grants: DocChannelGrants,
    authority: import('./current-operation-types.js').OriginalCurrentDocumentAuthority
  ) {
    const own = this.#documentAuthorities.get(authority);
    if (!own || own.store !== store || own.grants !== grants) throw new DocChannelNotFoundError();
    return own;
  }
  #documentGrantRows(documentId: string, tx: DbTransaction): unknown {
    const rows = readCurrentGrantSourceRows(documentId, tx);
    const {
      nextDocSeq: _seq,
      updatedAt: _updated,
      receiptRetentionFloor: _floor,
      ...channelIdentity
    } = rows.channel;
    return copyCurrentDocData({ ...rows, channel: channelIdentity });
  }
  #documentScopeBaseline(scope: CurrentOperationScope, dependencies: unknown): unknown {
    const {
      nextDocSeq: _seq,
      updatedAt: _updated,
      receiptRetentionFloor: _floor,
      ...channelIdentity
    } = scope.channelRow;
    return copyCurrentDocData({
      physical: scope.physicalRow,
      channel: channelIdentity,
      scope: scope.scope,
      dependencies,
    });
  }
  async #captureDocument(
    store: DocChannelStore,
    grants: DocChannelGrants,
    documentId: string,
    rawActor: DocChannelActor,
    rawIds: readonly string[],
    authority?: import('./current-operation-types.js').OriginalCurrentDocumentAuthority,
    nativeFileSource?: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource,
    selectOriginalEvent?: import('@dorkos/shared/canvas-channel-schemas').StoredPageEvent
  ): Promise<import('./current-operation-types.js').OriginalCurrentDocumentData> {
    const actor = captureCurrentHttpDocActor(rawActor);
    const requestedGrantIds = Object.freeze([...rawIds]);
    if (
      requestedGrantIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(requestedGrantIds).size !== requestedGrantIds.length
    )
      throw new DocChannelNotFoundError();
    requireCurrentDocConstructorEngines(this.#authorization, store, undefined, grants);
    await this.#preflightCurrent(documentId, actor, false);
    if (this.#db.$client.inTransaction || this.#currentEntry) throw new DocChannelNotFoundError();
    // Only the engine's original native FILE reader supplies this observation.
    // The persisted approved write binding is compared, never reused as current source evidence.
    let writeObservation: import('../grant-policy.js').DocOriginalWriteObservation | undefined;
    if (nativeFileSource) {
      if (
        !this.#tokenFileSourceReader ||
        !sameOriginalDocTokenData(nativeFileSource, this.#tokenFileSourceReader.observe(documentId))
      )
        throw new DocChannelNotFoundError();
      if (nativeFileSource.canonicalFile !== null) {
        const physical = nativeFileSource.policies.physical;
        writeObservation = Object.freeze({
          manifestHash: readOriginalTokenDocumentManifest(grants, store, this.#db, documentId),
          write: Object.freeze(
            CanvasChannelCheckboxBindingSchema.parse({
              operation: 'checkbox-toggle',
              sourceIdentity: physical.source_key,
              resolvedCwd: physical.resolved_cwd,
              treeKind: physical.tree_kind,
              canonicalPath: nativeFileSource.canonicalFile,
            })
          ),
        });
      }
    }
    return documentTransaction(this.#db, (tx) => {
      const scope = this.#beginCurrent(
        store,
        tx,
        documentId,
        actor,
        false,
        'server-initial-replay'
      );
      try {
        // Host selection retains only IDs chosen by the original fresh route core.
        // No request field or reflected grant method supplies this dependency set.
        scope.originalWriteObservation = writeObservation;
        if (selectOriginalEvent) scope.event = copyCurrentDocData(selectOriginalEvent);
        const selected = selectOriginalEvent
          ? prepareCurrentDocGrantRoutes(grants, store, this.#authorization, tx)
          : undefined;
        const grantIds = selected
          ? Object.freeze([
              ...new Set(
                selected.routes.flatMap((route) =>
                  !route.reason && route.grantId ? [route.grantId] : []
                )
              ),
            ])
          : requestedGrantIds;
        const dependencyRows = this.#documentGrantRows(documentId, tx);
        const dependencies = captureCurrentDocumentGrantDependencies(
          grants,
          store,
          documentId,
          actor,
          grantIds,
          tx,
          writeObservation
        );
        const {
          nextDocSeq: _seq,
          updatedAt: _updated,
          receiptRetentionFloor: _floor,
          ...channelIdentity
        } = scope.channelRow;
        const baseline = copyCurrentDocData({
          physical: scope.physicalRow,
          channel: channelIdentity,
          scope: scope.scope,
          dependencies,
        });
        const old = authority && this.#documentAuthorities.get(authority);
        if (
          authority &&
          (!old ||
            old.store !== store ||
            old.grants !== grants ||
            !sameCurrentDocData(old.baseline, baseline))
        )
          throw new DocChannelNotFoundError();
        scope.documentGrantSelection = { grants, ids: grantIds, writeObservation };
        this.#finalCurrent(store, tx);
        if (!sameCurrentDocData(dependencyRows, this.#documentGrantRows(documentId, tx)))
          throw new DocChannelNotFoundError();
        const token =
          authority ?? Object.freeze({ kind: 'original-current-document-authority' as const });
        const data = Object.freeze({
          authority: token,
          documentId,
          scope: scope.scope,
          generation: scope.generation,
          birth: Object.freeze({ ...scope.birth }),
        });
        if (!authority)
          this.#documentAuthorities.set(token, {
            store,
            grants,
            actor,
            documentId,
            grantIds,
            writeObservation,
            baseline,
            data,
          });
        return old?.data ?? data;
      } catch (cause) {
        if (!scope.failure) scope.failure = { cause };
        throw scope.failure.cause;
      } finally {
        this.#retireCurrent(tx);
      }
    });
  }
  #trackTokenOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#roomPumpStopped) return Promise.reject(new DocChannelNotFoundError());
    // Registration precedes any source/clock/member callback in the real operation.
    const pending = Promise.resolve().then(operation);
    this.#activeTokenOperations.add(pending);
    void pending.then(
      () => this.#activeTokenOperations.delete(pending),
      () => this.#activeTokenOperations.delete(pending)
    );
    return pending;
  }
  #retainTokenManifestOwner(grants: DocChannelGrants, store: DocChannelStore): void {
    for (let index = 0; index < this.#tokenManifestOwners.length; index++) {
      const own = this.#tokenManifestOwners[index]!;
      if (own.grants === grants) {
        if (own.store !== store) throw new DocChannelNotFoundError();
        return;
      }
    }
    Object.defineProperty(this.#tokenManifestOwners, String(this.#tokenManifestOwners.length), {
      value: { grants, store },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  #originalTokenStore(): DocChannelTokenStore {
    requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
    if (this.#roomPumpStopped || this.#db.$client.inTransaction || this.#currentEntry)
      throw new DocChannelNotFoundError();
    requireServerNativeDatabaseQueryCustody(this.#db);
    return (this.#tokenStore ??= new DocChannelTokenStore(this.#db));
  }
  #tokenNativeCurrent(own: { store: DocChannelStore; grants: DocChannelGrants; hash: string }) {
    requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
    requireDocChannelStoreDatabase(own.store, this.#db);
    requireCurrentDocGrantEngine(own.grants, own.store, this.#db);
    if (
      this.#roomPumpStopped ||
      !this.#tokenStore ||
      !this.#readTokenNativeFacts ||
      !this.#tokenCurrentReader ||
      !this.#tokenFileSourceReader
    )
      throw new DocChannelNotFoundError();
    const header = readOriginalNativeDocTokenHeaderByHash(this.#tokenStore, this.#db, own.hash);
    if (!header) throw new DocChannelNotFoundError();
    const payload = verifyOriginalDocTokenNativeCapsule(this.#db, header);
    const data = parseOriginalDocTokenCapsuleData(header, payload);
    if (!sameOriginalDocTokenData(data.facts, this.#readTokenNativeFacts(header.documentId)))
      throw new DocChannelNotFoundError();
    if (
      !sameOriginalDocTokenData(
        data.fileSource.policies,
        this.#tokenFileSourceReader.policies(header.documentId)
      )
    )
      throw new DocChannelNotFoundError();
    this.#tokenCurrentReader(header, data, this.#fixedPorts.originalInstallationId);
    return { header, data };
  }
  #prepareTokenNativeRead(own: { store: DocChannelStore; grants: DocChannelGrants; hash: string }) {
    if (this.#db.$client.inTransaction || this.#currentEntry) throw new DocChannelNotFoundError();
    const before = this.#tokenNativeCurrent(own);
    // Fixed native identity-intent guard has already refused pending/ambiguous
    // or moved ownership. FILE/manifest observation completes outside SQL.
    if (
      readOriginalTokenDocumentManifest(
        own.grants,
        own.store,
        this.#db,
        before.header.documentId
      ) !== before.header.manifestHash
    )
      throw new DocChannelNotFoundError();
    if (!this.#tokenFileSourceReader) throw new DocChannelNotFoundError();
    const fileSource = this.#tokenFileSourceReader.observe(before.header.documentId);
    if (!sameOriginalDocTokenData(before.data.fileSource, fileSource))
      throw new DocChannelNotFoundError();
    const current = this.#tokenNativeCurrent(own);
    if (
      encodeOriginalDocTokenHeaderAuthentication(
        before.header,
        verifyOriginalDocTokenNativeCapsule(this.#db, before.header)
      ) !==
      encodeOriginalDocTokenHeaderAuthentication(
        current.header,
        verifyOriginalDocTokenNativeCapsule(this.#db, current.header)
      )
    )
      throw new DocChannelNotFoundError();
    return { ...current, fileSource };
  }
  #initializeTokenReaders(): void {
    this.#originalTokenStore();
    this.#readTokenNativeFacts ??= createOriginalDocTokenNativeFactsReader(this.#db);
    this.#tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
      this.#db,
      this.#fixedPorts.originalRoomRepoStore
    );
    this.#tokenCurrentReader ??= createOriginalDocTokenCurrentReader(this.#db);
    this.#tokenEventReader ??= createOriginalDocTokenEventReader(this.#db);
  }
  async #restoreTokenScope(store: DocChannelStore, grants: DocChannelGrants, hash: string) {
    const dependencies = this.#tokenSourceDependencies;
    if (!dependencies || dependencies.store !== store || dependencies.grants !== grants)
      throw new DocChannelNotFoundError();
    this.#initializeTokenReaders();
    const own = { store, grants, hash };
    this.#retainTokenManifestOwner(grants, store);
    this.#prepareTokenNativeRead(own);
    const scope = Object.freeze({ kind: 'original-native-doc-token-scope' as const });
    this.#restoredTokens.set(scope, own);
    return scope;
  }
  async #openTokenStream(
    scope: import('./current-operation-types.js').OriginalNativeDocTokenScope,
    since: number
  ) {
    // Permission and full native source currentness precede retaining any stream/timer owner.
    await this.#readTokenReplay(scope, since, 1, 'stream');
    if (this.#roomPumpStopped) throw new DocChannelNotFoundError();
    const stage = Object.freeze({ kind: 'original-native-doc-token-stream' as const });
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const state: TokenStreamState = {
      scope,
      cursor: since,
      closed: false,
      reading: false,
      closedPromise,
      resolveClosed,
    };
    this.#tokenStreams.set(stage, state);
    this.#liveTokenStreams.add(state);
    return stage;
  }
  #closeTokenStream(
    stream: import('./current-operation-types.js').OriginalNativeDocTokenStream
  ): void {
    const state = this.#tokenStreams.get(stream);
    if (!state) throw new DocChannelNotFoundError();
    this.#retireTokenStream(state);
  }
  #retireTokenStream(state: TokenStreamState): void {
    if (state.closed) return;
    state.closed = true;
    state.resolveClosed();
    if (state.timer !== undefined) {
      tokenStreamCancel(state.timer);
      state.timer = undefined;
    }
    const wake = state.wake;
    state.wake = undefined;
    wake?.();
    this.#liveTokenStreams.delete(state);
  }
  async #nextTokenStream(
    stream: import('./current-operation-types.js').OriginalNativeDocTokenStream
  ) {
    const state = this.#tokenStreams.get(stream);
    if (!state || state.reading) throw new DocChannelNotFoundError();
    if (state.closed) return undefined;
    state.reading = true;
    try {
      const page = await this.#readTokenReplay(state.scope, state.cursor, 200, 'stream');
      if (state.closed || this.#roomPumpStopped) return undefined;
      state.cursor =
        page.rows.length === 200 ? Number(page.rows[199]!.doc_seq) : page.highWatermark;
      // A privately owned timer is cancelled by the original engine stop before its active read drains.
      if (page.rows.length === 0)
        await new Promise<void>((resolve) => {
          state.wake = resolve;
          state.timer = tokenStreamDelay(() => {
            state.timer = undefined;
            state.wake = undefined;
            resolve();
          }, 250);
        });
      return state.closed || this.#roomPumpStopped ? undefined : page;
    } catch (cause) {
      this.#retireTokenStream(state);
      throw cause;
    } finally {
      state.reading = false;
    }
  }
  async #readTokenReplay(
    scope: import('./current-operation-types.js').OriginalNativeDocTokenScope,
    since: number,
    limit: number,
    permission: 'replay' | 'stream' = 'replay'
  ) {
    const own = this.#restoredTokens.get(scope);
    if (!own || (permission !== 'replay' && permission !== 'stream'))
      throw new DocChannelNotFoundError();
    const prepared = this.#prepareTokenNativeRead(own);
    let allowed = false;
    for (let index = 0; index < prepared.data.permissions.length; index++)
      if (prepared.data.permissions[index] === permission) allowed = true;
    if (!allowed) throw new DocChannelNotFoundError();
    return documentTransaction(this.#db, () => {
      const current = this.#tokenNativeCurrent(own);
      const page = this.#tokenEventReader!.page(current.header, since, limit);
      this.#tokenNativeCurrent(own);
      return page;
    });
  }
  async #readTokenEvent(
    scope: import('./current-operation-types.js').OriginalNativeDocTokenScope,
    eventId: string,
    permission: 'replay' | 'stream'
  ) {
    const own = this.#restoredTokens.get(scope);
    if (!own || (permission !== 'replay' && permission !== 'stream'))
      throw new DocChannelNotFoundError();
    const prepared = this.#prepareTokenNativeRead(own);
    let allowed = false;
    for (let index = 0; index < prepared.data.permissions.length; index++)
      if (prepared.data.permissions[index] === permission) allowed = true;
    if (!allowed) throw new DocChannelNotFoundError();
    return documentTransaction(this.#db, () => {
      const current = this.#tokenNativeCurrent(own);
      const event = this.#tokenEventReader!.event(current.header, eventId);
      this.#tokenNativeCurrent(own);
      return event;
    });
  }
  async #inspectTokenInputReceipt(
    scope: import('./current-operation-types.js').OriginalNativeDocTokenScope,
    eventId: string
  ) {
    const own = this.#restoredTokens.get(scope);
    if (!own) throw new DocChannelNotFoundError();
    const prepared = this.#prepareTokenNativeRead(own);
    if (
      !prepared.data.permissions.includes('ingest') ||
      !prepared.data.directions.includes('upstream')
    )
      throw new DocChannelNotFoundError();
    return documentTransaction(this.#db, () => {
      const current = this.#tokenNativeCurrent(own);
      const response = copyCurrentDocData(this.#tokenEventReader!.receipt(current.header, eventId));
      this.#tokenNativeCurrent(own);
      if (!sameCurrentDocData(response, this.#tokenEventReader!.receipt(current.header, eventId)))
        throw new DocChannelNotFoundError();
      return response as import('@dorkos/shared/canvas-channel-schemas').CanvasChannelEventReceipt;
    });
  }
  async #submitTokenCurrent(
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    tokenScope: import('./current-operation-types.js').OriginalNativeDocTokenScope,
    raw: unknown
  ) {
    const own = this.#restoredTokens.get(tokenScope);
    if (!own || own.store !== store || own.grants !== grants) throw new DocChannelNotFoundError();
    requireCurrentDocConstructorEngines(this.#authorization, store, ingest, grants);
    const before = this.#prepareTokenNativeRead(own);
    if (!before.data.permissions.includes('ingest') || !before.data.directions.includes('upstream'))
      throw new DocChannelNotFoundError();
    const event = copyCurrentDocData(PageEventSchema.parse(raw));
    if (
      ['md.task.toggled', 'app.ack', 'state.changed', 'event.status'].includes(event.type) ||
      !before.data.allowedTypes.includes(event.type)
    )
      throw new DocIngestRefusal('TYPE_NOT_GRANTED', 403);
    // Carry the actual outside-SQL native FILE observation into the private
    // route preparation. Signed grant DATA supplies comparison, never observation.
    const physical = before.fileSource.policies.physical;
    const observed = Object.freeze({
      manifestHash: before.header.manifestHash,
      write:
        before.fileSource.canonicalFile === null
          ? null
          : Object.freeze(
              CanvasChannelCheckboxBindingSchema.parse({
                operation: 'checkbox-toggle',
                sourceIdentity: physical.source_key,
                resolvedCwd: physical.resolved_cwd,
                treeKind: physical.tree_kind,
                canonicalPath: before.fileSource.canonicalFile,
              })
            ),
    });
    const preparation = prepareOriginalTokenGrantInput(
      grants,
      store,
      this.#db,
      before.header.documentId,
      observed
    );
    this.#prepareTokenNativeRead(own);
    this.#ensureRoom();
    let committedTx: DbTransaction | undefined, committedAt: string | undefined;
    try {
      const response = documentTransaction(this.#db, (tx) => {
        requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
        if (this.#currentEntry || this.#scopes.has(tx)) throw new DocChannelNotFoundError();
        const current = this.#tokenNativeCurrent(own),
          rows = readCurrentDocBirthRows(tx, current.header.documentId);
        if (
          !rows ||
          rows.generation !== current.header.generation ||
          rows.channel.scope !== current.header.scope
        )
          throw new DocChannelNotFoundError();
        const scope: CurrentOperationScope = {
          authorization: this.#authorization,
          engine: this.#core,
          db: this.#db,
          store,
          tokenScope,
          tokenGrantPreparation: preparation,
          tokenGrantIds: current.data.grantIds,
          tokenManifestHash: current.header.manifestHash,
          documentId: current.header.documentId,
          scope: current.header.scope,
          write: true,
          birth: rows.birth,
          generation: rows.generation,
          physicalRow: copyCurrentDocData(rows.physical),
          channelRow: copyCurrentDocData(rows.channel),
          capturedFloor: rows.channel.receiptRetentionFloor,
          condition: { expectedGeneration: current.header.generation },
          absentAdmission: false,
          event,
          ingest,
          grants,
        };
        this.#currentEntry = true;
        this.#activeCurrent.add(tx);
        this.#scopes.set(tx, scope);
        try {
          this.#finalCurrent(store, tx);
          const retained = readDocEventRow(tx, scope.documentId, event.id);
          if (retained) {
            if (retained.envelopeHash !== envelopeIdentity(event).hash)
              throw new DocIngestRefusal('DOC_EVENT_ID_CONFLICT', 409);
            const deliveries = tx
              .select()
              .from(canvasDocDeliveries)
              .where(
                and(
                  eq(canvasDocDeliveries.documentId, scope.documentId),
                  eq(canvasDocDeliveries.eventId, event.id)
                )
              )
              .all();
            const response = copyCurrentDocData({
              receipt: { id: event.id, status: 'duplicate' as const, docSeq: retained.docSeq },
              deliveries: deliveries.map(publicCurrentDelivery),
            });
            this.#finalCurrent(store, tx);
            if (
              !sameCurrentDocData(retained, readDocEventRow(tx, scope.documentId, event.id)) ||
              !sameCurrentDocData(
                deliveries,
                tx
                  .select()
                  .from(canvasDocDeliveries)
                  .where(
                    and(
                      eq(canvasDocDeliveries.documentId, scope.documentId),
                      eq(canvasDocDeliveries.eventId, event.id)
                    )
                  )
                  .all()
              )
            )
              throw new DocChannelNotFoundError();
            return response;
          }
          scope.absentAdmission = true;
          scope.access = prepareCurrentDocGrantRoutes(grants, store, this.#authorization, tx);
          scope.now = withCheckboxReadOnlyGate(this.#db, () =>
            captureCurrentDocIngestClock(ingest, store, this.#authorization, tx)
          );
          this.#finalCurrent(store, tx);
          const hasRoom = scope.access.routes.some(
            (decision) =>
              !decision.reason &&
              decision.route.to === 'room:self' &&
              decision.route.turn.mode !== 'none'
          );
          if (hasRoom && !this.#room) throw new DocChannelNotFoundError();
          if (hasRoom) this.#room!.prepare(store, grants, tx);
          this.#finalCurrent(store, tx);
          const result = acceptCurrentDocEventInTransaction(ingest, store, this.#authorization, tx);
          scope.acceptedDocSeq = result.receipt.docSeq;
          const response = copyCurrentDocData({
            receipt: result.receipt,
            deliveries: result.deliveries.map(publicCurrentDelivery),
          });
          if (hasRoom) this.#room!.seal(store, tx, readOriginalDocIngestLimits(ingest, store));
          this.#finalCurrent(store, tx);
          auditCurrentDocIngestRows(ingest, store, this.#authorization, tx);
          auditCurrentDocGrantRows(grants, store, this.#authorization, tx);
          if (hasRoom) {
            this.#room!.audit(store, grants, tx);
            committedTx = tx;
            committedAt = scope.now;
          }
          return response;
        } catch (cause) {
          this.#room?.abandoned(tx);
          if (!scope.failure) scope.failure = { cause };
          throw scope.failure.cause;
        } finally {
          this.#retireCurrent(tx);
        }
      });
      if (committedTx) this.#room!.committed(committedTx, committedAt!);
      return response;
    } catch (cause) {
      if (committedTx) this.#room?.abandoned(committedTx);
      throw cause;
    }
  }
  async #revokeToken(
    store: DocChannelStore,
    grants: DocChannelGrants,
    rawActor: DocChannelActor,
    documentId: string,
    tokenId: string
  ) {
    const actor = captureCurrentHttpDocActor(rawActor);
    if (
      actor.principal.claims.kind !== 'operator' ||
      typeof documentId !== 'string' ||
      !documentId ||
      documentId.length > 200
    )
      throw new DocChannelNotFoundError();
    requireCurrentDocConstructorEngines(this.#authorization, store, undefined, grants);
    this.#retainTokenManifestOwner(grants, store);
    const captured = await this.#captureDocument(store, grants, documentId, actor, []);
    const source = this.#readDocumentAuthority(store, grants, captured.authority);
    const tokenStore = this.#originalTokenStore();
    const before = readOriginalDocTokenRevocationData(tokenStore, this.#db, tokenId);
    if (!before || before.documentId !== documentId) throw new DocChannelNotFoundError();
    const revokedAt =
      before.revokedAt ??
      Reflect.apply(
        maintenanceIso,
        new MaintenanceDate(Reflect.apply(maintenanceNow, MaintenanceDate, [])),
        []
      );
    return documentTransaction(this.#db, (tx) => {
      this.#beginCurrent(
        store,
        tx,
        documentId,
        source.actor,
        false,
        { expectedGeneration: source.data.generation },
        captured.authority
      );
      try {
        this.#finalCurrent(store, tx);
        const current = readOriginalDocTokenRevocationData(tokenStore, this.#db, tokenId);
        if (!sameOriginalDocTokenData(current, before)) throw new DocChannelNotFoundError();
        if (before.revokedAt === null) {
          const stage = Object.freeze({ kind: 'original-doc-token-revocation-stage' as const });
          const own = {
            db: this.#db,
            store: tokenStore,
            tx,
            active: true,
            consumed: false,
            data: Object.freeze({ ...before, revokedAt }),
            requireCurrent: () => {
              if (this.#roomPumpStopped) throw new DocChannelNotFoundError();
              this.#finalCurrent(store, tx);
              if (
                !sameOriginalDocTokenData(
                  readOriginalDocTokenRevocationData(tokenStore, this.#db, tokenId),
                  before
                )
              )
                throw new DocChannelNotFoundError();
            },
          };
          originalTokenRevocations.set(stage, own);
          try {
            writeOriginalDocTokenRevocationInsideCurrent(stage, tokenStore, this.#db, tx);
          } finally {
            own.active = false;
          }
        }
        this.#finalCurrent(store, tx);
        const after = readOriginalDocTokenRevocationData(tokenStore, this.#db, tokenId);
        if (!sameOriginalDocTokenData(after, { ...before, revokedAt }))
          throw new DocChannelNotFoundError();
        return Object.freeze({ tokenId, revokedAt });
      } finally {
        this.#retireCurrent(tx);
      }
    });
  }
  async #prepareTokenIssuance(
    store: DocChannelStore,
    grants: DocChannelGrants,
    rawActor: DocChannelActor,
    rawRequest: unknown,
    grantIds: readonly string[]
  ) {
    const actor = captureCurrentHttpDocActor(rawActor);
    if (actor.principal.claims.kind !== 'operator') throw new DocChannelNotFoundError();
    const request = CanvasChannelTokenRequestSchema.parse(rawRequest);
    requireCurrentDocConstructorEngines(this.#authorization, store, undefined, grants);
    // Retain the actual constructor-owned manifest FD witness before the first dependency/manifest read.
    this.#retainTokenManifestOwner(grants, store);
    const fileSourceReader = (this.#tokenFileSourceReader ??=
      createOriginalDocTokenFileSourceReader(this.#db, this.#fixedPorts.originalRoomRepoStore));
    const fileSource = fileSourceReader.observe(request.documentId);
    const captured = await this.#captureDocument(
      store,
      grants,
      request.documentId,
      actor,
      grantIds,
      undefined,
      fileSource
    );
    const own = this.#readDocumentAuthority(store, grants, captured.authority);
    const tokenStore = this.#originalTokenStore();
    const readNativeFacts = (this.#readTokenNativeFacts ??= createOriginalDocTokenNativeFactsReader(
      this.#db
    ));
    const nativeFacts = readNativeFacts(request.documentId);
    if (
      nativeFacts.physical.id !== captured.birth.physicalId ||
      nativeFacts.physical.opened_at !== captured.birth.openedAt ||
      nativeFacts.channel.document_id !== captured.birth.documentId ||
      nativeFacts.channel.created_at !== captured.birth.createdAt ||
      nativeFacts.channel.closed_at !== null
    )
      throw new DocChannelNotFoundError();
    const baseline = own.baseline as {
      channel: Record<string, unknown>;
      dependencies: { manifestHash: unknown; grants: unknown };
    };
    const claims = actor.principal.claims;
    const owner = claims.owner;
    if (owner.kind === 'user' ? nativeFacts.owner?.id !== owner.userId : nativeFacts.owner !== null)
      throw new DocChannelNotFoundError();
    const createdAt = Reflect.apply(
      maintenanceIso,
      new MaintenanceDate(Reflect.apply(maintenanceNow, MaintenanceDate, [])),
      []
    );
    if (
      Reflect.apply(maintenanceParse, MaintenanceDate, [request.expiresAt]) <=
        Reflect.apply(maintenanceParse, MaintenanceDate, [createdAt]) ||
      typeof baseline.channel.declarationHash !== 'string' ||
      (baseline.dependencies.manifestHash !== null &&
        typeof baseline.dependencies.manifestHash !== 'string')
    )
      throw new DocChannelNotFoundError();
    const token = 'dct_' + randomBytes(32).toString('base64url');
    const record = Object.freeze({
      tokenId: randomUUID(),
      tokenHash: createHash('sha256').update(token).digest('hex'),
      documentId: request.documentId,
      allowedTypes: Object.freeze([...request.allowedTypes]),
      directions: Object.freeze([...request.directions]),
      permissions: Object.freeze([...request.permissions]),
      creatorId: owner.kind === 'user' ? owner.userId : owner.installationId,
      createdAt,
      expiresAt: request.expiresAt,
      revokedAt: null,
    });
    const boundedJson = (value: unknown, limit: number) => {
      const encode = (item: unknown, depth: number): string => {
        if (depth > 32) throw new DocChannelNotFoundError();
        if (item === null) return 'null';
        if (
          typeof item === 'string' ||
          typeof item === 'boolean' ||
          (typeof item === 'number' && Number.isFinite(item))
        )
          return Reflect.apply(tokenScalarJson, JSON, [item]);
        if (!item || typeof item !== 'object') throw new DocChannelNotFoundError();
        let text = Array.isArray(item) ? '[' : '{';
        const keys = Array.isArray(item)
          ? Array.from({ length: tokenOwnDescriptor(item, 'length')!.value }, (_, index) =>
              String(index)
            )
          : tokenOwnKeys(item);
        for (let index = 0; index < keys.length; index++) {
          const key = keys[index]!,
            field = tokenOwnDescriptor(item, key);
          if (!field || !('value' in field)) throw new DocChannelNotFoundError();
          text +=
            (index ? ',' : '') +
            (Array.isArray(item) ? '' : Reflect.apply(tokenScalarJson, JSON, [key]) + ':') +
            encode(field.value, depth + 1);
          if (Reflect.apply(tokenUtf8Bytes, Buffer, [text]) > limit)
            throw new DocChannelNotFoundError();
        }
        return text + (Array.isArray(item) ? ']' : '}');
      };
      const json = encode(value, 0);
      if (Reflect.apply(tokenUtf8Bytes, Buffer, [json]) > limit)
        throw new DocChannelNotFoundError();
      return json;
    };
    const data: OriginalStoredDocTokenData = Object.freeze({
      record,
      binding: Object.freeze({
        version: 1,
        scope: captured.scope,
        generation: captured.generation,
        birthJson: boundedJson(captured.birth, 4096),
        incarnationJson: boundedJson(own.baseline, 262144),
        declarationHash: baseline.channel.declarationHash,
        manifestHash: baseline.dependencies.manifestHash,
        approvedGrantsJson: boundedJson(baseline.dependencies.grants, 262144),
        issuerJson: boundedJson(
          {
            kind: 'original-native-doc-token-issuer-v1',
            owner: copyCurrentDocData(owner),
            grantIds: [...own.grantIds],
            nativeFacts,
            fileSource,
          },
          262144
        ),
      }),
    });
    const stage = Object.freeze({ kind: 'original-doc-token-issuance-stage' as const });
    this.#tokenStages.set(stage, {
      store,
      grants,
      authority: captured.authority,
      state: 'prepared',
      fileSource,
    });
    originalTokenIssues.set(stage, {
      db: this.#db,
      tokenStore,
      consumed: false,
      data,
      unsignedData: data,
      requireCurrent: () => {
        requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
        if (this.#roomPumpStopped) throw new DocChannelNotFoundError();
        const active = originalTokenIssues.get(stage)?.activeTx;
        if (!active) throw new DocChannelNotFoundError();
        if (
          Reflect.apply(maintenanceParse, MaintenanceDate, [record.expiresAt]) <=
          Reflect.apply(maintenanceNow, MaintenanceDate, [])
        )
          throw new DocChannelNotFoundError();
        this.#finalCurrent(store, active);
        if (
          !sameOriginalDocTokenData(
            fileSource.policies,
            fileSourceReader.policies(request.documentId)
          )
        )
          throw new DocChannelNotFoundError();
        if (!sameOriginalDocTokenData(nativeFacts, readNativeFacts(request.documentId)))
          throw new DocChannelNotFoundError();
      },
    });
    return Object.freeze({ stage, token, record });
  }
  async #commitTokenIssuance(
    stage: import('./current-operation-types.js').OriginalDocTokenIssuanceStage
  ) {
    const own = this.#tokenStages.get(stage),
      issue = originalTokenIssues.get(stage);
    if (!own || !issue || own.state !== 'prepared' || issue.db !== this.#db)
      throw new DocChannelNotFoundError();
    own.state = 'committing';
    try {
      if (!this.#tokenFileSourceReader) throw new DocChannelNotFoundError();
      await this.#captureDocument(
        own.store,
        own.grants,
        issue.data.record.documentId,
        this.#readDocumentAuthority(own.store, own.grants, own.authority).actor,
        this.#readDocumentAuthority(own.store, own.grants, own.authority).grantIds,
        own.authority,
        this.#tokenFileSourceReader.observe(issue.data.record.documentId)
      );
      this.#originalTokenStore();
      if (
        !this.#tokenFileSourceReader ||
        !sameOriginalDocTokenData(
          own.fileSource,
          this.#tokenFileSourceReader.observe(issue.data.record.documentId)
        )
      )
        throw new DocChannelNotFoundError();
      documentTransaction(this.#db, (tx) => {
        const source = this.#readDocumentAuthority(own.store, own.grants, own.authority);
        this.#beginCurrent(
          own.store,
          tx,
          source.documentId,
          source.actor,
          false,
          { expectedGeneration: source.data.generation },
          own.authority
        );
        issue.activeTx = tx;
        try {
          if (
            Reflect.apply(maintenanceParse, MaintenanceDate, [issue.data.record.expiresAt]) <=
            Reflect.apply(maintenanceNow, MaintenanceDate, [])
          )
            throw new DocChannelNotFoundError();
          this.#finalCurrent(own.store, tx);
          const authenticatedIssuerJson = authenticateOriginalDocTokenIssuance(stage, this.#db, tx);
          issue.data = Object.freeze({
            record: issue.unsignedData.record,
            binding: Object.freeze({
              ...issue.unsignedData.binding,
              issuerJson: authenticatedIssuerJson,
            }),
          });
          writeOriginalDocTokenIssuanceInsideCurrent(stage, issue.tokenStore, this.#db, tx);
          this.#finalCurrent(own.store, tx);
          const retained = readOriginalNativeDocTokenHeaderByHash(
            issue.tokenStore,
            this.#db,
            issue.data.record.tokenHash
          );
          if (!retained) throw new DocChannelNotFoundError();
          const payload = verifyOriginalDocTokenNativeCapsule(this.#db, retained);
          if (
            payload !== issue.unsignedData.binding.issuerJson ||
            encodeOriginalDocTokenHeaderAuthentication(retained, payload) !==
              encodeOriginalDocTokenIssuanceAuthentication(issue.unsignedData)
          )
            throw new DocChannelNotFoundError();
          issue.requireCurrent();
        } finally {
          issue.activeTx = undefined;
          this.#retireCurrent(tx);
        }
      });
    } catch (cause) {
      if (
        (!this.#db.$client.open || this.#db.$client.inTransaction) &&
        !this.#tokenNativeCloseFailure
      )
        this.#tokenNativeCloseFailure = { cause };
      throw cause;
    } finally {
      own.state = 'retired';
      issue.activeTx = undefined;
    }
  }
  #queuePresence<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#presenceTail;
    const pending = this.#trackTokenOperation(async () => {
      await prior;
      if (this.#roomPumpStopped) throw new DocChannelNotFoundError();
      return operation();
    });
    this.#presenceTail = pending.then(
      () => {},
      () => {}
    );
    return pending;
  }
  async #updatePresence(
    store: DocChannelStore,
    documentId: string,
    actor: DocChannelActor,
    request?: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelPresenceRequest,
    retiredCallers: ReadonlySet<string> = new Set()
  ) {
    const failure = this.#presenceFailures.get(documentId);
    if (failure) throw failure.cause;
    requireCurrentDocConstructorEngines(this.#authorization, store);
    await this.#preflightCurrent(documentId, actor, false);
    if (this.#roomPumpStopped || this.#db.$client.inTransaction || this.#currentEntry)
      throw new DocChannelNotFoundError();
    const now = this.#presenceNow();
    let plan: PresencePlan | undefined;
    let context:
      | {
          store: DocChannelStore;
          actor: DocChannelActor;
          birth: CurrentOperationScope['birth'];
          scope: string;
          callers: Map<string, DocChannelActor>;
        }
      | undefined;
    documentTransaction(this.#db, (tx) => {
      const scope = this.#beginCurrent(
        store,
        tx,
        documentId,
        actor,
        false,
        'server-initial-replay'
      );
      try {
        const before = this.#presenceDocuments.get(documentId);
        if (before && (before.store !== store || !sameCurrentDocData(before.birth, scope.birth)))
          throw new DocChannelNotFoundError();
        if (request) {
          const caller = createHash('sha256')
            .update(JSON.stringify(actor.principal.claims))
            .digest('hex');
          plan = this.#presenceLedger.prepare(documentId, caller, request, now);
        } else plan = this.#presenceLedger.expire(documentId, now, retiredCallers);
        context = {
          store,
          actor,
          birth: copyCurrentDocData(scope.birth),
          scope: scope.scope,
          callers: new Map(before?.callers),
        };
        if (request)
          context.callers.set(
            createHash('sha256').update(JSON.stringify(actor.principal.claims)).digest('hex'),
            actor
          );
        const transitions: {
          type: string;
          payload: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelJsonValue;
        }[] = [];
        if (plan?.closed)
          transitions.push({ type: 'host.closed', payload: { mounts: plan.closed } });
        if (plan?.opened) transitions.push({ type: 'host.opened', payload: { mounts: 1 } });
        if (plan?.countChanged)
          transitions.push({ type: 'doc.viewers', payload: { views: plan.views } });

        for (const transition of transitions) {
          scope.event = copyCurrentDocData(
            StoredPageEventSchema.parse({ v: 1, id: randomUUID(), ...transition })
          );
          scope.now = new Date(now).toISOString();
          const identity = envelopeIdentity(scope.event);
          originalPresenceAppends.set(tx, {
            authorization: this.#authorization,
            store,
            input: {
              documentId,
              eventId: scope.event.id,
              direction: 'system',
              type: scope.event.type,
              payload: scope.event.payload,
              envelopeHash: identity.hash,
              envelopeBytes: identity.bytes,
              provenance: { source: 'doc-channel-presence' },
              receivedAt: scope.now,
            },
          });
          if (this.#roomPumpStopped) throw new DocChannelNotFoundError();
          this.#finalCurrent(store, tx);
          appendOriginalDocPresenceEvent(store, this.#authorization, tx);
        }
        if (transitions.length) auditCurrentDocAppendIntentions(store, this.#authorization, tx);
        if (this.#roomPumpStopped) throw new DocChannelNotFoundError();
        this.#finalCurrent(store, tx);
      } catch (cause) {
        if (!scope.failure) scope.failure = { cause };
        throw scope.failure.cause;
      } finally {
        originalPresenceAppends.delete(tx);
        this.#retireCurrent(tx);
      }
    });
    if (plan) {
      this.#presenceLedger.commit(plan);
      if (plan.views && context) {
        for (const caller of context.callers.keys())
          if (!this.#presenceLedger.hasCaller(documentId, caller)) context.callers.delete(caller);
        this.#presenceDocuments.set(documentId, context);
      } else this.#presenceDocuments.delete(documentId);
    }
    this.#schedulePresence();
    if (!request || !plan) return;
    return CanvasChannelPresenceResponseSchema.parse({
      viewerId: plan.viewerId,
      views: plan.views,
      heartbeatMs: 30_000,
      ttlMs: 75_000,
    });
  }
  async #focusPresence(
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    documentId: string,
    actor: DocChannelActor,
    request: Extract<
      import('@dorkos/shared/canvas-channel-schemas').CanvasChannelPresenceRequest,
      { action: 'focus' }
    >
  ) {
    const failure = this.#presenceFailures.get(documentId);
    if (failure) throw failure.cause;
    requireCurrentDocConstructorEngines(this.#authorization, store, ingest, grants);
    await this.#preflightCurrent(documentId, actor, false);
    const caller = createHash('sha256')
      .update(JSON.stringify(actor.principal.claims))
      .digest('hex');
    const plan = this.#presenceLedger.prepare(documentId, caller, request, this.#presenceNow());
    if (plan.focused !== undefined) {
      const reader = (this.#tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
        this.#db,
        this.#fixedPorts.originalRoomRepoStore
      ));
      const fileSource = reader.observe(documentId);
      const event = copyCurrentDocData(
        StoredPageEventSchema.parse({
          v: 1,
          id: randomUUID(),
          type: 'host.focus',
          payload: { focused: plan.focused },
        })
      );
      const current = await this.#captureDocument(
        store,
        grants,
        documentId,
        actor,
        [],
        undefined,
        fileSource,
        event
      );
      const stage = Object.freeze({ kind: 'original-mounted-host-focus' });
      this.#presenceFocusStages.set(stage, {
        store,
        ingest,
        grants,
        actor,
        plan,
        caller,
        event,
        fileSource,
      });
      try {
        // The original ingress applies only explicit currently approved matching routes.
        // A declaration/reserved name alone does not grant a focus turn.
        await this.#submitCurrent(
          store,
          ingest,
          grants,
          documentId,
          event,
          actor,
          { expectedGeneration: current.generation },
          current.authority,
          undefined,
          undefined,
          stage
        );
      } finally {
        this.#presenceFocusStages.delete(stage);
      }
    } else this.#presenceLedger.commit(plan);
    return CanvasChannelPresenceResponseSchema.parse({
      viewerId: plan.viewerId,
      views: plan.views,
      heartbeatMs: 30_000,
      ttlMs: 75_000,
    });
  }
  #requirePresenceFocusPreflight(stage: object, store: DocChannelStore): void {
    const own = this.#presenceFocusStages.get(stage);
    if (
      !own ||
      own.store !== store ||
      this.#roomPumpStopped ||
      this.#currentEntry ||
      this.#db.$client.inTransaction ||
      !this.#tokenFileSourceReader
    )
      throw new DocChannelNotFoundError();
    this.#presenceLedger.requireFocus(own.plan, own.caller, this.#presenceNow());
    if (
      !sameOriginalDocTokenData(
        own.fileSource,
        this.#tokenFileSourceReader.observe(own.plan.documentId)
      )
    )
      throw new DocChannelNotFoundError();
  }
  #requirePresenceFocus(stage: object, store: DocChannelStore): void {
    const own = this.#presenceFocusStages.get(stage);
    if (!own || own.store !== store || this.#roomPumpStopped) throw new DocChannelNotFoundError();
    this.#presenceLedger.requireFocus(own.plan, own.caller, this.#presenceNow());
    if (
      !this.#currentEntry ||
      !this.#db.$client.inTransaction ||
      !this.#tokenFileSourceReader ||
      !sameOriginalDocTokenData(
        own.fileSource,
        this.#tokenFileSourceReader.observeCurrentTransaction(own.plan.documentId)
      )
    )
      throw new DocChannelNotFoundError();
  }
  #retireKnownPresence(
    documentId: string
  ): Readonly<{ retired: boolean; callers: ReadonlySet<string> }> {
    const own = this.#presenceDocuments.get(documentId);
    if (!own) throw new Error('Original presence lifecycle context missing');
    requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
    requireDocChannelStoreDatabase(own.store, this.#db);
    requireServerNativeDatabaseQueryCustody(this.#db);
    const retirement = withCheckboxReadOnlyGate(this.#db, () => {
      const row = this.#nativePrepare(
        'SELECT channel.document_id,channel.scope,channel.created_at,channel.closed_at,channel.closure_evidence,physical.opened_at AS physical_opened_at,physical.scope AS physical_scope FROM canvas_doc_channels AS channel LEFT JOIN canvas_documents AS physical ON physical.id=channel.document_id WHERE channel.document_id=?'
      ).get(documentId);
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        !('document_id' in row) ||
        typeof row.document_id !== 'string' ||
        !('scope' in row) ||
        typeof row.scope !== 'string' ||
        !('created_at' in row) ||
        typeof row.created_at !== 'string' ||
        !('closed_at' in row) ||
        (row.closed_at !== null && typeof row.closed_at !== 'string') ||
        !('closure_evidence' in row) ||
        (row.closure_evidence !== null && typeof row.closure_evidence !== 'string') ||
        !('physical_opened_at' in row) ||
        (row.physical_opened_at !== null && typeof row.physical_opened_at !== 'string') ||
        !('physical_scope' in row) ||
        (row.physical_scope !== null && typeof row.physical_scope !== 'string')
      )
        throw new Error('Original presence lifecycle row incomplete');
      if (row.document_id !== own.birth.documentId || row.created_at !== own.birth.createdAt)
        throw new Error('Original presence lifecycle birth changed');
      if (row.physical_opened_at !== null && row.physical_opened_at !== own.birth.openedAt)
        throw new Error('Original presence physical birth changed');
      if (row.closed_at !== null) {
        if (!Number.isFinite(Date.parse(row.closed_at)) || row.closure_evidence === null)
          throw new Error('Original presence closure evidence incomplete');
        const evidence: unknown = JSON.parse(row.closure_evidence);
        if (
          !evidence ||
          typeof evidence !== 'object' ||
          Array.isArray(evidence) ||
          Object.keys(evidence).length !== 2 ||
          !('reason' in evidence) ||
          evidence.reason !== 'removed' ||
          !('scope' in evidence) ||
          evidence.scope !== row.scope
        )
          throw new Error('Original presence closure differs');
        // Actual original lifecycle.close retained this tombstone before physical deletion.
        // A closed document has no authorized live recipient; never append after closure.
        this.#presenceLedger.retire(documentId);
        this.#presenceDocuments.delete(documentId);
        return { retired: true, callers: [] };
      }
      if (row.physical_opened_at === null || row.physical_scope !== row.scope)
        throw new Error('Original live presence source incomplete');
      const retiredCallers: string[] = [];
      for (const [caller, actor] of own.callers) {
        const claims = actor.principal.claims;
        const principal = checkboxAuthoritySync(this.#fixedPorts.principalCurrent(actor.principal));
        if (principal !== true && principal !== false)
          throw new Error('Original presence principal state unknown');
        const installation = principal
          ? checkboxAuthoritySync(this.#fixedPorts.ownsInstallation(claims))
          : false;
        if (installation !== true && installation !== false)
          throw new Error('Original presence installation state unknown');
        let membershipMissing = false;
        if (principal && installation && row.scope.startsWith('room:')) {
          const key =
            claims.kind === 'operator'
              ? claims.owner.kind === 'user'
                ? 'user:' + claims.owner.userId
                : 'local'
              : claims.kind === 'agent' || claims.kind === 'runtime'
                ? claims.agentPath
                : undefined;
          if (key === undefined) throw new Error('Original presence member identity unknown');
          const kind = claims.kind === 'operator' ? 'human' : 'agent';
          const members = this.#nativePrepare(
            'SELECT a.id,a.minted_for_manifest_id FROM authors a JOIN room_members m ON m.author_id=a.id WHERE a.kind=? AND a.natural_key=? AND a.retired_at IS NULL AND m.room_id=? LIMIT 2'
          ).all(kind, key, row.scope.slice(5));
          if (members.length > 1) throw new Error('Original presence member identity ambiguous');
          if (!members.length) membershipMissing = true;
          else {
            const member = members[0];
            if (
              !member ||
              typeof member !== 'object' ||
              !('id' in member) ||
              typeof member.id !== 'string' ||
              !('minted_for_manifest_id' in member)
            )
              throw new Error('Original presence membership row incomplete');
            if (
              (claims.kind === 'agent' || claims.kind === 'runtime') &&
              member.minted_for_manifest_id !== claims.agentId
            )
              throw new Error('Original presence manifest membership differs');
          }
        }
        if (principal === false || installation === false || membershipMissing) {
          // These are positive original authority retirement results, never caught errors.
          retiredCallers.push(caller);
        }
      }
      const surviving = [...own.callers].find(([caller]) => !retiredCallers.includes(caller));
      if (surviving) own.actor = surviving[1];
      // Keep the original ledger until the surviving caller's native transaction commits
      // host.closed and the changed viewer count; SQL failure cannot lose that transition.
      return { retired: false, callers: retiredCallers };
    });
    // The native read-only gate admits plain DATA only, never Set instances.
    return { retired: retirement.retired, callers: new Set(retirement.callers) };
  }
  #expirePresenceNative(
    documentId: string,
    own: {
      store: DocChannelStore;
      actor: DocChannelActor;
      birth: CurrentOperationScope['birth'];
      scope: string;
      callers: Map<string, DocChannelActor>;
    },
    retiredCallers: ReadonlySet<string>
  ): void {
    if (
      this.#roomPumpStopped ||
      this.#presenceDocuments.get(documentId) !== own ||
      this.#db.$client.inTransaction ||
      this.#currentEntry
    )
      throw new Error('Original presence expiry owner changed');
    requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
    requireDocChannelStoreDatabase(own.store, this.#db);
    requireServerNativeDatabaseQueryCustody(this.#db);
    const now = this.#presenceNow();
    const plan = this.#presenceLedger.expire(documentId, now, retiredCallers);
    if (!plan) {
      this.#schedulePresence();
      return;
    }
    this.#presenceLedger.requireExpiry(plan);
    // This constructor's own timer/ledger produces only quiet system lifecycle rows.
    // It never reuses a retired request actor, selects routes, or enters ingestion.
    this.#currentEntry = true;
    try {
      documentTransaction(this.#db, () => {
        const physical = this.#nativePrepare('SELECT * FROM canvas_documents WHERE id=?').get(
          documentId
        );
        const channel = this.#nativePrepare(
          'SELECT * FROM canvas_doc_channels WHERE document_id=?'
        ).get(documentId);
        if (
          !physical ||
          typeof physical !== 'object' ||
          !('id' in physical) ||
          physical.id !== own.birth.physicalId ||
          !('opened_at' in physical) ||
          physical.opened_at !== own.birth.openedAt ||
          !('scope' in physical) ||
          typeof physical.scope !== 'string' ||
          !channel ||
          typeof channel !== 'object' ||
          !('document_id' in channel) ||
          channel.document_id !== own.birth.documentId ||
          !('created_at' in channel) ||
          channel.created_at !== own.birth.createdAt ||
          !('scope' in channel) ||
          channel.scope !== physical.scope ||
          !('closed_at' in channel) ||
          channel.closed_at !== null ||
          !('next_doc_seq' in channel) ||
          typeof channel.next_doc_seq !== 'number' ||
          !Number.isSafeInteger(channel.next_doc_seq) ||
          channel.next_doc_seq < 1
        )
          throw new Error('Original live presence expiry source differs');
        const source = copyCurrentDocData(physical),
          beforeChannel = copyCurrentDocData(channel);
        const nextSequence = channel.next_doc_seq;
        const fingerprint = (query: string, ...params: (string | number)[]) => {
          const hash = createHash('sha256');
          let count = 0;
          // Each complete row is bounded individually; a retained history does not
          // become an accidental whole-log JSON byte limit on quiet expiry.
          for (const row of this.#nativePrepare(query).iterate(...params)) {
            hash.update(JSON.stringify(copyCurrentDocData(row))).update('\n');
            count++;
          }
          return count + ':' + hash.digest('hex');
        };
        const oldEventsQuery =
          'SELECT * FROM canvas_doc_events WHERE document_id=? AND doc_seq<? ORDER BY doc_seq';
        const batchesQuery =
          'SELECT * FROM canvas_doc_batches WHERE document_id=? ORDER BY batch_id';
        const deliveriesQuery =
          'SELECT * FROM canvas_doc_deliveries WHERE document_id=? ORDER BY event_id,route_id';
        const events = fingerprint(oldEventsQuery, documentId, nextSequence);
        const batches = fingerprint(batchesQuery, documentId);
        const deliveries = fingerprint(deliveriesQuery, documentId);
        const transitions = [
          { type: 'host.closed', payload: { mounts: plan.closed } },
          ...(plan.countChanged ? [{ type: 'doc.viewers', payload: { views: plan.views } }] : []),
        ];
        const receivedAt = new Date(now).toISOString();
        const intended = transitions.map((transition, index) => {
          const event = StoredPageEventSchema.parse({ v: 1, id: randomUUID(), ...transition });
          const identity = envelopeIdentity(event);
          return {
            document_id: documentId,
            event_id: event.id,
            doc_seq: nextSequence + index,
            direction: 'system',
            type: event.type,
            payload: JSON.stringify(event.payload),
            envelope_hash: identity.hash,
            envelope_bytes: identity.bytes,
            payload_pruned_at: null,
            coalesce_key: null,
            client_ts: null,
            received_at: receivedAt,
            provenance: JSON.stringify({ source: 'doc-channel-presence' }),
          };
        });
        this.#presenceLedger.requireExpiry(plan);
        if (this.#roomPumpStopped)
          throw new Error('Original presence expiry retired before effect');
        const changed = this.#nativePrepare(
          'UPDATE canvas_doc_channels SET next_doc_seq=?,updated_at=? WHERE document_id=? AND next_doc_seq=? AND closed_at IS NULL'
        ).run(nextSequence + intended.length, receivedAt, documentId, nextSequence).changes;
        if (changed !== 1) throw new Error('Original presence expiry sequence raced');
        for (const row of intended)
          this.#nativePrepare(
            'INSERT INTO canvas_doc_events (document_id,event_id,doc_seq,direction,type,payload,envelope_hash,envelope_bytes,payload_pruned_at,coalesce_key,client_ts,received_at,provenance) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
          ).run(
            row.document_id,
            row.event_id,
            row.doc_seq,
            row.direction,
            row.type,
            row.payload,
            row.envelope_hash,
            row.envelope_bytes,
            row.payload_pruned_at,
            row.coalesce_key,
            row.client_ts,
            row.received_at,
            row.provenance
          );
        this.#presenceLedger.requireExpiry(plan);
        if (
          this.#roomPumpStopped ||
          this.#presenceDocuments.get(documentId) !== own ||
          !sameCurrentDocData(
            source,
            this.#nativePrepare('SELECT * FROM canvas_documents WHERE id=?').get(documentId)
          ) ||
          !sameCurrentDocData(
            {
              ...beforeChannel,
              next_doc_seq: nextSequence + intended.length,
              updated_at: receivedAt,
            },
            this.#nativePrepare('SELECT * FROM canvas_doc_channels WHERE document_id=?').get(
              documentId
            )
          ) ||
          events !== fingerprint(oldEventsQuery, documentId, nextSequence) ||
          !sameCurrentDocData(
            intended,
            this.#nativePrepare(
              'SELECT * FROM canvas_doc_events WHERE document_id=? AND doc_seq>=? ORDER BY doc_seq'
            ).all(documentId, nextSequence)
          ) ||
          batches !== fingerprint(batchesQuery, documentId) ||
          deliveries !== fingerprint(deliveriesQuery, documentId)
        )
          throw new Error('Original presence expiry native rows changed');
        for (const row of intended)
          queueCommittedDocEvent(this.#db, {
            documentId,
            eventId: row.event_id,
            docSeq: row.doc_seq,
            direction: 'system',
            type: row.type,
            envelopeHash: row.envelope_hash,
            receivedAt,
          });
      });
      this.#presenceLedger.commit(plan);
      if (plan.views) {
        for (const caller of own.callers.keys())
          if (!this.#presenceLedger.hasCaller(documentId, caller)) own.callers.delete(caller);
      } else this.#presenceDocuments.delete(documentId);
    } finally {
      this.#currentEntry = false;
    }
    this.#schedulePresence();
  }
  #schedulePresence(): void {
    if (this.#presenceTimer !== undefined) {
      this.#presenceClearTimeout(this.#presenceTimer);
      this.#presenceTimer = undefined;
    }
    if (this.#roomPumpStopped) return;
    const next = this.#presenceLedger.next(new Set(this.#presenceFailures.keys()));
    if (!next) return;
    this.#presenceTimer = this.#presenceSetTimeout(
      () => {
        this.#presenceTimer = undefined;
        if (this.#roomPumpStopped) return;
        const work = this.#queuePresence(async () => {
          // Prior queued work may have positively removed the final mount or replaced
          // its surviving caller. Read only after that original operation has settled.
          const own = this.#presenceDocuments.get(next.documentId);
          if (!own) {
            if (this.#presenceLedger.hasDocument(next.documentId))
              throw new Error('Original presence expiry context is unavailable.');
            this.#schedulePresence();
            return;
          }
          const retirement = this.#retireKnownPresence(next.documentId);
          if (retirement.retired) {
            this.#schedulePresence();
            return;
          }
          return this.#expirePresenceNative(next.documentId, own, retirement.callers);
        });
        void work.catch((cause) => {
          if (!this.#presenceFailure) this.#presenceFailure = { cause };
          if (!this.#presenceFailures.has(next.documentId))
            this.#presenceFailures.set(next.documentId, { cause });
          this.#schedulePresence();
        });
      },
      Math.max(0, next.at - this.#presenceNow())
    );
  }
  #stopRoomPump(): Promise<void> {
    if (this.#roomStop) return this.#roomStop;
    // Own the memo before configured construction callbacks can enter this method.
    this.#roomStop = new Promise<void>((resolve, reject) => {
      this.#resolveRoomStop = resolve;
      this.#rejectRoomStop = reject;
    });
    void this.#roomStop.catch(() => {}); // Original returned promise retains its failure.
    this.#roomPumpStopped = true;
    try {
      if (this.#presenceTimer !== undefined) this.#presenceClearTimeout(this.#presenceTimer);
      this.#presenceTimer = undefined;
    } catch (cause) {
      if (!this.#presenceFailure) this.#presenceFailure = { cause };
    }
    for (const state of this.#liveTokenStreams) this.#retireTokenStream(state);
    if (this.#roomConstruction !== 'constructing') this.#finishRoomStop();
    return this.#roomStop;
  }
  #finishRoomStop(): void {
    if (!this.#roomStop || this.#roomStopStarted) return;
    this.#roomStopStarted = true;
    void Promise.allSettled([...this.#activeTokenOperations]).then(() => {
      this.#presenceLedger.stop();
      this.#presenceDocuments.clear();
      for (let index = 0; index < this.#tokenManifestOwners.length; index++) {
        const { grants, store } = this.#tokenManifestOwners[index]!;
        try {
          requireOriginalTokenDocumentManifestClosed(grants, store, this.#db);
        } catch (cause) {
          if (!this.#tokenNativeCloseFailure) this.#tokenNativeCloseFailure = { cause };
        }
      }
      try {
        this.#tokenFileSourceReader?.requireClosed();
        this.#editorSelectionReader.requireClosed();
      } catch (cause) {
        if (!this.#tokenNativeCloseFailure) this.#tokenNativeCloseFailure = { cause };
      }
      const failure =
        this.#roomConstructionFailure ?? this.#tokenNativeCloseFailure ?? this.#presenceFailure;
      const settle = () => {
        if (failure) this.#rejectRoomStop!(failure.cause);
        else this.#resolveRoomStop!();
      };
      // A token FD UNKNOWN retains its cause/Db, but never skips retirement of the independent original Room peer.
      try {
        const closing = this.#room?.stopPump();
        if (closing)
          void closing.then(
            () => {
              this.#tokenRoomPeerClosed = true;
              settle();
            },
            (cause) => {
              this.#rejectRoomStop!(failure ? failure.cause : cause);
            }
          );
        else {
          this.#tokenRoomPeerClosed = this.#roomConstructionFailure === undefined;
          settle();
        }
      } catch (cause) {
        this.#rejectRoomStop!(failure ? failure.cause : cause);
      }
    });
  }
  #ensureRoom(): CurrentRoomOperation | undefined {
    if (this.#roomConstructionFailure) throw this.#roomConstructionFailure.cause;
    if (this.#roomConstruction === 'constructing')
      throw new Error('Original Room construction is already in progress.');
    if (this.#roomPumpStopped) return undefined;
    const ports = this.#fixedPorts;
    if (!this.#room && ports.roomConstruction) {
      if (!ports.nativeRuntimePrincipals || !ports.originalRoomStore)
        throw new Error('Room construction requires its genuine principal service and Store.');
      this.#roomConstruction = 'constructing';
      try {
        const room = new CurrentRoomOperation(
          this.#authorization,
          this.#core,
          this.#db,
          ports.nativeRuntimePrincipals,
          ports.originalRoomStore,
          ports.roomConstruction
        );
        this.#room = room;
        this.#roomConstruction = 'ready';
        // Accepted-source callbacks may have retired scheduling while this exact constructor ran.
        if (this.#roomPumpStopped) {
          this.#finishRoomStop();
          return undefined;
        }
      } catch (cause) {
        this.#roomConstruction = 'failed';
        this.#roomConstructionFailure = { cause };
        if (this.#roomPumpStopped) this.#finishRoomStop();
        // A partially consumed native construction is UNKNOWN and is never retried.
        throw cause;
      }
    }
    return this.#roomPumpStopped ? undefined : this.#room;
  }
  #maintainHistory(store: DocChannelStore): void {
    requireDocChannelStoreDatabase(store, this.#db);
    requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
    if (this.#db.$client.inTransaction || this.#currentEntry)
      throw new Error('Current document maintenance cannot nest.');
    this.#currentEntry = true;
    try {
      // Native eligibility uses only its constructor-owned package clock. This
      // captured host timestamp applies solely to ordinary Doc retention.
      const now = Reflect.apply(
        maintenanceIso,
        new MaintenanceDate(Reflect.apply(maintenanceNow, MaintenanceDate, [])),
        []
      );
      this.#ensureRoom()?.pruneSettledReceipts();
      requireDocChannelStoreDatabase(store, this.#db);
      if (this.#db.$client.inTransaction)
        throw new Error('Native pruning left an active transaction.');
      retainDocHistory(store, now);
    } finally {
      this.#currentEntry = false;
    }
  }
  core(): CurrentDocOperationEngineCore {
    return this.#core;
  }
  #operatorRows(documentId: string, roomId: string, key: string, tx?: DbTransaction) {
    // Only the recognized emission lane supplies its generated query facade.
    // Every invocation reads the same complete original source rows afresh.
    if (tx)
      return tx.get<
        Record<string, unknown>
      >(sql`SELECT a.id AS operatorAuthorId,a.natural_key AS operatorNaturalKey,
      a.linked_owner_key AS operatorLinkedOwnerKey,d.author_id AS authorId,d.opened_at AS openedAt,
      c.created_at AS channelCreatedAt,c.opener_agent_id AS openerAgentId,
      c.declaration_hash AS declarationHash,c.manifest_hash AS manifestHash
      FROM main.authors a JOIN main.room_members m ON m.author_id=a.id
      JOIN main.canvas_documents d ON d.id=${documentId} JOIN main.canvas_doc_channels c ON c.document_id=d.id
      WHERE a.kind='human' AND a.natural_key=${key} AND a.retired_at IS NULL AND m.room_id=${roomId}
      AND d.scope=${`room:${roomId}`} AND d.room_id=${roomId} AND c.closed_at IS NULL`);
    return this.#nativePrepare(
      `SELECT a.id AS operatorAuthorId,a.natural_key AS operatorNaturalKey,
      a.linked_owner_key AS operatorLinkedOwnerKey,d.author_id AS authorId,d.opened_at AS openedAt,
      c.created_at AS channelCreatedAt,c.opener_agent_id AS openerAgentId,
      c.declaration_hash AS declarationHash,c.manifest_hash AS manifestHash
      FROM main.authors a JOIN main.room_members m ON m.author_id=a.id
      JOIN main.canvas_documents d ON d.id=? JOIN main.canvas_doc_channels c ON c.document_id=d.id
      WHERE a.kind='human' AND a.natural_key=? AND a.retired_at IS NULL AND m.room_id=?
      AND d.scope=? AND d.room_id=? AND c.closed_at IS NULL`
    ).get(documentId, key, roomId, `room:${roomId}`, roomId) as Record<string, unknown> | undefined;
  }
  #requireOperatorRows(
    producer:
      | import('./current-operation-types.js').OriginalRoomOperatorProducer
      | import('./current-operation-types.js').OriginalRoomTokenProducer,
    tx?: DbTransaction
  ): void {
    const owner = tx
      ? tx.get<{ id: string }>(sql`SELECT id FROM main.user ORDER BY created_at ASC LIMIT 1`)
      : (this.#nativePrepare('SELECT id FROM main.user ORDER BY created_at ASC LIMIT 1').get() as
          { id: string } | undefined);
    if (producer.owner.kind === 'user' ? owner?.id !== producer.owner.userId : owner !== undefined)
      throw new DocChannelNotFoundError();
    const row = this.#operatorRows(
      producer.birth.documentId,
      producer.birth.roomId,
      producer.operatorNaturalKey,
      tx
    );
    const expected = {
      operatorAuthorId: producer.operatorAuthorId,
      operatorNaturalKey: producer.operatorNaturalKey,
      operatorLinkedOwnerKey: producer.operatorLinkedOwnerKey,
      authorId: producer.birth.authorId,
      openedAt: producer.birth.openedAt,
      channelCreatedAt: producer.birth.channelCreatedAt,
      openerAgentId: producer.birth.openerAgentId,
      declarationHash: producer.birth.declarationHash,
      manifestHash: producer.birth.manifestHash,
    };
    if (!sameCurrentDocData(row, expected)) throw new DocChannelNotFoundError();
  }
  #captureRoomOperatorProducer(store: DocChannelStore, tx: DbTransaction) {
    const input = readCurrentDocIngressInput(this.#authorization, store, tx);
    if (!input.actor || input.tokenScope) throw new DocChannelNotFoundError();
    const claims = input.actor.principal.claims;
    if (claims.kind !== 'operator' || !input.scope.startsWith('room:'))
      throw new DocChannelNotFoundError();
    this.#fixedCurrent(input.documentId, input.actor, true, tx, true);
    const roomId = input.scope.slice(5),
      key = claims.owner.kind === 'user' ? `user:${claims.owner.userId}` : 'local';
    const row = this.#operatorRows(input.documentId, roomId, key);
    if (!row) throw new DocChannelNotFoundError();
    const producer = copyCurrentDocData({
      kind: 'operator' as const,
      owner: claims.owner,
      operatorAuthorId: row.operatorAuthorId,
      operatorNaturalKey: row.operatorNaturalKey,
      operatorLinkedOwnerKey: row.operatorLinkedOwnerKey,
      birth: {
        documentId: input.documentId,
        scope: input.scope,
        roomId,
        authorId: row.authorId,
        openedAt: row.openedAt,
        channelCreatedAt: row.channelCreatedAt,
        openerAgentId: row.openerAgentId,
        declarationHash: row.declarationHash,
        manifestHash: row.manifestHash,
      },
    }) as import('./current-operation-types.js').OriginalRoomOperatorProducer;
    const finalInput = readCurrentDocIngressInput(this.#authorization, store, tx);
    if (
      finalInput.actor !== input.actor ||
      finalInput.event !== input.event ||
      finalInput.documentId !== input.documentId ||
      finalInput.scope !== input.scope
    )
      throw new DocChannelNotFoundError();
    this.#requireOperatorRows(producer);
    return Object.freeze(producer);
  }
  #captureRoomTokenProducer(store: DocChannelStore, tx: DbTransaction) {
    const input = readCurrentDocIngressInput(this.#authorization, store, tx);
    if (input.actor || !input.tokenScope || !input.scope.startsWith('room:'))
      throw new DocChannelNotFoundError();
    this.#finalCurrent(store, tx);
    const own = this.#restoredTokens.get(input.tokenScope)!;
    const { header, data } = this.#tokenNativeCurrent(own),
      owner = data.owner;
    const roomId = input.scope.slice(5),
      key = owner.kind === 'user' ? `user:${owner.userId}` : 'local';
    const row = this.#operatorRows(input.documentId, roomId, key);
    if (!row) throw new DocChannelNotFoundError();
    const producer = copyCurrentDocData({
      kind: 'doc_token' as const,
      owner,
      tokenId: header.tokenId,
      tokenHash: header.tokenHash,
      tokenCreatedAt: header.createdAt,
      tokenExpiresAt: header.expiresAt,
      tokenIssuerJson: header.issuerJson,
      operatorAuthorId: row.operatorAuthorId,
      operatorNaturalKey: row.operatorNaturalKey,
      operatorLinkedOwnerKey: row.operatorLinkedOwnerKey,
      birth: {
        documentId: input.documentId,
        scope: input.scope,
        roomId,
        authorId: row.authorId,
        openedAt: row.openedAt,
        channelCreatedAt: row.channelCreatedAt,
        openerAgentId: row.openerAgentId,
        declarationHash: row.declarationHash,
        manifestHash: row.manifestHash,
      },
    }) as import('./current-operation-types.js').OriginalRoomTokenProducer;
    this.#finalCurrent(store, tx);
    return Object.freeze(producer);
  }
  #requireRoomTokenSource(token: object): void {
    const own = readOriginalRoomTokenSource(token, this.#core, this.#db),
      dependencies = this.#tokenSourceDependencies;
    if (!dependencies || this.#db.$client.inTransaction) throw new DocChannelNotFoundError();
    requireServiceOriginalTokenDependencies(
      dependencies.service,
      this.#authorization,
      dependencies.store,
      dependencies.grants
    );
    this.#retainTokenManifestOwner(dependencies.grants, dependencies.store);
    this.#initializeTokenReaders();
    const current = this.#prepareTokenNativeRead({ ...dependencies, hash: own.producer.tokenHash });
    if (
      current.header.tokenId !== own.producer.tokenId ||
      current.header.issuerJson !== own.producer.tokenIssuerJson ||
      current.header.createdAt !== own.producer.tokenCreatedAt ||
      current.header.expiresAt !== own.producer.tokenExpiresAt ||
      current.header.documentId !== own.source.documentId
    )
      throw new DocChannelNotFoundError();
    const final = readOriginalRoomTokenSource(token, this.#core, this.#db);
    if (!sameCurrentDocData(final, own)) throw new DocChannelNotFoundError();
    this.#requireOperatorRows(own.producer);
  }
  #requireRoomOperatorSource(token: object): void {
    const own = readOriginalRoomOperatorSource(token, this.#core, this.#db),
      producer = own.producer;
    // Durable native source custody outlives its original HTTP request, without reopening that request principal.
    const claims = { kind: 'operator' as const, owner: producer.owner };
    if (
      checkboxAuthoritySync(this.#fixedPorts.ownsInstallation(claims)) !== true ||
      !checkboxAuthoritySync(this.#fixedPorts.roomMembership(own.source.roomId, claims))
    )
      throw new DocChannelNotFoundError();
    const final = readOriginalRoomOperatorSource(token, this.#core, this.#db);
    if (!sameCurrentDocData(final, own)) throw new DocChannelNotFoundError();
    this.#requireOperatorRows(producer); // Fixed native tail, after every observable owner/member callback.
  }
  #fixedCurrent(
    documentId: string,
    actor: DocChannelActor,
    write: boolean,
    tx: DbTransaction | undefined,
    ready: boolean
  ): { id: string; scope: string } {
    if (
      !isServerPrincipal(actor.principal) ||
      typeof this.#fixedPorts.principalCurrent !== 'function' ||
      checkboxAuthoritySync(this.#fixedPorts.principalCurrent(actor.principal)) !== true
    )
      throw new DocChannelNotFoundError();
    const claims = actor.principal.claims;
    if (checkboxAuthoritySync(this.#fixedPorts.ownsInstallation(claims)) !== true)
      throw new DocChannelNotFoundError();
    const result = readCurrentDocAccessRows(
      tx ?? this.#db,
      documentId,
      actor.principal,
      actor.surface,
      ready
    );
    if (result.roomId !== undefined) {
      const membership = checkboxAuthoritySync(
        this.#fixedPorts.roomMembership(result.roomId, claims)
      );
      if (!membership) throw new DocChannelNotFoundError();
      if (write && membership.archived) throw new DocChannelArchivedError();
    }
    return { id: result.id, scope: result.scope };
  }

  async #preflightCurrent(
    documentId: string,
    actor: DocChannelActor,
    write: boolean
  ): Promise<void> {
    requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
    const db = this.#db;
    withCheckboxReadOnlyGate(db, () =>
      this.#fixedCurrent(documentId, actor, write, undefined, true)
    );
    if (
      actor.principal.claims.kind === 'runtime' &&
      this.#fixedPorts.revalidateRuntime &&
      !(await this.#fixedPorts.revalidateRuntime(actor.principal))
    )
      throw new DocChannelNotFoundError();
    withCheckboxReadOnlyGate(db, () =>
      this.#fixedCurrent(documentId, actor, write, undefined, true)
    );
  }
  #beginCurrent(
    store: DocChannelStore,
    tx: DbTransaction,
    documentId: string,
    actor: DocChannelActor,
    write: boolean,
    requestedCondition: DocEventCondition | 'server-initial-replay',
    documentAuthority?: import('./current-operation-types.js').OriginalCurrentDocumentAuthority
  ): CurrentOperationScope {
    requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
    const db = this.#db;
    requireDocChannelStoreDatabase(store, db);
    if (this.#currentEntry || db.$client.inTransaction !== true || this.#scopes.has(tx))
      throw new Error('Current document operation requires its inactive genuine entry.');
    const identity = withCheckboxReadOnlyGate(db, () =>
      this.#fixedCurrent(documentId, actor, write, tx, true)
    );
    const rows = readCurrentDocBirthRows(tx, documentId);
    if (!rows) throw new DocChannelNotFoundError();
    const { physical, channel, birth, generation } = rows;
    // Only the private initial replay derives its own birth; submit/inspect remain condition-required.
    const condition =
      requestedCondition === 'server-initial-replay'
        ? Object.freeze({ expectedGeneration: generation })
        : requestedCondition;
    if (condition.expectedGeneration !== generation)
      throw new DocIngestRefusal('DOC_GENERATION_CHANGED', 409);
    const scope: CurrentOperationScope = {
      authorization: this.#authorization,
      engine: this.#core,
      db: this.#db,
      store,
      actor,
      documentId: identity.id,
      scope: identity.scope,
      write,
      birth,
      generation,
      physicalRow: copyCurrentDocData(physical),
      channelRow: copyCurrentDocData(channel),
      capturedFloor: channel.receiptRetentionFloor,
      condition,
      documentAuthority,
      absentAdmission: false,
    };
    if (documentAuthority) {
      const own = this.#documentAuthorities.get(documentAuthority);
      if (
        !own ||
        own.store !== store ||
        own.documentId !== documentId ||
        own.actor.principal !== actor.principal
      )
        throw new DocChannelNotFoundError();
      const dependencies = captureCurrentDocumentGrantDependencies(
        own.grants,
        store,
        documentId,
        own.actor,
        own.grantIds,
        tx,
        own.writeObservation
      );
      const priorDependencies = documentDependenciesBeforeOriginalGrantInsertion(
        own.grants,
        store,
        documentId,
        own.actor,
        own.grantIds,
        tx,
        dependencies
      );
      if (!sameCurrentDocData(own.baseline, this.#documentScopeBaseline(scope, priorDependencies)))
        throw new DocChannelNotFoundError();
      scope.documentGrantRows = this.#documentGrantRows(documentId, tx);
      scope.documentGrantSelection = {
        grants: own.grants,
        ids: own.grantIds,
        writeObservation: own.writeObservation,
      };
    }
    this.#currentEntry = true;
    this.#activeCurrent.add(tx);
    this.#scopes.set(tx, scope);
    return scope;
  }
  #finalCurrent(store: DocChannelStore, tx: DbTransaction): void {
    const own = this.#scopes.get(tx);
    const db = this.#db;
    if (
      !own ||
      own.authorization !== this.#authorization ||
      own.store !== store ||
      !this.#activeCurrent.has(tx) ||
      !this.#currentEntry ||
      !db.$client.inTransaction
    )
      throw new Error('Current document operation is foreign or retired.');
    if (own.failure) throw own.failure.cause;
    requireDocChannelStoreDatabase(store, db);
    const checked = withCheckboxReadOnlyGate(db, () => {
      if (own.tokenScope) {
        const token = this.#restoredTokens.get(own.tokenScope);
        if (!token || token.store !== store || token.grants !== own.grants)
          throw new DocChannelNotFoundError();
        const current = this.#tokenNativeCurrent(token);
        if (
          current.header.documentId !== own.documentId ||
          current.header.generation !== own.generation ||
          !sameOriginalDocTokenData(current.data.grantIds, own.tokenGrantIds)
        )
          throw new DocChannelNotFoundError();
        return { id: current.header.documentId, scope: current.header.scope };
      }
      if (!own.actor) throw new DocChannelNotFoundError();
      const service = this.#fixedPorts.nativeRuntimePrincipals;
      const result = this.#fixedCurrent(own.documentId, own.actor, own.write, tx, true);
      if (own.documentGrantSelection) {
        const selection = own.documentGrantSelection;
        // Complete selected-grant policy before the final configured-time/read-only phase.
        captureCurrentDocumentGrantDependencies(
          selection.grants,
          store,
          own.documentId,
          own.actor,
          selection.ids,
          tx,
          selection.writeObservation
        );
      }
      const time =
        own.actor.principal.claims.kind === 'runtime' && service
          ? captureNativePrincipalTime(service, db, own.actor.principal)
          : undefined;
      if (own.documentGrantSelection) {
        const selection = own.documentGrantSelection;
        requireCurrentDocumentGrantFinal(
          selection.grants,
          store,
          own.documentId,
          selection.ids,
          tx
        );
      }
      if (
        own.actor.principal.claims.kind === 'runtime' &&
        (!service ||
          time === undefined ||
          !readCurrentNativePrincipal(service, db, own.actor.principal, tx, time))
      )
        throw new DocChannelNotFoundError();
      return result;
    });
    const presenceFocus = this.#presenceFocusTransactions.get(tx);
    if (presenceFocus) this.#requirePresenceFocus(presenceFocus, store);
    const selection = this.#editorSelections.get(tx);
    if (selection) {
      if (
        !selection.fileSource.canonicalFile ||
        !own.documentAuthority ||
        !sameCurrentDocData(
          selection.source,
          this.#editorSelectionReader.read(selection.fileSource.canonicalFile, selection.request)
        )
      )
        throw new DocChannelNotFoundError();
    }
    const duplicateSave = this.#documentSaveInspections.get(tx);
    if (duplicateSave) {
      const actual = readOriginalDocumentFileSaveCurrent(duplicateSave.scope, this.#db, store);
      if (
        actual.path !== duplicateSave.path ||
        !sameCurrentDocData(actual.request, duplicateSave.request)
      )
        throw new DocChannelNotFoundError();
      this.#editorSelectionReader.readFile(duplicateSave.path, duplicateSave.hash);
    }
    const saved = this.#documentSaveCompletions.get(tx);
    if (saved) {
      requireOriginalDocumentFileSaveCompleted(saved.scope, this.#db, store, saved.hash);
      this.#editorSelectionReader.readFile(saved.path, saved.hash);
    }
    // Fixed readonly SQL/data comparison only; no callback, clock or await follows.
    auditCurrentDocFinalRows(tx, own, checked);
    if (own.documentAuthority) {
      const captured = this.#documentAuthorities.get(own.documentAuthority);
      if (
        !captured ||
        captured.store !== store ||
        !sameCurrentDocData(own.documentGrantRows, this.#documentGrantRows(own.documentId, tx))
      )
        throw new DocChannelNotFoundError();
    }
  }
  #retireCurrent(tx: DbTransaction): void {
    this.#presenceFocusTransactions.delete(tx);
    this.#editorSelections.delete(tx);
    this.#documentSaveInspections.delete(tx);
    this.#documentSaveCompletions.delete(tx);
    this.#scopes.delete(tx);
    this.#activeCurrent.delete(tx);
    this.#currentEntry = false;
  }
  async #replayExpiredCurrent(
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    raw: unknown,
    rawActor: DocChannelActor
  ): Promise<import('@dorkos/shared/canvas-channel-schemas').CanvasChannelBatchReplayResult> {
    const request = CanvasChannelBatchReplayRequestSchema.parse(copyCurrentDocData(raw));
    const actor = captureCurrentHttpDocActor(rawActor);
    if (actor.principal.claims.kind !== 'operator') throw new DocChannelNotFoundError();
    requireCurrentDocConstructorEngines(this.#authorization, store, ingest, grants);
    await this.#preflightCurrent(request.documentId, actor, true);
    const reader = (this.#tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
      this.#db,
      this.#fixedPorts.originalRoomRepoStore
    ));
    const fileSource = reader.observe(request.documentId);
    const captured = await this.#captureDocument(
      store,
      grants,
      request.documentId,
      actor,
      [request.grantId],
      undefined,
      fileSource
    );
    if (captured.generation !== request.expectedGeneration)
      throw new DocIngestRefusal('DOC_GENERATION_CHANGED', 409);
    const original = this.#readDocumentAuthority(store, grants, captured.authority);
    const limits = readOriginalDocIngestLimits(ingest, store);
    const fixedStore = requireOriginalNativeDownstreamStore(store, this.#db);
    this.#ensureRoom();
    let committedTx: DbTransaction | undefined;
    let committedAt: string | undefined;
    try {
      const response = documentTransaction(this.#db, (tx) => {
        const scope = this.#beginCurrent(
          store,
          tx,
          request.documentId,
          actor,
          true,
          { expectedGeneration: request.expectedGeneration },
          captured.authority
        );
        scope.ingest = ingest;
        scope.grants = grants;
        try {
          const hasRoom = scope.scope.startsWith('room:');
          if ((!hasRoom && !scope.scope.startsWith('session:')) || (hasRoom && !this.#room))
            throw new DocIngestRefusal('DOCUMENT_REPLAY_UNAVAILABLE', 409);
          const old = readCurrentStoreGetBatch(tx, request.batchId);
          if (
            !old ||
            old.documentId !== request.documentId ||
            old.scope !== scope.scope ||
            old.generation !== request.expectedBatchGeneration
          )
            throw new DocIngestRefusal('DOCUMENT_REPLAY_UNAVAILABLE', 409);
          const retained = readDocEventRow(tx, request.documentId, request.eventId);
          if (retained) {
            const payload = retained.payload as Record<string, unknown>;
            if (
              retained.direction !== 'system' ||
              retained.type !== 'event.status' ||
              !payload ||
              payload.operation !== 'explicit_replay' ||
              payload.previousBatchId !== old.batchId ||
              payload.previousGeneration !== old.generation ||
              payload.documentGeneration !== request.expectedGeneration ||
              payload.grantId !== request.grantId ||
              typeof payload.batchId !== 'string' ||
              typeof payload.generation !== 'string' ||
              old.errorCode !== 'manual_replay_consumed'
            )
              throw new DocIngestRefusal('DOC_EVENT_ID_CONFLICT', 409);
            const next = readCurrentStoreGetBatch(tx, payload.batchId);
            if (
              !next ||
              next.documentId !== request.documentId ||
              next.generation !== payload.generation ||
              next.grantId !== request.grantId ||
              next.routeId !== old.routeId ||
              !sameCurrentDocData(next.inputEventIds, old.inputEventIds)
            )
              throw new DocIngestRefusal('DOCUMENT_REPLAY_UNAVAILABLE', 409);
            const response = CanvasChannelBatchReplayResultSchema.parse({
              documentId: request.documentId,
              eventId: request.eventId,
              previousBatchId: old.batchId,
              batchId: next.batchId,
              generation: next.generation,
              status: 'duplicate',
            });
            this.#finalCurrent(store, tx);
            if (
              !sameCurrentDocData(
                retained,
                readDocEventRow(tx, request.documentId, request.eventId)
              ) ||
              !sameCurrentDocData(next, readCurrentStoreGetBatch(tx, next.batchId)) ||
              !sameCurrentDocData(old, readCurrentStoreGetBatch(tx, old.batchId))
            )
              throw new DocChannelNotFoundError();
            return response;
          }
          if (
            old.status !== 'expired' ||
            old.errorCode === 'manual_replay_consumed' ||
            old.admissionReceiptId !== null ||
            old.turnId !== null ||
            old.relayMessageId !== null ||
            old.leaseUntil !== null ||
            old.deliveryKind === 'room_app_event' ||
            old.roomAdmissionId !== null ||
            old.roomSourceAttempt !== null ||
            old.roomSourceJson !== null ||
            old.roomSourceHash !== null ||
            tx.get(sql`SELECT 1 FROM room_doc_admissions WHERE document_id=${request.documentId}
              AND batch_id=${old.batchId} LIMIT 1`) ||
            tx.get(sql`SELECT 1 FROM session_message_acceptance_receipts
              WHERE source_kind='document_event_batch' AND source_id=${old.batchId} LIMIT 1`)
          )
            throw new DocIngestRefusal('DOCUMENT_REPLAY_UNAVAILABLE', 409);
          const route = readOriginalReviewedDocReplayRoute(
            grants,
            store,
            request.documentId,
            actor,
            tx,
            request.grantId,
            original.writeObservation,
            undefined,
            this.#room,
            this.#core
          );
          if (
            route.grant.routeId !== old.routeId ||
            old.inputEventIds.length < 1 ||
            old.inputEventIds.length > 400 ||
            new Set(old.inputEventIds).size !== old.inputEventIds.length
          )
            throw new DocIngestRefusal('DOCUMENT_REPLAY_INPUT_UNAVAILABLE', 409);
          const inputs = old.inputEventIds.map((id) => {
            const event = readDocEventRow(tx, request.documentId, id);
            if (
              !event ||
              event.direction !== 'upstream' ||
              event.payloadPrunedAt !== null ||
              !matchesCanvasChannelEvent(route.route.on, event.type) ||
              !(route.grant.allowedTypes as string[]).some((type) =>
                matchesCanvasChannelEvent(type, event.type)
              )
            )
              throw new DocIngestRefusal('DOCUMENT_REPLAY_INPUT_UNAVAILABLE', 409);
            return event;
          });
          const deliveries = tx
            .select()
            .from(canvasDocDeliveries)
            .where(
              and(
                eq(canvasDocDeliveries.documentId, request.documentId),
                eq(canvasDocDeliveries.batchId, old.batchId)
              )
            )
            .orderBy(canvasDocDeliveries.eventId, canvasDocDeliveries.routeId)
            .limit(401)
            .all();
          if (
            deliveries.length !== inputs.length ||
            deliveries.some(
              (row) =>
                row.routeId !== old.routeId ||
                !old.inputEventIds.includes(row.eventId) ||
                row.status !== 'expired' ||
                row.turnId !== null ||
                row.roomAdmissionId !== null ||
                row.deliveryKind === 'room_app_event' ||
                row.ackOutcome !== null ||
                row.ackEvidence !== null ||
                row.acknowledgedAt !== null ||
                row.acknowledgedBy !== null
            )
          )
            throw new DocIngestRefusal('DOCUMENT_REPLAY_UNAVAILABLE', 409);
          if (
            !sameCurrentDocData(
              route,
              readOriginalReviewedDocReplayRoute(
                grants,
                store,
                request.documentId,
                actor,
                tx,
                request.grantId,
                original.writeObservation,
                inputs,
                this.#room,
                this.#core
              )
            )
          )
            throw new DocChannelNotFoundError();
          const now = withCheckboxReadOnlyGate(this.#db, () =>
            captureCurrentDocIngestClock(ingest, store, this.#authorization, tx)
          );
          scope.now = now;
          scope.originalWriteObservation = original.writeObservation;
          if (hasRoom) {
            const first = inputs[0]!;
            scope.event = copyCurrentDocData(
              StoredPageEventSchema.parse({
                v: 1,
                id: first.eventId,
                type: first.type,
                payload: first.payload,
              })
            );
            const access = prepareCurrentDocGrantRoutes(grants, store, this.#authorization, tx);
            const decisions = access.routes.filter(
              (decision) =>
                !decision.reason &&
                decision.grantId === request.grantId &&
                decision.route.id === old.routeId &&
                decision.route.to === 'room:self' &&
                decision.route.turn.mode !== 'none'
            );
            if (decisions.length !== 1)
              throw new DocIngestRefusal('DOCUMENT_REPLAY_TRANSPORT_UNAVAILABLE', 409);
            scope.access = { ...access, routes: decisions };
          }
          const sessionNextId = randomUUID(),
            sessionGeneration = randomUUID();
          const next = hasRoom
            ? this.#room!.prepareReplay(store, grants, tx, old.batchId, now)
            : {
                batchId: sessionNextId,
                documentId: request.documentId,
                scope: scope.scope,
                routeId: old.routeId,
                grantId: route.grant.grantId,
                grantRevision: route.grant.revision,
                generation: sessionGeneration,
                inputEventIds: [...old.inputEventIds],
                effectivePayload: { eventIds: [...old.inputEventIds] },
                dueAt: now,
                status: 'pending' as const,
                createdAt: now,
                updatedAt: now,
                attempt: 0,
                leaseUntil: null,
                waitingWarningAt: null,
                relayMessageId: null,
                turnId: null,
                admissionReceiptId: null,
                deliveryKind: null,
                roomAdmissionId: null,
                roomSourceAttempt: null,
                roomSourceJson: null,
                roomSourceHash: null,
                errorCode: null,
              };
          const nextId = next.batchId,
            generation = next.generation;
          this.#finalCurrent(store, tx);
          if (!sameCurrentDocData(old, readCurrentStoreGetBatch(tx, old.batchId)))
            throw new DocChannelNotFoundError();
          for (const event of inputs)
            if (!sameCurrentDocData(event, readDocEventRow(tx, request.documentId, event.eventId)))
              throw new DocChannelNotFoundError();
          if (
            !sameCurrentDocData(
              deliveries,
              tx
                .select()
                .from(canvasDocDeliveries)
                .where(
                  and(
                    eq(canvasDocDeliveries.documentId, request.documentId),
                    eq(canvasDocDeliveries.batchId, old.batchId)
                  )
                )
                .orderBy(canvasDocDeliveries.eventId, canvasDocDeliveries.routeId)
                .limit(401)
                .all()
            )
          )
            throw new DocChannelNotFoundError();
          const beforeChanges = tx.get<{ count: number }>(
            sql`SELECT total_changes() AS count`
          )!.count;
          if (!Number.isSafeInteger(beforeChanges)) throw new DocChannelNotFoundError();
          // The private intention is immutable JSON DATA; Drizzle receives an ordinary JSON value.
          tx.insert(canvasDocBatches)
            .values({ ...next, effectivePayload: { eventIds: [...next.inputEventIds] } })
            .run();
          const consumed = tx
            .update(canvasDocBatches)
            .set({ errorCode: 'manual_replay_consumed', updatedAt: now })
            .where(
              and(
                eq(canvasDocBatches.batchId, old.batchId),
                eq(canvasDocBatches.generation, old.generation),
                eq(canvasDocBatches.status, 'expired')
              )
            )
            .run().changes;
          if (consumed !== 1) throw new DocIngestRefusal('DOCUMENT_REPLAY_RACED', 409);
          const moved = tx
            .update(canvasDocDeliveries)
            .set({ batchId: nextId, status: 'pending', reason: null, updatedAt: now })
            .where(
              and(
                eq(canvasDocDeliveries.documentId, request.documentId),
                eq(canvasDocDeliveries.batchId, old.batchId),
                eq(canvasDocDeliveries.routeId, old.routeId),
                eq(canvasDocDeliveries.status, 'expired')
              )
            )
            .run().changes;
          if (moved !== inputs.length) throw new DocIngestRefusal('DOCUMENT_REPLAY_RACED', 409);
          // Replay adds no input or rate unit. It must still fit the original full backlog and reservation census.
          const reservations = scanCheckboxReservationPolicies(tx, {
            documentId: request.documentId,
          });
          const usage = tx.get<{ count: number; bytes: number }>(
            protectedCapacityQuery(request.documentId)
          )!;
          const installation = tx.get<{ bytes: number }>(protectedCapacityQuery())!;
          if (
            usage.count + reservations.document.originals > limits.pendingEvents ||
            usage.bytes + reservations.document.bytes > limits.pendingBytes ||
            installation.bytes + reservations.installation.bytes > limits.installationPendingBytes
          )
            throw new DocIngestRefusal('DOC_EVENT_BACKLOG_FULL', 429, 60);
          const payload = {
            operation: 'explicit_replay',
            previousBatchId: old.batchId,
            previousGeneration: old.generation,
            documentGeneration: request.expectedGeneration,
            grantId: request.grantId,
            batchId: nextId,
            generation,
            routeId: old.routeId,
            status: 'pending',
          };
          const identity = envelopeIdentity({
            v: 1,
            id: request.eventId,
            type: 'event.status',
            payload,
          });
          const saved = fixedStore.appendEvent(
            {
              documentId: request.documentId,
              eventId: request.eventId,
              direction: 'system',
              type: 'event.status',
              payload,
              envelopeHash: identity.hash,
              envelopeBytes: identity.bytes,
              provenance: { source: 'doc-channel-service' },
              receivedAt: now,
            },
            tx
          );
          scope.acceptedDocSeq = saved.docSeq;
          if (hasRoom) {
            this.#room!.seal(store, tx, readOriginalDocIngestLimits(ingest, store));
            auditCurrentDocGrantRows(grants, store, this.#authorization, tx);
            this.#room!.audit(store, grants, tx);
          }
          const response = CanvasChannelBatchReplayResultSchema.parse({
            documentId: request.documentId,
            eventId: request.eventId,
            previousBatchId: old.batchId,
            batchId: nextId,
            generation,
            status: 'pending',
          });
          if (
            !sameCurrentDocData(
              route,
              readOriginalReviewedDocReplayRoute(
                grants,
                store,
                request.documentId,
                actor,
                tx,
                request.grantId,
                original.writeObservation,
                inputs,
                this.#room,
                this.#core
              )
            )
          )
            throw new DocChannelNotFoundError();
          this.#finalCurrent(store, tx);
          const actual = readCurrentStoreGetBatch(tx, nextId);
          if (
            !sameCurrentDocData(actual, next) ||
            !sameCurrentDocData(readCurrentStoreGetBatch(tx, old.batchId), {
              ...old,
              errorCode: 'manual_replay_consumed',
              updatedAt: now,
            }) ||
            tx.get(sql`SELECT 1 FROM session_message_acceptance_receipts
              WHERE source_kind='document_event_batch' AND source_id IN (${old.batchId},${nextId}) LIMIT 1`)
          )
            throw new DocChannelNotFoundError();
          const finalDeliveries = tx
            .select()
            .from(canvasDocDeliveries)
            .where(
              and(
                eq(canvasDocDeliveries.documentId, request.documentId),
                eq(canvasDocDeliveries.batchId, nextId)
              )
            )
            .orderBy(canvasDocDeliveries.eventId, canvasDocDeliveries.routeId)
            .limit(401)
            .all();
          if (
            !sameCurrentDocData(
              finalDeliveries,
              deliveries.map((row) => ({
                ...row,
                batchId: nextId,
                status: 'pending',
                reason: null,
                updatedAt: now,
              }))
            ) ||
            !sameCurrentDocData(saved, readDocEventRow(tx, request.documentId, request.eventId)) ||
            tx.get<{ count: number }>(sql`SELECT total_changes() AS count`)!.count -
              beforeChanges !==
              inputs.length + 4 + (hasRoom ? readOriginalRoomPendingWriteCount(this.#room!, tx) : 0)
          )
            throw new DocChannelNotFoundError();
          for (const event of inputs)
            if (!sameCurrentDocData(event, readDocEventRow(tx, request.documentId, event.eventId)))
              throw new DocChannelNotFoundError();
          if (hasRoom) {
            committedTx = tx;
            committedAt = now;
          }
          return response;
        } catch (cause) {
          this.#room?.abandoned(tx);
          if (!scope.failure) scope.failure = { cause };
          throw scope.failure.cause;
        } finally {
          this.#retireCurrent(tx);
        }
      });
      if (committedTx) this.#room!.committed(committedTx, committedAt!);
      return response;
    } catch (cause) {
      if (committedTx) this.#room?.abandoned(committedTx);
      throw cause;
    }
  }
  #observeReplayFileSource(store: DocChannelStore, documentId: string, grants?: DocChannelGrants) {
    if (
      !grants ||
      !this.#db.get(sql`SELECT 1 FROM canvas_doc_grants
      WHERE document_id=${documentId} AND revoked_at IS NULL AND write_operation IS NOT NULL LIMIT 1`)
    )
      return undefined;
    requireCurrentDocConstructorEngines(this.#authorization, store, undefined, grants);
    this.#retainTokenManifestOwner(grants, store);
    const reader = (this.#tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
      this.#db,
      this.#fixedPorts.originalRoomRepoStore
    ));
    const source = reader.observe(documentId);
    if (source.canonicalFile === null) {
      // A genuine non-FILE source remains readable; its stale FILE grant cannot qualify.
      if (!sameOriginalDocTokenData(source, reader.observe(documentId)))
        throw new DocChannelNotFoundError();
      return { source, observed: undefined };
    }
    const physical = source.policies.physical;
    const observed = Object.freeze({
      manifestHash: readOriginalTokenDocumentManifest(grants, store, this.#db, documentId),
      write: Object.freeze(
        CanvasChannelCheckboxBindingSchema.parse({
          operation: 'checkbox-toggle',
          sourceIdentity: physical.source_key,
          resolvedCwd: physical.resolved_cwd,
          treeKind: physical.tree_kind,
          canonicalPath: source.canonicalFile,
        })
      ),
    });
    if (!sameOriginalDocTokenData(source, reader.observe(documentId)))
      throw new DocChannelNotFoundError();
    return { source, observed };
  }
  async #managementCurrent(store: DocChannelStore, documentId: string, rawActor: DocChannelActor) {
    const actor = captureCurrentHttpDocActor(rawActor);
    if (actor.principal.claims.kind !== 'operator') throw new DocChannelNotFoundError();
    requireCurrentDocConstructorEngines(this.#authorization, store);
    await this.#preflightCurrent(documentId, actor, false);
    requireDocChannelStoreDatabase(store, this.#db);
    if (this.#db.$client.inTransaction || this.#currentEntry)
      throw new Error('Document management cannot nest.');
    const grants = this.#tokenSourceDependencies?.grants;
    const file = this.#observeReplayFileSource(store, documentId, grants);
    this.#ensureRoom();
    const readRows = (this.#managementReader ??= createOriginalDocManagementReader(this.#db));
    return documentTransaction(this.#db, (tx) => {
      const scope = this.#beginCurrent(
        store,
        tx,
        documentId,
        actor,
        false,
        'server-initial-replay'
      );
      try {
        scope.originalWriteObservation = file?.observed;
        if (!grants) throw new DocChannelNotFoundError();
        const rows = readRows(documentId);
        const routing = readOriginalCurrentDocReplayRouting(
          grants,
          store,
          documentId,
          actor,
          tx,
          this.#room,
          this.#core
        );
        const result = CanvasChannelManagementSnapshotSchema.parse({
          documentId,
          generation: scope.generation,
          declaration: scope.channelRow.declaration,
          routing,
          ...projectDocManagementRows(
            rows,
            scope.scope.startsWith('room:') &&
              !!this.#room &&
              readOriginalRoomReplayAvailability(this.#room, this.#core, this.#db)
          ),
        });
        if (
          !sameCurrentDocData(
            routing,
            readOriginalCurrentDocReplayRouting(
              grants,
              store,
              documentId,
              actor,
              tx,
              this.#room,
              this.#core
            )
          )
        )
          throw new DocChannelNotFoundError();
        // Every policy callback and projection precedes the original final current gate.
        this.#finalCurrent(store, tx);
        // Fixed fresh SQL/display DATA equality only, with no clock or policy callback after the gate.
        if (
          file &&
          !sameOriginalDocTokenData(
            file.source.policies.physical,
            tx.get(sql`SELECT id,scope,opened_at,author_id,source_key,content,resolved_cwd,tree_kind
              FROM canvas_documents WHERE id=${documentId} LIMIT 1`)
          )
        )
          throw new DocChannelNotFoundError();
        if (
          !sameCurrentDocData(rows, readRows(documentId)) ||
          !sameCurrentDocData(scope.channelRow, readCurrentReplayChannelRow(tx, documentId))
        )
          throw new DocChannelNotFoundError();
        return result;
      } catch (cause) {
        if (!scope.failure) scope.failure = { cause };
        throw scope.failure.cause;
      } finally {
        this.#retireCurrent(tx);
      }
    });
  }
  async #replayCurrent(
    store: DocChannelStore,
    documentId: string,
    rawActor: DocChannelActor,
    since: number,
    limit: number,
    documentAuthority?: import('./current-operation-types.js').OriginalCurrentDocumentAuthority
  ): Promise<DocCurrentReplayResponse> {
    const actor = captureCurrentHttpDocActor(rawActor);
    requireCurrentDocConstructorEngines(this.#authorization, store);
    await this.#preflightCurrent(documentId, actor, false);
    const db = this.#db;
    requireDocChannelStoreDatabase(store, db);
    if (db.$client.inTransaction || this.#currentEntry)
      throw new Error('Current document replay cannot nest.');
    const grants = this.#tokenSourceDependencies?.grants;
    const file = this.#observeReplayFileSource(store, documentId, grants);
    // Construct the installed native transport outside SQL before the first app replay.
    // Its original factory retains recovery failure and stopped-pump refusal.
    this.#ensureRoom();
    return documentTransaction(db, (tx) => {
      const scope = this.#beginCurrent(
        store,
        tx,
        documentId,
        actor,
        false,
        'server-initial-replay',
        documentAuthority
      );
      try {
        const snapshot = readCurrentDocReplayInTransaction(
          tx,
          scope.documentId,
          scope.scope,
          scope.channelRow,
          since,
          limit
        );
        scope.originalWriteObservation = file?.observed;
        const routing = grants
          ? readOriginalCurrentDocReplayRouting(
              grants,
              store,
              documentId,
              actor,
              tx,
              this.#room,
              this.#core
            )
          : { enabled: false, approvedEventTypes: [], destinationLabel: '' };
        const result = projectCurrentDocReplay(
          { ...snapshot, routing },
          scope.birth,
          scope.generation,
          scope.physicalRow,
          scope.channelRow,
          scope.scope
        );
        if (
          grants &&
          !sameCurrentDocData(
            routing,
            readOriginalCurrentDocReplayRouting(
              grants,
              store,
              documentId,
              actor,
              tx,
              this.#room,
              this.#core
            )
          )
        )
          throw new DocChannelNotFoundError();
        // All decoding/projection and effectful grant checks precede the final native gate.
        this.#finalCurrent(store, tx);
        if (
          file &&
          !sameOriginalDocTokenData(
            file.source.policies.physical,
            tx.get(sql`SELECT id,scope,opened_at,author_id,source_key,content,resolved_cwd,tree_kind
              FROM canvas_documents WHERE id=${documentId} LIMIT 1`)
          )
        )
          throw new DocChannelNotFoundError();
        const finalChannel = readCurrentReplayChannelRow(tx, documentId);
        if (!sameCurrentDocData(scope.channelRow, finalChannel))
          throw new DocChannelNotFoundError();
        return result;
      } catch (cause) {
        if (!scope.failure) scope.failure = { cause };
        throw scope.failure.cause;
      } finally {
        this.#retireCurrent(tx);
      }
    });
  }
  async #inspectCurrent(
    store: DocChannelStore,
    documentId: string,
    eventId: string,
    rawActor: DocChannelActor,
    rawCondition: DocEventCondition,
    documentAuthority?: import('./current-operation-types.js').OriginalCurrentDocumentAuthority,
    duplicateSave?: {
      scope: object;
      request: import('@dorkos/shared/schemas').CanvasDocumentSaveIdentity;
      hash: string;
      path: string;
    }
  ): Promise<DocReceiptInspection> {
    requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
    const actor = captureCurrentHttpDocActor(rawActor);
    const condition = captureCurrentDocCondition(rawCondition);
    requireCurrentDocConstructorEngines(this.#authorization, store);
    await this.#preflightCurrent(documentId, actor, false);
    const db = this.#db;
    requireDocChannelStoreDatabase(store, db);
    requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
    if (db.$client.inTransaction || this.#currentEntry)
      throw new Error('Current document inspection cannot nest.');
    return documentTransaction(db, (tx) => {
      const scope = this.#beginCurrent(
        store,
        tx,
        documentId,
        actor,
        false,
        condition,
        documentAuthority
      );
      try {
        if (duplicateSave) this.#documentSaveInspections.set(tx, duplicateSave);
        const event = readDocEventRow(tx, documentId, eventId);
        const channel = readCurrentReceiptChannelRow(tx, documentId)!;
        const result = projectCurrentDocReceipt(
          tx,
          documentId,
          eventId,
          event,
          channel,
          scope.birth,
          scope.generation
        );
        this.#finalCurrent(store, tx);
        return result;
      } catch (cause) {
        if (!scope.failure) scope.failure = { cause };
        throw scope.failure.cause;
      } finally {
        this.#retireCurrent(tx);
      }
    });
  }
  async #prepareDocumentSave(
    store: DocChannelStore,
    grants: DocChannelGrants,
    handle: object,
    rawActor: DocChannelActor
  ) {
    requireCurrentDocConstructorEngines(this.#authorization, store, undefined, grants);
    const actual = readOriginalDocumentFileSave(handle, this.#db, store);
    const request = copyCurrentDocData(actual.input.documentSave!);
    const actor = captureCurrentHttpDocActor(rawActor);
    if (actor.principal.claims.kind !== 'operator' || this.#documentSaves.has(handle))
      throw new DocChannelNotFoundError();
    const expected =
      actual.input.expectedHash ??
      (actual.input.expectedContent === undefined
        ? undefined
        : createHash('sha256').update(actual.input.expectedContent).digest('hex'));
    if (expected !== request.expectedFileHash) throw new DocChannelNotFoundError();
    await this.#preflightCurrent(request.documentId, actor, false);
    const reader = (this.#tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
      this.#db,
      this.#fixedPorts.originalRoomRepoStore
    ));
    const fileSource = reader.observe(request.documentId);
    if (
      !fileSource.canonicalFile ||
      fileSource.canonicalFile !== actual.identity.canonicalPath ||
      fileSource.policies.physical.tree_kind === 'room-main'
    )
      throw new DocChannelNotFoundError();
    const source = this.#editorSelectionReader.readFile(fileSource.canonicalFile);
    const hash = createHash('sha256').update(actual.input.content).digest('hex');
    const event = copyCurrentDocData(
      StoredPageEventSchema.parse({
        v: 1,
        id: request.eventId,
        type: 'doc.saved',
        payload: { previousFileHash: request.expectedFileHash, fileHash: hash },
      })
    );
    const captured = await this.#captureDocument(
      store,
      grants,
      request.documentId,
      actor,
      [],
      undefined,
      fileSource,
      event
    );
    if (
      captured.generation !== request.expectedGeneration ||
      !sameCurrentDocData(fileSource, reader.observe(request.documentId))
    )
      throw new DocChannelNotFoundError();
    const retained = readDocEventRow(this.#db, request.documentId, request.eventId);
    if (retained) {
      if (retained.envelopeHash !== envelopeIdentity(event).hash || source.hash !== hash)
        throw new DocIngestRefusal('DOC_EVENT_ID_CONFLICT', 409);
      // Await the actual canonical owner/path/caller checks before the last original document fence.
      await checkInstallationFileSaveScope(handle);
      const inspected = await this.#inspectCurrent(
        store,
        request.documentId,
        request.eventId,
        actor,
        { expectedGeneration: request.expectedGeneration },
        captured.authority,
        { scope: handle, request, hash, path: fileSource.canonicalFile }
      );
      if (
        inspected.kind !== 'receipt' ||
        inspected.event.receipt.id !== request.eventId ||
        !sameCurrentDocData(
          retained,
          readDocEventRow(this.#db, request.documentId, request.eventId)
        )
      )
        throw new DocChannelNotFoundError();
      return {
        ok: true as const,
        hash,
        effect: 'no_op' as const,
        documentReceipt: Object.freeze({
          receipt: Object.freeze({ ...inspected.event.receipt, status: 'duplicate' as const }),
          deliveries: inspected.event.deliveries,
        }),
      };
    }
    this.#documentSaves.set(handle, {
      store,
      grants,
      actor,
      request,
      authority: captured.authority,
      fileSource,
      event,
      hash,
      consumed: false,
    });
    return undefined;
  }
  async #completeDocumentSave(
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    handle: object,
    rawActor: DocChannelActor
  ) {
    const own = this.#documentSaves.get(handle);
    if (
      !own ||
      own.consumed ||
      own.store !== store ||
      own.grants !== grants ||
      !sameCurrentDocData(own.actor, captureCurrentHttpDocActor(rawActor))
    )
      throw new DocChannelNotFoundError();
    own.consumed = true;
    requireOriginalDocumentFileSaveCompleted(handle, this.#db, store, own.hash);
    const actual = readOriginalDocumentFileSave(handle, this.#db, store);
    if (
      !sameCurrentDocData(own.request, actual.input.documentSave) ||
      !own.fileSource.canonicalFile ||
      actual.identity.canonicalPath !== own.fileSource.canonicalFile ||
      !sameCurrentDocData(
        own.fileSource,
        this.#tokenFileSourceReader!.observe(own.request.documentId)
      )
    )
      throw new DocChannelNotFoundError();
    this.#editorSelectionReader.readFile(own.fileSource.canonicalFile, own.hash);
    return this.#submitCurrent(
      store,
      ingest,
      grants,
      own.request.documentId,
      own.event,
      own.actor,
      { expectedGeneration: own.request.expectedGeneration },
      own.authority,
      undefined,
      handle
    );
  }
  async #selectionCurrent(
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    raw: unknown,
    rawActor: DocChannelActor
  ): Promise<CanvasChannelEventReceipt> {
    const request = CanvasChannelSelectionRequestSchema.parse(copyCurrentDocData(raw));
    const actor = captureCurrentHttpDocActor(rawActor);
    if (actor.principal.claims.kind !== 'operator') throw new DocChannelNotFoundError();
    requireCurrentDocConstructorEngines(this.#authorization, store, ingest, grants);
    await this.#preflightCurrent(request.documentId, actor, true);
    const reader = (this.#tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
      this.#db,
      this.#fixedPorts.originalRoomRepoStore
    ));
    const fileSource = reader.observe(request.documentId);
    if (!fileSource.canonicalFile) throw new DocChannelNotFoundError();
    const source = this.#editorSelectionReader.read(fileSource.canonicalFile, request);
    const event = StoredPageEventSchema.parse({
      v: 1,
      id: request.eventId,
      type: 'selection.ask',
      payload: {
        sourceGeneration: request.sourceGeneration,
        fileHash: source.hash,
        ranges: request.ranges,
        selectedText: source.selectedText,
      },
    });
    // This is the only private caller of the reserved editor lane. Public submit still uses PageEventSchema.
    return this.#submitCurrent(
      store,
      ingest,
      grants,
      request.documentId,
      event,
      actor,
      { expectedGeneration: request.expectedGeneration },
      undefined,
      { request, fileSource, source }
    );
  }
  async #submitCurrent(
    store: DocChannelStore,
    ingest: DocChannelIngest,
    grants: DocChannelGrants,
    documentId: string,
    raw: unknown,
    rawActor: DocChannelActor,
    rawCondition: DocEventCondition,
    documentAuthority?: import('./current-operation-types.js').OriginalCurrentDocumentAuthority,
    selection?: {
      request: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelSelectionRequest;
      fileSource: import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
      source: ReturnType<ReturnType<typeof createOriginalEditorSelectionReader>['read']>;
    },
    documentSave?: object,
    presenceFocus?: object
  ): Promise<CanvasChannelEventReceipt> {
    requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
    const actor = captureCurrentHttpDocActor(rawActor);
    const condition = captureCurrentDocCondition(rawCondition);
    requireCurrentDocConstructorEngines(this.#authorization, store);
    const event = (() => {
      if (selection || documentSave || presenceFocus)
        return copyCurrentDocData(StoredPageEventSchema.parse(copyCurrentDocData(raw)));
      // Public input remains strict JSON; malformed page data is a refusal, not a server fault.
      try {
        return copyCurrentDocData(PageEventSchema.parse(copyCurrentDocData(raw)));
      } catch {
        throw new DocIngestRefusal('INVALID_DOC_EVENT', 400);
      }
    })();
    if (
      selection &&
      (event.type !== 'selection.ask' ||
        event.id !== selection.request.eventId ||
        documentId !== selection.request.documentId ||
        condition.expectedGeneration !== selection.request.expectedGeneration)
    )
      throw new DocChannelNotFoundError();
    if (presenceFocus) {
      const own = this.#presenceFocusStages.get(presenceFocus);
      if (
        !own ||
        own.store !== store ||
        own.ingest !== ingest ||
        own.grants !== grants ||
        own.plan.documentId !== documentId ||
        !sameCurrentDocData(own.event, event) ||
        !sameCurrentDocData(own.actor.principal.claims, actor.principal.claims)
      )
        throw new DocChannelNotFoundError();
      this.#requirePresenceFocusPreflight(presenceFocus, store);
    }
    if (documentSave) {
      const own = this.#documentSaves.get(documentSave);
      if (
        !own?.consumed ||
        own.store !== store ||
        own.grants !== grants ||
        !sameCurrentDocData(own.event, event) ||
        documentId !== own.request.documentId ||
        condition.expectedGeneration !== own.request.expectedGeneration
      )
        throw new DocChannelNotFoundError();
      requireOriginalDocumentFileSaveCompleted(documentSave, this.#db, store, own.hash);
    }
    requireCurrentDocConstructorEngines(this.#authorization, store, ingest, grants);
    await this.#preflightCurrent(documentId, actor, true);
    let refresh: { cause: unknown } | undefined;
    try {
      refreshCurrentDocGrantAuthority(grants, store, this.#authorization, documentId, actor);
    } catch (cause) {
      refresh = { cause };
    }
    const db = this.#db;
    requireDocChannelStoreDatabase(store, db);
    requireCurrentDocEngineOrigin(this.#authorization, this.#core, this.#db);
    if (db.$client.inTransaction || this.#currentEntry)
      throw new Error('Current document admission cannot nest.');
    // An approved FILE write binding also constrains ordinary comments routed by that grant.
    // Observe it through the engine's fixed native reader outside SQL, never a caller DTO.
    let fileSource:
      import('../tokens/token-native-file-source.js').OriginalDocTokenFileSource | undefined;
    let writeObservation: import('../grant-policy.js').DocOriginalWriteObservation | undefined;
    if (
      !refresh &&
      !readDocEventRow(db, documentId, event.id) &&
      db.get(sql`
      SELECT 1 FROM canvas_doc_grants WHERE document_id=${documentId}
      AND revoked_at IS NULL AND write_operation IS NOT NULL LIMIT 1`)
    ) {
      const reader = (this.#tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
        db,
        this.#fixedPorts.originalRoomRepoStore
      ));
      fileSource = reader.observe(documentId);
      if (fileSource.canonicalFile !== null) {
        const physical = fileSource.policies.physical;
        writeObservation = Object.freeze({
          manifestHash: readOriginalTokenDocumentManifest(grants, store, db, documentId),
          write: Object.freeze(
            CanvasChannelCheckboxBindingSchema.parse({
              operation: 'checkbox-toggle',
              sourceIdentity: physical.source_key,
              resolvedCwd: physical.resolved_cwd,
              treeKind: physical.tree_kind,
              canonicalPath: fileSource.canonicalFile,
            })
          ),
        });
        if (!sameOriginalDocTokenData(fileSource, reader.observe(documentId)))
          throw new DocChannelNotFoundError();
      }
    }
    if (selection) {
      const reader = this.#tokenFileSourceReader;
      if (!reader || !sameCurrentDocData(selection.fileSource, reader.observe(documentId)))
        throw new DocChannelNotFoundError();
      documentAuthority = (
        await this.#captureDocument(
          store,
          grants,
          documentId,
          actor,
          [],
          undefined,
          selection.fileSource,
          event
        )
      ).authority;
      if (!sameCurrentDocData(selection.fileSource, reader.observe(documentId)))
        throw new DocChannelNotFoundError();
    }
    this.#ensureRoom();
    let committedTx: DbTransaction | undefined;
    let committedAt: string | undefined;
    let committed = false;
    try {
      const response = documentTransaction(db, (tx) => {
        const scope = this.#beginCurrent(
          store,
          tx,
          documentId,
          actor,
          true,
          condition,
          documentAuthority
        );
        if (selection) this.#editorSelections.set(tx, selection);
        if (presenceFocus) this.#presenceFocusTransactions.set(tx, presenceFocus);
        if (documentSave) {
          const saved = this.#documentSaves.get(documentSave)!;
          if (!saved.fileSource.canonicalFile) throw new DocChannelNotFoundError();
          this.#documentSaveCompletions.set(tx, {
            scope: documentSave,
            hash: saved.hash,
            path: saved.fileSource.canonicalFile,
          });
        }
        scope.event = event;
        scope.ingest = ingest;
        scope.grants = grants;
        try {
          const retained = readDocEventRow(tx, documentId, event.id);
          // Matching retained originals need only current access/birth; no fresh clock, grant, payload, rate or retry-floor decision.
          if (retained) {
            if (retained.envelopeHash !== envelopeIdentity(event).hash)
              throw new DocIngestRefusal('DOC_EVENT_ID_CONFLICT', 409);
            const deliveries = tx
              .select()
              .from(canvasDocDeliveries)
              .where(
                and(
                  eq(canvasDocDeliveries.documentId, documentId),
                  eq(canvasDocDeliveries.eventId, event.id)
                )
              )
              .all();
            const response = copyCurrentDocData({
              receipt: { id: event.id, status: 'duplicate' as const, docSeq: retained.docSeq },
              deliveries: deliveries.map(publicCurrentDelivery),
            });
            this.#finalCurrent(store, tx);
            if (
              !sameCurrentDocData(retained, readDocEventRow(tx, documentId, event.id)) ||
              !sameCurrentDocData(
                deliveries,
                tx
                  .select()
                  .from(canvasDocDeliveries)
                  .where(
                    and(
                      eq(canvasDocDeliveries.documentId, documentId),
                      eq(canvasDocDeliveries.eventId, event.id)
                    )
                  )
                  .all()
              )
            )
              throw new Error('Retained original receipt changed before disclosure.');
            return response;
          }
          if (!retained) {
            scope.absentAdmission = true;
            if (refresh) throw refresh.cause;
            if (
              fileSource &&
              !sameOriginalDocTokenData(
                fileSource.policies.physical,
                tx.get(sql`SELECT id,scope,opened_at,author_id,source_key,content,resolved_cwd,tree_kind
                FROM canvas_documents WHERE id=${documentId} LIMIT 1`)
              )
            )
              throw new DocChannelNotFoundError();
            scope.originalWriteObservation = writeObservation;
            scope.access = prepareCurrentDocGrantRoutes(grants, store, this.#authorization, tx);
            if (writeObservation && !scope.documentGrantSelection) {
              scope.documentGrantSelection = {
                grants,
                ids: scope.access.routes.flatMap((route) =>
                  !route.reason && route.grantId ? [route.grantId] : []
                ),
                writeObservation,
              };
            }
            if (scope.documentAuthority) {
              const own = this.#documentAuthorities.get(scope.documentAuthority)!;
              if (
                scope.access.routes.some(
                  (route) =>
                    !route.reason && (!route.grantId || !own.grantIds.includes(route.grantId))
                )
              )
                throw new DocChannelNotFoundError();
            }
          }
          scope.now = withCheckboxReadOnlyGate(db, () =>
            captureCurrentDocIngestClock(ingest, store, this.#authorization, tx)
          );
          this.#finalCurrent(store, tx);
          const hasRoom = scope.access?.routes.some(
            (decision) =>
              !decision.reason &&
              decision.route.to === 'room:self' &&
              decision.route.turn.mode !== 'none'
          );
          if (hasRoom && this.#roomPumpStopped)
            throw new Error('Original Room pump admission is stopped.');
          if (hasRoom && !this.#room)
            throw new Error('Room acceptance requires original native construction custody.');
          if (hasRoom) this.#room!.prepare(store, grants, tx);
          // Producer capture callbacks precede the same private currentness gate and every effect.
          if (hasRoom) this.#finalCurrent(store, tx);
          const result = acceptCurrentDocEventInTransaction(ingest, store, this.#authorization, tx);
          if (!retained) scope.acceptedDocSeq = result.receipt.docSeq;
          const response = copyCurrentDocData({
            receipt: result.receipt,
            deliveries: result.deliveries.map(publicCurrentDelivery),
          });
          if (hasRoom) this.#room!.seal(store, tx, readOriginalDocIngestLimits(ingest, store));
          // All writes, status frames and immutable response capture precede private final callback/currentness.
          // Final original row/grant/outbox SQL audits themselves contain no callbacks.
          this.#finalCurrent(store, tx);
          auditCurrentDocIngestRows(ingest, store, this.#authorization, tx);
          if (!retained) auditCurrentDocGrantRows(grants, store, this.#authorization, tx);
          if (hasRoom) {
            this.#room!.audit(store, grants, tx);
            committedTx = tx;
            committedAt = scope.now!;
          }
          return response;
        } catch (cause) {
          this.#room?.abandoned(tx);
          if (!scope.failure) scope.failure = { cause };
          throw scope.failure.cause;
        } finally {
          this.#retireCurrent(tx);
        }
      });
      committed = true;
      if (presenceFocus) {
        const focus = this.#presenceFocusStages.get(presenceFocus);
        if (!focus) throw new Error('Original committed focus stage missing.');
        // Native SQL returned from COMMIT. Retain the actual focus transition before
        // original committed callbacks can fail or reenter; a retry cannot relog it.
        this.#presenceLedger.commit(focus.plan);
      }
      if (committedTx) this.#room!.committed(committedTx, committedAt!);
      return response;
    } catch (cause) {
      if (committedTx) this.#room?.abandoned(committedTx);
      if (!committed && isSqliteStorageError(cause))
        throw new DocIngestRefusal('DOC_EVENT_STORAGE_FAILURE', 507);
      throw cause;
    }
  }
}
/** Fixed implementation factory only; it cannot attach its result to an existing authorization. */
export function createCurrentDocOperationEngine(
  authorization: DocChannelAuthorization,
  db: Db,
  documents: CanvasDocumentStore,
  ports: DocChannelAuthorityPorts,
  scopes: WeakMap<DbTransaction, CurrentOperationScope>
): CurrentDocOperationEngineCore {
  return new CurrentDocOperationEngine(authorization, db, documents, ports, scopes).core();
}
