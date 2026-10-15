import { requireOriginalNativePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import { type Db, type DbTransaction } from '@dorkos/db';
import { type FixedNativeRoomDocFacade } from '@dorkos/db/internal-server';
import { type RoomStore } from '../../../rooms/room-store.js';
import {
  requireNativePrincipalDatabase,
  type ConnectorRuntimePrincipalService,
} from '../../../connectors/principal/runtime-principal-service.js';
import { requireCurrentDocEngineOrigin } from '../authorization.js';
import type {
  OriginalFrozenRoomSource,
  CurrentDocOperationEngineCore,
  FrozenRoomSourceData,
} from '../current/current-operation-types.js';
import { OriginalRoomResponderOperation } from './room-responder-operation.js';
import { readOriginalRoomOperationCustodyView } from './room-current-operation.js';
import type { CurrentRoomOperation } from './room-current-operation.js';

/** Read only the genuine constructor's sealed write intention, never actual SQL changes. */
export function readOriginalRoomPendingWriteCount(
  custodyOwner: object,
  owner: object,
  tx: DbTransaction
): number {
  const facet = readOriginalRoomOperationCustodyView(custodyOwner);
  const read = facet.originalRoomPendingCounts.get(owner);
  if (!read) throw new Error('Room pending count requires original construction.');
  return read(tx);
}

/** Read transport availability only from the genuine native helper and its original engine tuple. */
export function readOriginalRoomReplayAvailability(
  custodyOwner: object,
  helper: CurrentRoomOperation,
  engine: CurrentDocOperationEngineCore,
  db: Db
): boolean {
  const facet = readOriginalRoomOperationCustodyView(custodyOwner);
  const own = facet.originalRoomResponderOwners.get(helper);
  const read = facet.originalRoomReplayAvailability.get(helper);
  if (!own || !read || own.engine !== engine || own.db !== db)
    throw new Error('Room replay transport is not the original native owner.');
  requireCurrentDocEngineOrigin(own.authorization, engine, db);
  requireNativePrincipalDatabase(own.principals, db);
  return read();
}

/** Fixed genuine helper tuple and actual constructor-created delegate, never a supplied registrar. */
export function requireOriginalRoomResponderOwner(
  custodyOwner: object,
  helper: CurrentRoomOperation,
  delegate: OriginalRoomResponderOperation,
  engine: CurrentDocOperationEngineCore,
  db: Db,
  principals: ConnectorRuntimePrincipalService,
  roomStore: RoomStore,
  facade: FixedNativeRoomDocFacade
): void {
  const facet = readOriginalRoomOperationCustodyView(custodyOwner);
  const own = facet.originalRoomResponderOwners.get(helper);
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
  custodyOwner: object,
  helper: CurrentRoomOperation,
  delegate: OriginalRoomResponderOperation,
  token: OriginalFrozenRoomSource
): FrozenRoomSourceData {
  const facet = readOriginalRoomOperationCustodyView(custodyOwner);
  const own = facet.originalRoomResponderOwners.get(helper);
  const source = facet.frozenRoomSources.get(token);
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
    custodyOwner,
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

/** Lookup only: native-confirmed construction custody, never an evidence DTO issuer. */
export function readOriginalRoomOperatorSource(
  custodyOwner: object,
  token: object,
  engine: CurrentDocOperationEngineCore,
  db: Db
): Readonly<{
  source: Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
  producer: import('../current/current-operation-types.js').OriginalRoomOperatorProducer;
}> {
  const facet = readOriginalRoomOperationCustodyView(custodyOwner);
  const own = facet.originalRoomOperatorSources.get(token);
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

/** Exact native confirmed source only; signed token rows/DTOs alone cannot issue Room custody. */
export function readOriginalRoomTokenSource(
  custodyOwner: object,
  token: object,
  engine: CurrentDocOperationEngineCore,
  db: Db
): Readonly<{
  source: Readonly<import('@dorkos/db/internal-server').RoomDocSourceData>;
  producer: import('../current/current-operation-types.js').OriginalRoomTokenProducer;
}> {
  const facet = readOriginalRoomOperationCustodyView(custodyOwner);
  const own = facet.originalRoomTokenSources.get(token);
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

/** Fixed original native Room lineage plus the exact granted member/agent/session binding. */
export function readCurrentFrozenRoomDestination(
  custodyOwner: object,
  own: FrozenRoomSourceData
): string {
  readOriginalRoomOperationCustodyView(custodyOwner);
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
export function readOriginalFrozenRoomTarget(
  custodyOwner: object,
  token: OriginalFrozenRoomSource,
  runtime: string
) {
  const facet = readOriginalRoomOperationCustodyView(custodyOwner);
  const own = facet.frozenRoomSources.get(token);
  if (!own || own.db.$client.inTransaction || own.source.targetRuntime !== runtime)
    throw new Error('Room preparation requires its original confirmed frozen target.');
  return Object.freeze({
    sessionId: readCurrentFrozenRoomDestination(custodyOwner, own),
    agentPath: own.source.targetAgentPath,
    agentId: own.source.targetAgentId,
    runtime: own.source.targetRuntime,
  });
}

/** Exact original constructor principal service; this consumes no copied service/DB permission. */
export function requireOriginalRoomPrincipalService(
  custodyOwner: object,
  token: OriginalFrozenRoomSource,
  service: object
): void {
  const facet = readOriginalRoomOperationCustodyView(custodyOwner);
  const own = facet.frozenRoomSources.get(token);
  if (!own) throw new Error('Room responder requires its original frozen source.');
  requireOriginalNativePrincipalService(service, own.principals);
}
