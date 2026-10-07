import {
  readOriginalRuntimeRegistrySelection,
  readOriginalRegisteredRuntime,
  acquireOriginalRegisteredRuntime,
  releaseOriginalRegisteredRuntime,
  observeOriginalRegisteredRuntimeStream,
  type RuntimeRegistry,
} from '../../../core/runtime-registry.js';
import { DetachedTurnLifecycle } from '../../../session/trigger-turn.js';
import { feedProjector } from '../../../session/session-event-normalizer.js';
import { getOrCreateProjector } from '../../../session/session-state-projector.js';
import { startClaudeCommittedRoomResponder } from '../../../runtimes/claude-code/claude-code-runtime.js';
import { startCodexCommittedRoomResponder } from '../../../runtimes/codex/codex-runtime.js';
import { startOpenCodeCommittedRoomResponder } from '../../../runtimes/opencode/opencode-runtime.js';
import {
  isOriginalNativeTestModeRuntime,
  startTestModeCommittedRoomResponder,
  readTestModeOriginalScenarioEvidence,
  requireTestModeOriginalRoomEmissionClosed,
} from '../../../runtimes/test-mode/test-mode-runtime.js';
import { retireTestModeOriginalRoomResponderStream } from '../../../runtimes/test-mode/test-mode-runtime.js';
import { requireOriginalNativePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import { retireClaudeOriginalRoomResponderStream } from '../../../runtimes/claude-code/claude-code-runtime.js';
import { retireCodexOriginalRoomResponderStream } from '../../../runtimes/codex/codex-runtime.js';
import { retireOpenCodeOriginalRoomResponderStream } from '../../../runtimes/opencode/opencode-runtime.js';
import { buildOriginalRoomPendingSource, projectDurableAcceptedRoomPending } from '../replay.js';
import { readOriginalRoomRowIntention } from '../current/current-operation-intentions.js';
import {
  readOriginalCheckboxCommittedStage,
  requireOriginalCheckboxCompletionCommitted,
} from '../writes/completion.js';
import { validateCheckboxEvidence } from '../writes/checkbox-evidence.js';
import { readOriginalRoomDispatchFacts } from '../../../rooms/service/room-core.js';

import type { SseResponse } from '@dorkos/shared/agent-runtime';

/** Internal original acceptance custody. Copied package data never grants SDK authority. */
const originalRoomPendingCounts = new WeakMap<object, (tx: DbTransaction) => number>();
/** Read only the genuine constructor's sealed write intention, never actual SQL changes. */
export function readOriginalRoomPendingWriteCount(owner: object, tx: DbTransaction): number {
  const read = originalRoomPendingCounts.get(owner);
  if (!read) throw new Error('Room pending count requires original construction.');
  return read(tx);
}
const originalDate = Date;
const originalDateNow = Date.now;
const originalIso = Date.prototype.toISOString;
import { randomUUID } from 'node:crypto';
import {
  sql,
  eq,
  and,
  canvasDocuments,
  canvasDocDeliveries,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import {
  consumeServerNativeRoomConstruction,
  type ServerNativeRoomConstruction,
  type FixedNativeRoomDocFacade,
} from '@dorkos/db/internal-server';

import { readRoomStoreGrantedDocTargetBinding, type RoomStore } from '../../../rooms/room-store.js';
import {
  captureNativePrincipalTime,
  readCurrentNativePrincipalSource,
  requireNativePrincipalDatabase,
  type ConnectorRuntimePrincipalService,
} from '../../../connectors/principal/runtime-principal-service.js';
import {
  readCurrentDocIngressInput,
  requireCurrentDocEngineOrigin,
  type DocChannelAuthorization,
} from '../authorization.js';
import { readCurrentOriginalRoomGrantSource } from '../grant-revalidation.js';
import { readCurrentDocQueueAudit } from '../coalescer.js';
import { protectedCapacityQuery, type DocIngestLimits } from '../current/accounting.js';
import { scanCheckboxReservationPolicies } from '../writes/reservations/reservation-policy-census.js';
import { DocIngestRefusal } from '../ingest-types.js';
import { readCurrentStoreGetBatch } from '../current/current-operation-row-audit.js';
import {
  readDocEventRow,
  resolveCheckboxSqlScope,
} from '../writes/reservations/reservation-policy-census.js';
import { withCheckboxReadOnlyGate } from '../writes/authority-snapshot.js';
import { requireDocChannelStoreDatabase, type DocChannelStore } from '../store.js';
import type { DocChannelGrants } from '../grants.js';
import type {
  OriginalRoomResponderOwnerData,
  OriginalFrozenRoomSource,
  CurrentDocOperationEngineCore,
  FrozenRoomSourceData,
  OriginalCommittedRoomResponder,
  PreparedRoomResponder,
  PendingRoomSource as PendingSource,
  RoomTransactionDraft as TransactionDraft,
  OriginalRoomRouteDraft as RouteDraft,
} from '../current/current-operation-types.js';
import {
  copyCurrentDocData,
  sameCurrentDocData,
  sameOriginalRoomSerializedGrantData,
  copyOriginalRoomSerializedInputData,
} from '../current/current-operation-data.js';

import { OriginalRoomResponderOperation } from './room-responder-operation.js';
export {
  requireOriginalCommittedRoomResponder,
  requireCurrentOriginalCommittedRoomResponder,
  consumeOriginalCommittedRoomResponder,
  retireOriginalCommittedRoomResponder,
} from './room-responder-operation.js';
const originalRoomResponderOwners = new WeakMap<
  CurrentRoomOperation,
  OriginalRoomResponderOwnerData
>();
const originalRoomReplayAvailability = new WeakMap<CurrentRoomOperation, () => boolean>();
/** Read transport availability only from the genuine native helper and its original engine tuple. */
export function readOriginalRoomReplayAvailability(
  helper: CurrentRoomOperation,
  engine: CurrentDocOperationEngineCore,
  db: Db
): boolean {
  const own = originalRoomResponderOwners.get(helper);
  const read = originalRoomReplayAvailability.get(helper);
  if (!own || !read || own.engine !== engine || own.db !== db)
    throw new Error('Room replay transport is not the original native owner.');
  requireCurrentDocEngineOrigin(own.authorization, engine, db);
  requireNativePrincipalDatabase(own.principals, db);
  return read();
}
/** Fixed genuine helper tuple and actual constructor-created delegate, never a supplied registrar. */
export function requireOriginalRoomResponderOwner(
  helper: CurrentRoomOperation,
  delegate: OriginalRoomResponderOperation,
  engine: CurrentDocOperationEngineCore,
  db: Db,
  principals: ConnectorRuntimePrincipalService,
  roomStore: RoomStore,
  facade: FixedNativeRoomDocFacade
): void {
  const own = originalRoomResponderOwners.get(helper);
  if (
    !own ||
    own.delegate !== delegate ||
    own.engine !== engine ||
    own.db !== db ||
    own.principals !== principals ||
    own.roomStore !== roomStore ||
    own.facade !== facade
  )
    throw new Error('Room responder delegate is not original.');
  requireCurrentDocEngineOrigin(own.authorization, engine, db);
  requireNativePrincipalDatabase(principals, db);
}
/** Original frozen WeakMap custody can be read only by the exact captured helper delegate. */
export function readOriginalRoomResponderFrozenSource(
  helper: CurrentRoomOperation,
  delegate: OriginalRoomResponderOperation,
  token: OriginalFrozenRoomSource
): FrozenRoomSourceData {
  const own = originalRoomResponderOwners.get(helper);
  const source = frozenRoomSources.get(token);
  if (
    !own ||
    own.delegate !== delegate ||
    !source ||
    source.engine !== own.engine ||
    source.db !== own.db ||
    source.facade !== own.facade ||
    source.principals !== own.principals
  )
    throw new Error('Room frozen custody is not original.');
  requireOriginalRoomResponderOwner(
    helper,
    delegate,
    own.engine,
    own.db,
    own.principals,
    own.roomStore,
    own.facade
  );
  return source;
}

const originalRoomOperatorSources = new WeakMap<
  object,
  {
    engine: CurrentDocOperationEngineCore;
    db: Db;
    read: () => Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
  }
>();
/** Lookup only: native-confirmed construction custody, never an evidence DTO issuer. */
export function readOriginalRoomOperatorSource(
  token: object,
  engine: CurrentDocOperationEngineCore,
  db: Db
): Readonly<{
  source: Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
  producer: import('../current/current-operation-types.js').OriginalRoomOperatorProducer;
}> {
  const own = originalRoomOperatorSources.get(token);
  if (!own || own.engine !== engine || own.db !== db)
    throw new Error('Foreign original operator source.');
  const source = own.read();
  if (source.producerOrigin !== 'operator' || source.producerBindingId !== null)
    throw new Error('Original source is not an operator acceptance.');
  const producer = JSON.parse(
    source.producerEvidenceJson
  ) as import('../current/current-operation-types.js').OriginalRoomOperatorProducer;
  if (producer.kind !== 'operator') throw new Error('Original operator source tag changed.');
  return Object.freeze({ source, producer });
}

const originalRoomTokenSources = new WeakMap<
  object,
  {
    engine: CurrentDocOperationEngineCore;
    db: Db;
    read: () => Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
  }
>();
/** Exact native confirmed source only; signed token rows/DTOs alone cannot issue Room custody. */
export function readOriginalRoomTokenSource(
  token: object,
  engine: CurrentDocOperationEngineCore,
  db: Db
): Readonly<{
  source: Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
  producer: import('../current/current-operation-types.js').OriginalRoomTokenProducer;
}> {
  const own = originalRoomTokenSources.get(token);
  if (!own || own.engine !== engine || own.db !== db)
    throw new Error('Foreign original token source.');
  const source = own.read();
  if (source.producerOrigin !== 'doc_token' || source.producerBindingId !== null)
    throw new Error('Source is not a native token acceptance.');
  const producer = JSON.parse(
    source.producerEvidenceJson
  ) as import('../current/current-operation-types.js').OriginalRoomTokenProducer;
  if (producer.kind !== 'doc_token') throw new Error('Original token source tag changed.');
  return Object.freeze({ source, producer });
}
const frozenRoomSources = new WeakMap<OriginalFrozenRoomSource, FrozenRoomSourceData>();
/** Fixed original native Room lineage plus the exact granted member/agent/session binding. */
function readCurrentFrozenRoomDestination(own: FrozenRoomSourceData): string {
  const rows = own.facade.readOriginalEmissionTargetBinding(own.source);
  const row = rows.length === 1 ? rows[0] : undefined;
  if (
    !row ||
    row.roomId !== own.source.roomId ||
    row.targetAuthorId !== own.source.targetAuthorId ||
    row.targetAgentId !== own.source.targetAgentId ||
    row.targetRuntime !== own.source.targetRuntime ||
    row.targetAgentPath !== own.source.targetAgentPath ||
    typeof row.targetSessionId !== 'string' ||
    (own.effectiveTargetSessionId !== undefined &&
      own.effectiveTargetSessionId !== row.targetSessionId)
  )
    throw new Error('Original Room canonical destination changed or is unavailable.');
  return row.targetSessionId;
}
/** Data-only original target read. A token is minted only by confirmed native freeze, never a caller DTO. */
export function readOriginalFrozenRoomTarget(token: OriginalFrozenRoomSource, runtime: string) {
  const own = frozenRoomSources.get(token);
  if (!own || own.db.$client.inTransaction || own.source.targetRuntime !== runtime)
    throw new Error('Room preparation requires its original confirmed frozen target.');
  return Object.freeze({
    sessionId: readCurrentFrozenRoomDestination(own),
    agentPath: own.source.targetAgentPath,
    agentId: own.source.targetAgentId,
    runtime: own.source.targetRuntime,
  });
}
/** Exact original constructor principal service; this consumes no copied service/DB permission. */
export function requireOriginalRoomPrincipalService(
  token: OriginalFrozenRoomSource,
  service: object
): void {
  const own = frozenRoomSources.get(token);
  if (!own) throw new Error('Room responder requires its original frozen source.');
  requireOriginalNativePrincipalService(service, own.principals);
}
/** Only an actual engine constructor may retain this object; no scope/identity registration API. */
export class CurrentRoomOperation {
  readonly #facade: FixedNativeRoomDocFacade;
  readonly #drafts = new WeakMap<DbTransaction, TransactionDraft>();
  readonly #pendingLimits = new WeakMap<DbTransaction, Readonly<DocIngestLimits>>();
  readonly #pending = new Map<string, PendingSource>();
  readonly #unavailable = new Set<string>();
  readonly #frozen = new Map<string, OriginalFrozenRoomSource>();
  readonly #relayListeners = new Set<
    (documentId: string, batchId: string, generation: string) => void
  >();
  #pumpClosed = false;
  readonly #pumpWork = new Set<Promise<void>>();
  readonly #pumpHolders = new Set<DetachedTurnLifecycle>();
  readonly #pumpStreams = new Set<AsyncGenerator<import('@dorkos/shared/types').StreamEvent>>();
  #pumpStop: Promise<void> | undefined;
  readonly #pumpScenarioEvidence = new Map<
    string,
    {
      documentId: string;
      batchId: string;
      generation: string;
      sessionId: string;
      runtime?: WeakRef<object>;
      stream?: WeakRef<object>;
      scenarioStarts?: number;
      retired?: boolean;
      operationFailure?: { cause: unknown };
      cleanupClosed?: boolean;
    }
  >();
  /** Exact original source diagnostics only; absent/collected/non-TestMode evidence is UNKNOWN, never zero. */
  readScenarioEvidence(documentId: string, batchId: string, generation: string) {
    const own = this.#pumpScenarioEvidence.get(documentId);
    if (!own || own.batchId !== batchId || own.generation !== generation) return undefined;
    const runtime = own.runtime?.deref(),
      stream = own.stream?.deref();
    const current =
      runtime && stream ? readTestModeOriginalScenarioEvidence(runtime, stream) : undefined;
    const count = current?.scenarioStarts ?? own.scenarioStarts;
    if (count === undefined) return undefined;
    return Object.freeze({
      documentId,
      batchId,
      generation,
      sessionId: own.sessionId,
      scenarioStarts: count,
      retired: current?.retired ?? own.retired,
      operationFailed: own.operationFailure !== undefined,
      cleanupClosed: own.cleanupClosed === true,
    });
  }

  readonly #preparing = new Set<string>();
  readonly #preparationUnknown = new Set<string>();
  readonly #responder: OriginalRoomResponderOperation;
  readonly #db: Db;
  readonly #authorization: DocChannelAuthorization;
  readonly #engine: CurrentDocOperationEngineCore;
  readonly #principals: ConnectorRuntimePrincipalService;
  readonly #roomStore: RoomStore;
  constructor(
    authorization: DocChannelAuthorization,
    engine: CurrentDocOperationEngineCore,
    db: Db,
    principals: ConnectorRuntimePrincipalService,
    roomStore: RoomStore,
    custody: ServerNativeRoomConstruction
  ) {
    requireCurrentDocEngineOrigin(authorization, engine, db);
    requireNativePrincipalDatabase(principals, db);
    this.#facade = consumeServerNativeRoomConstruction(custody, db);
    // The original newly opened native construction owns its boot epoch and synchronous recovery.
    // Refusal/unknown never publishes a responder or reconstructs previous prepared authority.
    const recovery = this.#facade.recoverPreviousBoot();
    if (recovery.state !== 'confirmed')
      throw new Error(`Native Room previous-boot recovery ${recovery.state}; engine unavailable.`);

    this.#authorization = authorization;
    this.#engine = engine;
    this.#db = db;
    this.#principals = principals;
    this.#roomStore = roomStore;
    this.#responder = new OriginalRoomResponderOperation(
      this,
      engine,
      db,
      principals,
      roomStore,
      this.#facade
    );
    originalRoomResponderOwners.set(this, {
      delegate: this.#responder,
      authorization,
      engine,
      db,
      principals,
      roomStore,
      facade: this.#facade,
    });
    originalRoomPendingCounts.set(this, (tx) => this.#drafts.get(tx)?.sealed?.length ?? 0);
    this.#reacquirePendingUnclaimed();
    this.#reacquireAcceptedUnclaimed();
    originalRoomReplayAvailability.set(this, () => !this.#pumpClosed);
  }
  #reacquirePendingUnclaimed(): void {
    let cursorAt = '',
      cursorId = '';
    for (;;) {
      const selected = this.#facade.scanPendingUnclaimed(cursorAt, cursorId);
      if (selected.length > 100) throw new Error('Unbounded original pending scan.');
      for (const row of selected) {
        if (
          typeof row.document_id !== 'string' ||
          typeof row.batch_id !== 'string' ||
          typeof row.generation !== 'string' ||
          typeof row.updated_at !== 'string'
        )
          throw new Error('Malformed pending source selector.');
        const selector = {
          documentId: row.document_id,
          batchId: row.batch_id,
          generation: row.generation,
        };
        // Scanned fields select only. This constructor-owned native capability issues source custody.
        const result = this.#facade.reacquirePendingUnclaimedSource(selector);
        if (result.state !== 'confirmed')
          throw new Error(`Pending-unclaimed reacquisition ${result.state}; source unavailable.`);
        const source = this.#facade.readReacquiredPendingSource(result.value);
        const pending = projectDurableAcceptedRoomPending(source);
        if (source.producerOrigin === 'operator') {
          originalRoomOperatorSources.set(result.value, {
            engine: this.#engine,
            db: this.#db,
            read: () => this.#facade.readReacquiredPendingSource(result.value),
          });
          this.#engine.requireRoomOperatorSource(result.value);
        } else if (source.producerOrigin === 'doc_token') {
          originalRoomTokenSources.set(result.value, {
            engine: this.#engine,
            db: this.#db,
            read: () => this.#facade.readReacquiredPendingSource(result.value),
          });
          // Native retained token identity is historical DATA; live token permission is repeated at freeze/prepare/commit.
        } else {
          const historical = this.#facade.readOriginalRuntimeBinding(source.producerBindingId);
          if (!historical) throw new Error('Original producer history is unavailable.');
          // Historical identity survives retirement; it is never an active producer principal.
          for (const key of [
            'id',
            'bootEpoch',
            'ownerKind',
            'ownerId',
            'runtime',
            'canonicalSessionId',
            'agentId',
            'agentPath',
            'canonicalCwd',
            'tokenHash',
            'createdAt',
            'expiresAt',
          ]) {
            const sqlKey = key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
            if (historical[sqlKey] !== (pending.producer as Record<string, unknown>)[key])
              throw new Error('Original producer history does not match durable source.');
          }
        }
        // Current document, grants, roster, destination and new native lock are repeated at real prepare/commit/start.
        this.#facade.readReacquiredPendingSource(result.value);
        this.#pending.set(`${selector.batchId}:${selector.generation}`, pending);
      }
      if (selected.length < 100) break;
      const last = selected[selected.length - 1];
      const nextAt = String(last.updated_at),
        nextId = String(last.batch_id);
      if (nextAt < cursorAt || (nextAt === cursorAt && nextId <= cursorId))
        throw new Error('Pending source cursor did not advance.');
      cursorAt = nextAt;
      cursorId = nextId;
    }
  }
  #reacquireAcceptedUnclaimed(): void {
    let cursorAt = '',
      cursorId = '';
    for (;;) {
      const selected = this.#facade.scanAcceptedUnclaimed(cursorAt, cursorId);
      if (selected.length > 100) throw new Error('Unbounded original accepted scan.');
      for (const row of selected) {
        if (
          typeof row.document_id !== 'string' ||
          typeof row.batch_id !== 'string' ||
          typeof row.generation !== 'string' ||
          typeof row.updated_at !== 'string'
        )
          throw new Error('Malformed accepted source selector.');
        const selector = {
          documentId: row.document_id,
          batchId: row.batch_id,
          generation: row.generation,
        };
        // Scanned fields select only. This constructor-owned native capability issues source custody.
        const result = this.#facade.reacquireAcceptedUnclaimedSource(selector);
        if (result.state !== 'confirmed')
          throw new Error(`Accepted-unclaimed reacquisition ${result.state}; source unavailable.`);
        const source = this.#facade.readReacquiredAcceptedSource(result.value);
        const pending = projectDurableAcceptedRoomPending(source);
        if (source.producerOrigin === 'operator') {
          originalRoomOperatorSources.set(result.value, {
            engine: this.#engine,
            db: this.#db,
            read: () => this.#facade.readReacquiredAcceptedSource(result.value),
          });
          this.#engine.requireRoomOperatorSource(result.value);
        } else if (source.producerOrigin === 'doc_token') {
          originalRoomTokenSources.set(result.value, {
            engine: this.#engine,
            db: this.#db,
            read: () => this.#facade.readReacquiredAcceptedSource(result.value),
          });
          this.#engine.requireRoomTokenSource(result.value);
        } else {
          const historical = this.#facade.readOriginalRuntimeBinding(source.producerBindingId);
          if (!historical) throw new Error('Original producer history is unavailable.');
          // Historical identity survives retirement; it is never an active producer principal.
          for (const key of [
            'id',
            'bootEpoch',
            'ownerKind',
            'ownerId',
            'runtime',
            'canonicalSessionId',
            'agentId',
            'agentPath',
            'canonicalCwd',
            'tokenHash',
            'createdAt',
            'expiresAt',
          ]) {
            const sqlKey = key.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
            if (historical[sqlKey] !== (pending.producer as Record<string, unknown>)[key])
              throw new Error('Original producer history does not match durable source.');
          }
        }
        // Current document, grants, roster, destination and new native lock are repeated at real prepare/commit/start.
        this.#facade.readReacquiredAcceptedSource(result.value);
        this.#retainConfirmedFreeze(pending, selector);
      }
      if (selected.length < 100) break;
      const last = selected[selected.length - 1];
      const nextAt = String(last.updated_at),
        nextId = String(last.batch_id);
      if (nextAt < cursorAt || (nextAt === cursorAt && nextId <= cursorId))
        throw new Error('Accepted source cursor did not advance.');
      cursorAt = nextAt;
      cursorId = nextId;
    }
  }
  /** Native maintenance only: package-owned cutoff and guard, never actor/time DTO authority. */
  pruneSettledReceipts(): void {
    requireOriginalRoomResponderOwner(
      this,
      this.#responder,
      this.#engine,
      this.#db,
      this.#principals,
      this.#roomStore,
      this.#facade
    );
    if (this.#db.$client.inTransaction) throw new Error('Native Room pruning cannot nest.');
    const outcome = this.#facade.pruneSettledRoomReceipts();
    if (outcome.state !== 'confirmed')
      throw new Error(
        `Native Room receipt pruning ${outcome.state}; ordinary retention was not started.`
      );
  }
  prepare(store: DocChannelStore, grants: DocChannelGrants, tx: DbTransaction): void {
    requireCurrentDocEngineOrigin(this.#authorization, this.#engine, this.#db);
    requireDocChannelStoreDatabase(store, this.#db);
    if (this.#drafts.has(tx)) throw new Error('Original Room source preparation is one-use.');
    const input = readCurrentDocIngressInput(this.#authorization, store, tx);
    const routes = new Map<string, RouteDraft>();
    this.#drafts.set(tx, { store, eventId: input.event.id, routes });
    for (const decision of input.access?.routes ?? []) {
      if (
        decision.reason ||
        decision.route.to !== 'room:self' ||
        decision.route.turn.mode === 'none'
      )
        continue;
      // The actual captured ingress actor is the producer; a destination turn never substitutes.
      const tokenProducer = input.tokenScope
        ? this.#engine.captureRoomTokenProducer(store, tx)
        : undefined;
      const operator =
        input.actor?.principal.claims.kind === 'operator'
          ? this.#engine.captureRoomOperatorProducer(store, tx)
          : undefined;
      if (!operator && !tokenProducer && input.actor?.principal.claims.kind !== 'runtime')
        throw new Error('Original Room producer is unsupported.');
      const time =
        operator || tokenProducer
          ? undefined
          : withCheckboxReadOnlyGate(this.#db, () =>
              captureNativePrincipalTime(this.#principals, this.#db, input.actor!.principal)
            );
      if (!operator && !tokenProducer && time === undefined)
        throw new Error('Original runtime principal time unavailable.');
      const producerSource =
        operator || tokenProducer || time === undefined
          ? undefined
          : readCurrentNativePrincipalSource(
              this.#principals,
              this.#db,
              input.actor!.principal,
              tx,
              time
            );
      if (!operator && !tokenProducer && !producerSource)
        throw new Error('Room source requires its genuine live producer acquisition.');
      const producer = tokenProducer ?? operator ?? producerSource!.binding;
      const roomCustody = producerSource?.roomCustody;
      const original = readCurrentOriginalRoomGrantSource(
        grants,
        store,
        this.#authorization,
        tx,
        decision.route.id
      );
      const grant = original.grant;
      const serializedGrant = tx.get<{ route: string; limits: string; evidence: string }>(sql`
        SELECT normalized_route AS route,limits AS limits,approval_evidence AS evidence
        FROM canvas_doc_grants WHERE grant_id=${grant.grantId}`);
      if (!sameOriginalRoomSerializedGrantData(serializedGrant, grant))
        throw new Error('Original Room serialized grant differs from its private claims.');
      const canonical = resolveCheckboxSqlScope(tx, `session:${grant.targetSessionId}`);
      if (!canonical.startsWith('session:')) throw new Error('Room target session is unavailable.');
      const target = readRoomStoreGrantedDocTargetBinding(
        this.#roomStore,
        this.#db,
        input.scope.slice('room:'.length),
        grant.targetAgentId!,
        canonical.slice('session:'.length),
        grant.targetRuntime!
      );
      if (!target)
        throw new Error('Room target lacks its actual stored membership/session binding.');
      const physical = tx
        .select()
        .from(canvasDocuments)
        .where(eq(canvasDocuments.id, input.documentId))
        .get();
      if (!physical || physical.scope !== input.scope)
        throw new Error('Original Room physical source changed.');
      const producerRoomFacts = roomCustody
        ? readOriginalRoomDispatchFacts(roomCustody, this.#db)
        : undefined;
      if (roomCustody && !producerRoomFacts)
        throw new Error(
          'Original Room producer lost its actual request/root custody before acceptance.'
        );
      const before = readOriginalRoomRowIntention(
        tx,
        input.documentId,
        grant.grantId,
        original.approval.id
      );
      routes.set(decision.route.id, {
        before,
        producerRoomFacts: producerRoomFacts ? copyCurrentDocData(producerRoomFacts) : undefined,
        roomCustody,
        original,
        serializedGrant: copyCurrentDocData(serializedGrant),
        physical: copyCurrentDocData(physical),
        producer: copyCurrentDocData(producer),
        target: copyCurrentDocData(target),
        admissionId: randomUUID(),
      });
    }
  }
  /** Capture replay custody from the original expired rows before any replay effect. */
  prepareReplay(
    store: DocChannelStore,
    grants: DocChannelGrants,
    tx: DbTransaction,
    previousBatchId: string,
    now: string
  ): import('../store.js').DocBatchRow {
    const input = readCurrentDocIngressInput(this.#authorization, store, tx);
    if (
      !input.scope.startsWith('room:') ||
      input.actor?.principal.claims.kind !== 'operator' ||
      input.now !== now
    )
      throw new Error('Room replay requires its original current operator and clock.');
    const old = readCurrentStoreGetBatch(tx, previousBatchId);
    if (
      !old ||
      old.documentId !== input.documentId ||
      old.scope !== input.scope ||
      old.status !== 'expired' ||
      old.errorCode === 'manual_replay_consumed' ||
      old.inputEventIds.length < 1 ||
      old.inputEventIds.length > 400 ||
      new Set(old.inputEventIds).size !== old.inputEventIds.length ||
      old.inputEventIds[0] !== input.event.id ||
      old.admissionReceiptId !== null ||
      old.turnId !== null ||
      old.relayMessageId !== null ||
      old.leaseUntil !== null ||
      old.deliveryKind === 'room_app_event' ||
      old.roomAdmissionId !== null ||
      old.roomSourceAttempt !== null ||
      old.roomSourceJson !== null ||
      old.roomSourceHash !== null ||
      tx.get(
        sql`SELECT 1 FROM room_doc_admissions WHERE document_id=${input.documentId} AND batch_id=${old.batchId} LIMIT 1`
      ) ||
      tx.get(
        sql`SELECT 1 FROM session_message_acceptance_receipts WHERE source_kind='document_event_batch' AND source_id=${old.batchId} LIMIT 1`
      )
    )
      throw new Error('Original Room replay source is unavailable.');
    const previousKey = `${old.batchId}:${old.generation}`;
    if (
      this.#unavailable.has(previousKey) ||
      this.#frozen.has(previousKey) ||
      this.#preparing.has(previousKey) ||
      this.#preparationUnknown.has(previousKey)
    )
      throw new Error('Original Room replay source is already acquired or uncertain.');
    const deliveries = tx
      .select()
      .from(canvasDocDeliveries)
      .where(
        and(
          eq(canvasDocDeliveries.documentId, input.documentId),
          eq(canvasDocDeliveries.batchId, old.batchId)
        )
      )
      .orderBy(canvasDocDeliveries.eventId, canvasDocDeliveries.routeId)
      .limit(401)
      .all();
    if (
      deliveries.length !== old.inputEventIds.length ||
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
      throw new Error('Original Room replay deliveries are unavailable.');
    this.prepare(store, grants, tx);
    const draft = this.#drafts.get(tx)!;
    const route = draft.routes.get(old.routeId);
    if (draft.routes.size !== 1 || !route)
      throw new Error('Room replay requires exactly its selected original route.');
    const batch: import('../store.js').DocBatchRow = {
      batchId: randomUUID(),
      documentId: input.documentId,
      scope: input.scope,
      routeId: old.routeId,
      grantId: route.original.grant.grantId,
      grantRevision: route.original.grant.revision,
      generation: randomUUID(),
      inputEventIds: [...old.inputEventIds],
      effectivePayload: { eventIds: [...old.inputEventIds] },
      dueAt: now,
      status: 'pending',
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
    const inputs = old.inputEventIds.map((id) => {
      const original = readDocEventRow(tx, input.documentId, id);
      const delivery = deliveries.find((row) => row.eventId === id)!;
      if (!original || original.direction !== 'upstream' || original.payloadPrunedAt !== null)
        throw new Error('Original Room replay input is unavailable.');
      return {
        original,
        delivery: {
          ...delivery,
          batchId: batch.batchId,
          status: 'pending' as const,
          reason: null,
          updatedAt: now,
        },
      };
    });
    draft.replay = {
      previousKey,
      previousPending: this.#pending.get(previousKey),
      intention: copyCurrentDocData({ batch, delivery: inputs[0]!.delivery, inputs }),
    };
    return copyCurrentDocData(batch);
  }
  seal(store: DocChannelStore, tx: DbTransaction, limits: DocIngestLimits): void {
    const input = readCurrentDocIngressInput(this.#authorization, store, tx);
    const draft = this.#drafts.get(tx);
    if (!draft || draft.store !== store || draft.eventId !== input.event.id || draft.sealed)
      throw new Error('Original Room source transaction is foreign or already sealed.');
    const event = readDocEventRow(tx, input.documentId, input.event.id);
    if (!event) throw new Error('Original Room input is absent.');
    const queue = draft.replay
      ? [draft.replay.intention]
      : readCurrentDocQueueAudit(store, tx, event);
    if (draft.replay) {
      const intended = draft.replay.intention;
      if (
        !intended.batch ||
        !intended.inputs ||
        !sameCurrentDocData(intended.batch, readCurrentStoreGetBatch(tx, intended.batch.batchId))
      )
        throw new Error('Original Room replay batch differs from its pre-effect source.');
      const actual = tx
        .select()
        .from(canvasDocDeliveries)
        .where(
          and(
            eq(canvasDocDeliveries.documentId, input.documentId),
            eq(canvasDocDeliveries.batchId, intended.batch.batchId)
          )
        )
        .orderBy(canvasDocDeliveries.eventId, canvasDocDeliveries.routeId)
        .limit(401)
        .all();
      const expected = intended.inputs
        .map((pair) => pair.delivery)
        .sort((a, b) => a.eventId.localeCompare(b.eventId) || a.routeId.localeCompare(b.routeId));
      if (
        !sameCurrentDocData(actual, expected) ||
        intended.inputs.some(
          (pair) =>
            !sameCurrentDocData(
              pair.original,
              readDocEventRow(tx, input.documentId, pair.original.eventId)
            )
        )
      )
        throw new Error('Original Room replay rows differ from their pre-effect source.');
    }
    const prepared: PendingSource[] = [];
    for (const [routeId, route] of draft.routes) {
      const intended = queue.find((candidate) => candidate.delivery.routeId === routeId);
      if (!intended?.batch || !intended.inputs) continue; // Saved/refused input is not a Room acceptance.
      const batch = intended.batch;
      const key = `${batch.batchId}:${batch.generation}`;
      if (this.#unavailable.has(key)) throw new Error('Original Room acceptance is uncertain.');
      const previous = this.#pending.get(key);
      const priorIds = intended.inputs
        .filter((pair) => pair.original.eventId !== event.eventId)
        .map((pair) => pair.original.eventId);
      if (
        !draft.replay &&
        priorIds.length &&
        (!previous ||
          priorIds.some((id) => !previous.source.inputs.some((old) => old.eventId === id)))
      )
        throw new Error('Existing Room batch lacks original committed producer custody.');
      if (
        previous &&
        (previous.roomCustody !== route.roomCustody ||
          !sameCurrentDocData(previous.before, route.before) ||
          !sameCurrentDocData(
            previous.producerRoomFacts ?? null,
            route.producerRoomFacts ?? null
          ) ||
          !sameCurrentDocData(previous.producer, route.producer) ||
          previous.source.grantId !== route.original.grant.grantId ||
          previous.source.grantRevision !== route.original.grant.revision ||
          previous.dueAt !== batch.dueAt)
      )
        throw new Error('Original Room generation/producer/deadline changed.');
      const inputs = intended.inputs.map(({ original, delivery }) => {
        const raw = tx.get<{ payload: string; provenance: string; evidence: string | null }>(sql`
          SELECT e.payload AS payload,e.provenance AS provenance,d.ack_evidence AS evidence
          FROM canvas_doc_events e JOIN canvas_doc_deliveries d
          ON d.document_id=e.document_id AND d.event_id=e.event_id
          WHERE e.document_id=${batch.documentId} AND e.event_id=${original.eventId} AND d.route_id=${routeId}`);
        return copyOriginalRoomSerializedInputData(raw, original, delivery);
      });
      const rawBatch = tx.get<{ ids: string; payload: string }>(sql`SELECT input_event_ids AS ids,
        effective_payload AS payload FROM canvas_doc_batches WHERE batch_id=${batch.batchId}`);
      if (
        !rawBatch ||
        !sameCurrentDocData(JSON.parse(rawBatch.ids), batch.inputEventIds) ||
        !sameCurrentDocData(JSON.parse(rawBatch.payload), batch.effectivePayload)
      )
        throw new Error('Room serialized batch differs from its pre-effect intention.');
      const pending = buildOriginalRoomPendingSource(
        route,
        batch,
        previous,
        intended.inputs,
        inputs,
        rawBatch,
        routeId
      );
      if (pending.source.originalSourceJson.length > 1_048_576)
        throw new Error('Original pending Room capsule exceeds the native source bound.');
      const old = tx.get<Record<string, unknown>>(sql`SELECT * FROM canvas_doc_room_pending_sources
        WHERE document_id=${batch.documentId} AND batch_id=${batch.batchId} AND generation=${batch.generation}`);
      if (previous ? !sameCurrentDocData(old, this.#pendingCapsule(previous)) : old !== undefined)
        throw new Error('Original pending Room capsule differs from committed custody.');
      const changesBefore = tx.get<{ total: number }>(sql`SELECT total_changes() AS total`)!.total;
      const changed = previous
        ? tx.run(sql`UPDATE canvas_doc_room_pending_sources SET source_json=${pending.source.originalSourceJson},
            source_hash=${pending.source.originalSourceHash},updated_at=${pending.source.originalUpdatedAt}
            WHERE document_id=${batch.documentId} AND batch_id=${batch.batchId} AND generation=${batch.generation}
            AND source_json=${previous.source.originalSourceJson} AND source_hash=${previous.source.originalSourceHash}
            AND due_at=${previous.dueAt} AND updated_at=${previous.source.originalUpdatedAt}`)
        : tx.run(sql`INSERT INTO canvas_doc_room_pending_sources
            (document_id,batch_id,generation,source_json,source_hash,due_at,updated_at) VALUES
            (${batch.documentId},${batch.batchId},${batch.generation},${pending.source.originalSourceJson},
             ${pending.source.originalSourceHash},${pending.dueAt},${pending.source.originalUpdatedAt})`);
      const changesAfter = tx.get<{ total: number }>(sql`SELECT total_changes() AS total`)!.total;
      if (
        changed.changes !== 1 ||
        !Number.isSafeInteger(changesBefore) ||
        changesAfter - changesBefore !== 1 ||
        !sameCurrentDocData(
          this.#pendingCapsule(pending),
          tx.get(sql`SELECT * FROM canvas_doc_room_pending_sources
            WHERE document_id=${batch.documentId} AND batch_id=${batch.batchId} AND generation=${batch.generation}`)
        )
      )
        throw new Error('Original pending Room capsule write changed outside its intended row.');
      prepared.push(pending);
    }
    this.#pendingLimits.set(tx, Object.freeze({ ...limits }));
    this.#checkPendingCapacity(tx, input.documentId, limits);
    draft.sealed = Object.freeze(prepared);
  }
  #checkPendingCapacity(tx: DbTransaction, documentId: string, limits: DocIngestLimits) {
    const usage = tx.get<{ count: number; bytes: number }>(protectedCapacityQuery(documentId))!;
    const installation = tx.get<{ bytes: number }>(protectedCapacityQuery())!;
    const reservations = scanCheckboxReservationPolicies(tx, { documentId });
    if (
      usage.count + reservations.document.originals > limits.pendingEvents ||
      usage.bytes + reservations.document.bytes > limits.pendingBytes ||
      installation.bytes + reservations.installation.bytes > limits.installationPendingBytes
    )
      throw new DocIngestRefusal('DOC_EVENT_BACKLOG_FULL', 429, 60);
  }
  #pendingCapsule(pending: PendingSource) {
    return {
      document_id: pending.source.documentId,
      batch_id: pending.source.batchId,
      generation: pending.source.generation,
      source_json: pending.source.originalSourceJson,
      source_hash: pending.source.originalSourceHash,
      due_at: pending.dueAt,
      updated_at: pending.source.originalUpdatedAt,
    };
  }
  audit(store: DocChannelStore, grants: DocChannelGrants, tx: DbTransaction): void {
    const input = readCurrentDocIngressInput(this.#authorization, store, tx);
    const draft = this.#drafts.get(tx);
    if (!draft?.sealed || draft.store !== store || draft.eventId !== input.event.id)
      throw new Error('Original Room exit lacks its sealed scope.');
    for (const pending of draft.sealed) {
      const source = pending.source;
      if (
        !sameCurrentDocData(
          this.#pendingCapsule(pending),
          tx.get(sql`SELECT * FROM canvas_doc_room_pending_sources
          WHERE document_id=${source.documentId} AND batch_id=${source.batchId} AND generation=${source.generation}`)
        )
      )
        throw new Error('Original pending Room capsule changed before commit.');
    }
    // Fixed same-Db SQL only, after all configured callbacks and before outer commit.
    for (const [routeId, route] of draft.routes) {
      const original = readCurrentOriginalRoomGrantSource(
        grants,
        store,
        this.#authorization,
        tx,
        routeId
      );
      const target = readRoomStoreGrantedDocTargetBinding(
        this.#roomStore,
        this.#db,
        route.target.roomId,
        route.target.targetAgentId,
        route.target.targetSessionId,
        route.target.targetRuntime
      );
      if (
        'kind' in route.producer &&
        !sameCurrentDocData(
          route.producer,
          route.producer.kind === 'doc_token'
            ? this.#engine.captureRoomTokenProducer(store, tx)
            : this.#engine.captureRoomOperatorProducer(store, tx)
        )
      )
        throw new Error('Original operator producer changed before commit.');
      const before = readOriginalRoomRowIntention(
        tx,
        input.documentId,
        original.grant.grantId,
        original.approval.id
      );
      if (
        !sameCurrentDocData(route.before, before) ||
        !sameCurrentDocData(route.original, original) ||
        !sameCurrentDocData(route.target, target)
      )
        throw new Error('Original Room grant/approval/target changed before commit.');
    }
    const limits = this.#pendingLimits.get(tx);
    if (!limits) throw new Error('Original pending Room limits are absent.');
    this.#checkPendingCapacity(tx, input.documentId, limits);
  }
  /** Original frozen target is selected privately; neither caller IDs nor a copied key issue source custody. */
  async prepareResponder(
    runtime: object,
    holder: SseResponse,
    key: string
  ): Promise<import('../current/current-operation-types.js').PreparedRoomResponder | undefined> {
    if (this.#db.$client.inTransaction)
      throw new Error('Room preparation requires inactive own Db.');
    const pair = [...this.#frozen]
      .filter(
        ([id, token]) =>
          !this.#preparing.has(id) &&
          !this.#preparationUnknown.has(id) &&
          readCurrentFrozenRoomDestination(frozenRoomSources.get(token)!) === key
      )
      .sort((a, b) => {
        const left = frozenRoomSources.get(a[1])!,
          right = frozenRoomSources.get(b[1])!;
        return left.dueAt.localeCompare(right.dueAt) || a[0].localeCompare(b[0]);
      })[0];
    if (!pair) return undefined;
    return this.#prepareFrozenResponder(runtime, holder, key, pair);
  }
  async #prepareFrozenResponder(
    runtime: object,
    holder: SseResponse,
    key: string,
    pair: readonly [string, OriginalFrozenRoomSource]
  ): Promise<PreparedRoomResponder | undefined> {
    const [id, token] = pair,
      own = frozenRoomSources.get(token);
    if (
      !own ||
      this.#frozen.get(id) !== token ||
      this.#preparing.has(id) ||
      this.#preparationUnknown.has(id) ||
      this.#db.$client.inTransaction ||
      readCurrentFrozenRoomDestination(own) !== key
    )
      return undefined;
    if (own.engine !== this.#engine || own.db !== this.#db || own.facade !== this.#facade)
      throw new Error('Original frozen Room source is foreign.');
    // Bind this attempt. Successful preparation consumes the frozen token; thrown setup stays
    // fenced as UNKNOWN. Only a known no-preparation result can choose a new destination later.
    own.effectiveTargetSessionId = key;
    this.#preparing.add(id);
    let prepared: import('../current/current-operation-types.js').PreparedRoomResponder | undefined;
    try {
      prepared = await this.#responder.prepare(runtime, holder, key, token);
      if (!prepared) return undefined;
      if (
        this.#frozen.get(id) !== token ||
        frozenRoomSources.get(token) !== own ||
        this.#db.$client.inTransaction
      )
        throw new Error('Prepared Room responder lost its original native/source custody.');
      this.#responder.requirePreparedSource(runtime, prepared, token);
      this.#frozen.delete(id);
      return prepared;
    } catch (cause) {
      this.#preparationUnknown.add(id); // Setup/cleanup uncertainty never becomes automatic retry.
      if (prepared) {
        try {
          await this.#responder.retirePrepared(runtime, prepared);
        } catch {} // Preserve the original cause, including thrown undefined; work stays fenced.
      }
      throw cause;
    } finally {
      if (!prepared && !this.#preparationUnknown.has(id)) own.effectiveTargetSessionId = undefined;
      this.#preparing.delete(id);
    }
  }
  /** Owned due pump: fixed source selection, real lock acquisition, native claim/FIRST then same-entry stream. */
  pump(registry: RuntimeRegistry): Promise<void> {
    if (this.#pumpClosed) return Promise.resolve();
    // Own the continuation before its first native call or observable setup.
    const work = Promise.resolve().then(() => this.#runPump(registry));
    this.#pumpWork.add(work);
    void work.then(
      () => this.#pumpWork.delete(work),
      () => this.#pumpWork.delete(work)
    );
    return work;
  }
  stopPump(): Promise<void> {
    if (this.#pumpStop) return this.#pumpStop;
    this.#pumpClosed = true;
    this.#relayListeners.clear();
    let resolve!: () => void, reject!: (cause: unknown) => void;
    this.#pumpStop = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let failed = false,
      first: unknown;
    const pending: Promise<unknown>[] = [];
    for (const holder of this.#pumpHolders) {
      try {
        holder.close();
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    }
    for (const stream of this.#pumpStreams) {
      try {
        pending.push(stream.return(undefined));
      } catch (cause) {
        if (!failed) {
          failed = true;
          first = cause;
        }
      }
    }
    const admitted = [...this.#pumpWork];
    void (async () => {
      for (const result of await Promise.allSettled([...pending, ...admitted]))
        if (result.status === 'rejected' && !failed) {
          failed = true;
          first = result.reason;
        }
      if (failed) throw first;
    })().then(resolve, reject);
    return this.#pumpStop;
  }
  async #runPump(registry: RuntimeRegistry): Promise<void> {
    const sources = [...this.#frozen.entries()].sort((a, b) => {
      const left = frozenRoomSources.get(a[1])!,
        right = frozenRoomSources.get(b[1])!;
      return left.dueAt.localeCompare(right.dueAt) || a[0].localeCompare(b[0]);
    });
    for (const [id, source] of sources) {
      if (this.#pumpClosed) break;
      if (
        this.#frozen.get(id) !== source ||
        this.#preparing.has(id) ||
        this.#preparationUnknown.has(id)
      )
        continue;
      const original = frozenRoomSources.get(source);
      if (
        !original ||
        original.engine !== this.#engine ||
        original.db !== this.#db ||
        original.facade !== this.#facade
      )
        throw new Error('Due pump lacks original frozen custody.');
      const target = original.source;
      const effectiveTargetSessionId = readCurrentFrozenRoomDestination(original);
      const selected = readOriginalRuntimeRegistrySelection(
        registry,
        this.#db,
        target.targetRuntime
      );
      if (!selected) continue; // No model or source loss for known pre-effect unavailable selection.
      const holder = new DetachedTurnLifecycle();
      this.#pumpHolders.add(holder);
      const clientId = `original-doc-room:${target.admissionId}`,
        lockToken = Symbol(clientId);
      let acquired = false;
      let prepared: PreparedRoomResponder | undefined;
      let stream: AsyncGenerator<import('@dorkos/shared/types').StreamEvent> | undefined;
      let failed = false,
        first: unknown;
      let cleanupFailed = false;
      const cleanup = async (work: () => unknown | Promise<unknown>) => {
        try {
          await work();
        } catch (cause) {
          cleanupFailed = true;
          if (!failed) {
            failed = true;
            first = cause;
          }
        }
      };
      try {
        acquired = acquireOriginalRegisteredRuntime(
          selected,
          effectiveTargetSessionId,
          clientId,
          holder,
          lockToken
        );
        if (acquired) {
          if (this.#pumpClosed) throw new Error('Original due pump closed during acquisition.');
          prepared = await this.#prepareFrozenResponder(
            selected,
            holder,
            effectiveTargetSessionId,
            [id, source]
          );
          if (prepared) {
            if (this.#pumpClosed) throw new Error('Original due pump closed before claim.');
            if (!readOriginalRegisteredRuntime(selected))
              throw new Error('Original due runtime selection retired.');
            if (frozenRoomSources.get(source) !== original)
              throw new Error('Original due source changed during preparation.');
            this.#responder.requirePreparedSource(selected, prepared, source);
            const committed = this.commitResponder(selected, prepared);
            const raw = readOriginalRegisteredRuntime(selected);
            if (!raw) throw new Error('Original due runtime selection retired after claim.');
            this.#responder.requirePreparedSource(selected, prepared, source);
            stream = isOriginalNativeTestModeRuntime(raw)
              ? startTestModeCommittedRoomResponder(raw, prepared, committed)
              : target.targetRuntime === 'claude-code'
                ? startClaudeCommittedRoomResponder(raw, prepared, committed)
                : target.targetRuntime === 'codex'
                  ? startCodexCommittedRoomResponder(raw, prepared, committed)
                  : startOpenCodeCommittedRoomResponder(raw, prepared, committed);
            this.#pumpStreams.add(stream);
            if (isOriginalNativeTestModeRuntime(raw))
              this.#pumpScenarioEvidence.set(target.documentId, {
                documentId: target.documentId,
                batchId: target.batchId,
                generation: target.generation,
                sessionId: effectiveTargetSessionId,
                runtime: new WeakRef(raw),
                stream: new WeakRef(stream),
              });
            const observed = observeOriginalRegisteredRuntimeStream(
              selected,
              effectiveTargetSessionId,
              stream
            );
            await feedProjector(
              getOrCreateProjector(effectiveTargetSessionId, target.targetAgentPath),
              observed,
              { originalRoomStream: stream }
            );
          }
        }
      } catch (cause) {
        failed = true;
        first = cause;
        const diagnostic = this.#pumpScenarioEvidence.get(target.documentId);
        if (
          diagnostic &&
          diagnostic.batchId === target.batchId &&
          diagnostic.generation === target.generation &&
          !diagnostic.operationFailure
        )
          diagnostic.operationFailure = { cause };
      } finally {
        await cleanup(() => stream?.return(undefined));
        // Original prepared cleanup is idempotent only for this actual native tuple.
        if (prepared) await cleanup(() => this.#responder.retirePrepared(selected, prepared!));
        if (acquired)
          await cleanup(() =>
            releaseOriginalRegisteredRuntime(
              selected,
              effectiveTargetSessionId,
              clientId,
              lockToken
            )
          );
        await cleanup(() => holder.close());
        if (stream) this.#pumpStreams.delete(stream);
        const diagnostic = this.#pumpScenarioEvidence.get(target.documentId);
        const originalRuntime = diagnostic?.runtime?.deref();
        if (
          diagnostic &&
          diagnostic.batchId === target.batchId &&
          diagnostic.generation === target.generation &&
          stream &&
          originalRuntime
        ) {
          const actual = readTestModeOriginalScenarioEvidence(originalRuntime, stream);
          if (actual) {
            diagnostic.scenarioStarts = actual.scenarioStarts;
            diagnostic.retired = actual.retired;
          }
          diagnostic.runtime = undefined;
          diagnostic.stream = undefined;
        }
        this.#pumpHolders.delete(holder);
      }
      if (failed && !cleanupFailed && stream && prepared && acquired) {
        const raw = readOriginalRegisteredRuntime(selected);
        if (raw && isOriginalNativeTestModeRuntime(raw)) {
          // A refused original emission is operational DATA only after actual
          // stream/prepared/acquisition/holder drains and native child closure.
          // UNKNOWN, missing evidence and all non-TestMode failures still throw.
          const diagnostic = this.#pumpScenarioEvidence.get(target.documentId);
          try {
            requireTestModeOriginalRoomEmissionClosed(raw, stream, this.#db);
            if (
              !diagnostic ||
              diagnostic.batchId !== target.batchId ||
              diagnostic.generation !== target.generation ||
              diagnostic.scenarioStarts !== 1 ||
              diagnostic.retired !== true
            )
              throw new Error('Original closed Room refusal evidence missing');
            diagnostic.operationFailure = { cause: first };
            diagnostic.cleanupClosed = true;
            failed = false;
          } catch {
            /* Original operational cause remains first; closure is not established. */
          }
        }
      }
      if (!failed && !cleanupFailed && stream && prepared && acquired) {
        const raw = readOriginalRegisteredRuntime(selected);
        if (raw && isOriginalNativeTestModeRuntime(raw)) {
          // Successful turns need the same positive native closure witness as refusals.
          // All owned stream/prepared/acquisition/holder cleanup has settled above.
          requireTestModeOriginalRoomEmissionClosed(raw, stream, this.#db);
          const diagnostic = this.#pumpScenarioEvidence.get(target.documentId);
          if (
            !diagnostic ||
            diagnostic.batchId !== target.batchId ||
            diagnostic.generation !== target.generation ||
            diagnostic.scenarioStarts !== 1 ||
            diagnostic.retired !== true
          )
            throw new Error('Original successful Room closure evidence missing');
          diagnostic.cleanupClosed = true;
        }
      }
      if (failed) throw first;
    }
  }
  commitResponder(
    runtime: object,
    prepared: PreparedRoomResponder
  ): OriginalCommittedRoomResponder {
    return this.#responder.commitResponder(runtime, prepared);
  }
  #retainConfirmedFreeze(
    pending: PendingSource,
    selector: Readonly<{ documentId: string; batchId: string; generation: string }>
  ): void {
    const source = pending.source;
    if (
      selector.documentId !== source.documentId ||
      selector.batchId !== source.batchId ||
      selector.generation !== source.generation
    )
      throw new Error('Native Room freeze differs from its original custody.');
    const token: OriginalFrozenRoomSource = Object.freeze({ kind: 'original-frozen-room-source' });
    frozenRoomSources.set(token, {
      engine: this.#engine,
      db: this.#db,
      facade: this.#facade,
      principals: this.#principals,
      source,
      before: pending.before,
      producerRoomFacts: pending.producerRoomFacts,
      roomCustody: pending.roomCustody,
      dueAt: pending.dueAt,
      selector: copyCurrentDocData(selector),
    });
    if (source.producerOrigin === 'operator')
      originalRoomOperatorSources.set(token, {
        engine: this.#engine,
        db: this.#db,
        read: () => source,
      });
    if (source.producerOrigin === 'doc_token')
      originalRoomTokenSources.set(token, {
        engine: this.#engine,
        db: this.#db,
        read: () => source,
      });
    this.#frozen.set(`${source.batchId}:${source.generation}`, token);
    this.#notifyRelay(source.documentId, source.batchId, source.generation);
  }
  /** Subscribe to confirmed eligible native Room identifiers, never source or claim authority. */
  subscribeRelay(
    listener: (documentId: string, batchId: string, generation: string) => void
  ): () => void {
    if (this.#pumpClosed) return () => {};
    if (typeof listener !== 'function') throw new Error('Room Relay listener required.');
    this.#relayListeners.add(listener);
    for (const [key, token] of [...this.#frozen]) {
      if (this.#pumpClosed || !this.#relayListeners.has(listener)) break;
      const own = frozenRoomSources.get(token);
      if (
        !own ||
        this.#frozen.get(key) !== token ||
        this.#preparing.has(key) ||
        this.#preparationUnknown.has(key)
      )
        continue;
      try {
        listener(own.source.documentId, own.source.batchId, own.source.generation);
      } catch {} // Transport hints cannot replace confirmed native acceptance.
    }
    return () => {
      this.#relayListeners.delete(listener);
    };
  }
  #notifyRelay(documentId: string, batchId: string, generation: string): void {
    for (const listener of [...this.#relayListeners]) {
      if (this.#pumpClosed || !this.#relayListeners.has(listener)) continue;
      try {
        listener(documentId, batchId, generation);
      } catch {} // The owning transport retains its operational failure separately.
    }
  }
  /** Identifier hints revisit only this engine's retained original Room custody. */
  hintRelay(documentId: string, batchId: string, generation: string): boolean {
    if (this.#pumpClosed) return false;
    if (this.#db.$client.inTransaction)
      throw new Error('Room Relay hint requires its inactive owning database.');
    for (const value of [documentId, batchId, generation])
      if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 4096) return false;
    const key = `${batchId}:${generation}`;
    if (this.#unavailable.has(key) || this.#preparing.has(key) || this.#preparationUnknown.has(key))
      return false;
    const pending = this.#pending.get(key);
    const token = this.#frozen.get(key);
    const frozen = token ? frozenRoomSources.get(token) : undefined;
    if (
      frozen &&
      (frozen.engine !== this.#engine || frozen.db !== this.#db || frozen.facade !== this.#facade)
    )
      throw new Error('Room Relay hint found foreign frozen custody.');
    const source = pending?.source ?? frozen?.source;
    if (
      !source ||
      source.documentId !== documentId ||
      source.batchId !== batchId ||
      source.generation !== generation
    )
      return false;
    // IDs cannot supply a source, deadline, target or claim. Native freeze repeats
    // the original current facts; the sole scheduler still owns runtime pumping.
    this.freezeDue();
    return true;
  }
  /** Earliest retained original deadline; this reveals no source or responder authority. */
  nextDueAt(): string | undefined {
    return [...this.#pending]
      .filter(([key]) => !this.#unavailable.has(key))
      .map(([, value]) => value.dueAt)
      .sort()[0];
  }
  /** Wake only authentic committed custody. Native freeze repeats the original fixed SQL facts. */
  freezeDue(): void {
    if (this.#db.$client.inTransaction)
      throw new Error('Room due wake requires its inactive owning database.');
    const now = withCheckboxReadOnlyGate(this.#db, () =>
      originalIso.call(new originalDate(originalDateNow()))
    );
    for (const [key, pending] of this.#pending) {
      if (this.#unavailable.has(key) || pending.dueAt > now) continue;
      this.#unavailable.add(key);
      const result = this.#facade.freezeProducerAcceptedRoomSource(pending.source);
      if (result.state !== 'confirmed') continue;
      this.#retainConfirmedFreeze(pending, result.value);
      this.#pending.delete(key);
      this.#unavailable.delete(key);
    }
  }
  committed(tx: DbTransaction, now: string): void {
    const draft = this.#drafts.get(tx);
    this.#drafts.delete(tx);
    this.#pendingLimits.delete(tx);
    if (!draft?.sealed || this.#db.$client.inTransaction)
      throw new Error('Room custody requires its confirmed outer commit.');
    if (draft.replay) {
      if (this.#pending.get(draft.replay.previousKey) !== draft.replay.previousPending)
        throw new Error('Original Room replay custody changed across commit.');
      this.#pending.delete(draft.replay.previousKey);
    }
    for (const pending of draft.sealed) {
      const key = `${pending.source.batchId}:${pending.source.generation}`;
      this.#pending.set(key, pending);
      if (Date.parse(pending.dueAt) > Date.parse(now)) continue;
      // Existing native freeze owns pending/waiting -> accepted/null-private-receipt.
      // No responder is acquired and no model dispatch occurs here.
      this.#unavailable.add(key);
      const result = this.#facade.freezeProducerAcceptedRoomSource(pending.source);
      if (result.state !== 'confirmed') this.#unavailable.add(key);
      else {
        this.#retainConfirmedFreeze(pending, result.value);
        this.#unavailable.delete(key);
        this.#pending.delete(key);
      }
    }
  }
  abandoned(tx: DbTransaction): void {
    this.#drafts.delete(tx);
    this.#pendingLimits.delete(tx);
  }
  /** Only the still-active original writer completion can request this fixed native optimization. */
  cancelOriginalCheckboxUndoPair(
    store: DocChannelStore,
    owner: object,
    tx: DbTransaction,
    baseline: {
      generation: string;
      physical: Record<string, unknown>;
      channelBirth: Record<string, unknown>;
      now: string;
    }
  ): void {
    requireOriginalRoomResponderOwner(
      this,
      this.#responder,
      this.#engine,
      this.#db,
      this.#principals,
      this.#roomStore,
      this.#facade
    );
    requireDocChannelStoreDatabase(store, this.#db);
    if (this.#db.$client.inTransaction) throw new Error('Original undo cancellation cannot nest.');
    const own = readOriginalCheckboxCommittedStage(owner, store, tx);
    const evidence = validateCheckboxEvidence(own.intent);
    const committed = copyCurrentDocData({
      ...own.intent,
      status: 'committed',
      updatedAt: baseline.now,
      errorCode: null,
      evidence: { ...evidence, receipt: own.receipt },
    });
    requireOriginalCheckboxCompletionCommitted(owner, store, tx);
    // Native capture, transaction, exact CAS and commit are synchronous under the same canonical lease.
    const result = this.#facade.cancelOriginalCheckboxUndoPair({
      documentId: own.intent.documentId,
      intentId: own.intent.intentId,
      documentGeneration: baseline.generation,
      currentIntentJson: JSON.stringify(committed),
      physicalJson: JSON.stringify(baseline.physical),
      channelBirthJson: JSON.stringify(baseline.channelBirth),
    });
    requireOriginalCheckboxCompletionCommitted(owner, store, tx);
    if (result.state !== 'confirmed') return;
    for (const selector of result.value) {
      const key = `${selector.batchId}:${selector.generation}`;
      this.#unavailable.add(key);
      this.#pending.delete(key);
      this.#frozen.delete(key);
    }
  }
}

/** Fixed original SDK cleanup attempts all owners; no caller-supplied closer or cause replacement. */
export async function retireOriginalRoomResponderStream(stream: object): Promise<void> {
  let failed = false,
    first: unknown;
  for (const retire of [
    retireClaudeOriginalRoomResponderStream,
    retireCodexOriginalRoomResponderStream,
    retireOpenCodeOriginalRoomResponderStream,
    retireTestModeOriginalRoomResponderStream,
  ]) {
    try {
      await retire(stream);
    } catch (cause) {
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  if (failed) throw first;
}
