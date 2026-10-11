import { sql } from '@dorkos/db';
import {
  CanvasChannelCheckboxBindingSchema,
  CanvasChannelManagementSnapshotSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import {
  captureCurrentHttpDocActor,
  requireCurrentDocConstructorEngines,
  requireCurrentDocEngineOrigin,
  DocChannelNotFoundError,
  type DocChannelActor,
} from '../../authorization.js';
import { requireDocChannelStoreDatabase, type DocChannelStore } from '../../store.js';
import type { DocChannelGrants } from '../../grants.js';
import type {
  DocCurrentReplayResponse,
  DocEventCondition,
  DocReceiptInspection,
} from '../current-operation-types.js';
import { createOriginalDocTokenFileSourceReader } from '../../tokens/token-native-file-source.js';
import { sameOriginalDocTokenData } from '../../tokens/token-native-comparison.js';
import {
  readOriginalTokenDocumentManifest,
  readOriginalCurrentDocReplayRouting,
} from '../../grant-revalidation.js';
import {
  createOriginalDocManagementReader,
  projectDocManagementRows,
} from '../../management/snapshot-data.js';
import { readOriginalRoomReplayAvailability } from '../../operations/room-current-operation.js';
import { documentTransaction } from '../../storage/store-transaction.js';
import { sameCurrentDocData } from '../current-operation-data.js';
import { captureCurrentDocCondition } from '../current-operation-intentions.js';
import { readDocEventRow } from '../../writes/reservations/reservation-policy-census.js';
import {
  readCurrentDocReplayInTransaction,
  projectCurrentDocReplay,
  projectCurrentDocReceipt,
  readCurrentReceiptChannelRow,
  readCurrentReplayChannelRow,
} from '../../replay.js';
import { readOriginalReadProjectionFacet } from '../current-operation-engine.js';
/** Observe the original file source for replay without issuing write authority. */
export function observeReplayFileSource(
  owner: object,
  store: DocChannelStore,
  documentId: string,
  grants?: DocChannelGrants
) {
  const own = readOriginalReadProjectionFacet(owner);
  if (
    !grants ||
    !own.db.get(sql`SELECT 1 FROM canvas_doc_grants
      WHERE document_id=${documentId} AND revoked_at IS NULL AND write_operation IS NOT NULL LIMIT 1`)
  )
    return undefined;
  requireCurrentDocConstructorEngines(own.authorization, store, undefined, grants);
  own.retainTokenManifestOwner(grants, store);
  const reader = (own.tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
    own.db,
    own.fixedPorts.originalRoomRepoStore
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
    manifestHash: readOriginalTokenDocumentManifest(grants, store, own.db, documentId),
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
/** Read document management state through the original actor and source checks. */
export async function managementCurrent(
  owner: object,
  store: DocChannelStore,
  documentId: string,
  rawActor: DocChannelActor
) {
  const own = readOriginalReadProjectionFacet(owner);
  const actor = captureCurrentHttpDocActor(rawActor);
  if (actor.principal.claims.kind !== 'operator') throw new DocChannelNotFoundError();
  requireCurrentDocConstructorEngines(own.authorization, store);
  await own.preflightCurrent(documentId, actor, false);
  requireDocChannelStoreDatabase(store, own.db);
  if (own.db.$client.inTransaction || own.currentEntry)
    throw new Error('Document management cannot nest.');
  const grants = own.tokenSourceDependencies?.grants;
  const file = observeReplayFileSource(owner, store, documentId, grants);
  own.ensureRoom();
  const readRows = (own.managementReader ??= createOriginalDocManagementReader(own.db));
  return documentTransaction(own.db, (tx) => {
    const scope = own.beginCurrent(store, tx, documentId, actor, false, 'server-initial-replay');
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
        own.room,
        own.core
      );
      const result = CanvasChannelManagementSnapshotSchema.parse({
        documentId,
        generation: scope.generation,
        declaration: scope.channelRow.declaration,
        routing,
        ...projectDocManagementRows(
          rows,
          scope.scope.startsWith('room:') &&
            !!own.room &&
            readOriginalRoomReplayAvailability(own.room, own.core, own.db)
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
            own.room,
            own.core
          )
        )
      )
        throw new DocChannelNotFoundError();
      // Every policy callback and projection precedes the original final current gate.
      own.finalCurrent(store, tx);
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
      own.retireCurrent(tx);
    }
  });
}
/** Read the requested document replay range under original currentness and access checks. */
export async function replayCurrent(
  owner: object,
  store: DocChannelStore,
  documentId: string,
  rawActor: DocChannelActor,
  since: number,
  limit: number,
  documentAuthority?: import('../current-operation-types.js').OriginalCurrentDocumentAuthority
): Promise<DocCurrentReplayResponse> {
  const own = readOriginalReadProjectionFacet(owner);
  const actor = captureCurrentHttpDocActor(rawActor);
  requireCurrentDocConstructorEngines(own.authorization, store);
  await own.preflightCurrent(documentId, actor, false);
  const db = own.db;
  requireDocChannelStoreDatabase(store, db);
  if (db.$client.inTransaction || own.currentEntry)
    throw new Error('Current document replay cannot nest.');
  const grants = own.tokenSourceDependencies?.grants;
  const file = observeReplayFileSource(owner, store, documentId, grants);
  // Construct the installed native transport outside SQL before the first app replay.
  // Its original factory retains recovery failure and stopped-pump refusal.
  own.ensureRoom();
  return documentTransaction(db, (tx) => {
    const scope = own.beginCurrent(
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
            own.room,
            own.core
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
            own.room,
            own.core
          )
        )
      )
        throw new DocChannelNotFoundError();
      // All decoding/projection and effectful grant checks precede the final native gate.
      own.finalCurrent(store, tx);
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
      if (!sameCurrentDocData(scope.channelRow, finalChannel)) throw new DocChannelNotFoundError();
      return result;
    } catch (cause) {
      if (!scope.failure) scope.failure = { cause };
      throw scope.failure.cause;
    } finally {
      own.retireCurrent(tx);
    }
  });
}
/** Inspect a document event under its original actor, grant and source authority. */
export async function inspectCurrent(
  owner: object,
  store: DocChannelStore,
  documentId: string,
  eventId: string,
  rawActor: DocChannelActor,
  rawCondition: DocEventCondition,
  documentAuthority?: import('../current-operation-types.js').OriginalCurrentDocumentAuthority,
  duplicateSave?: {
    scope: object;
    request: import('@dorkos/shared/schemas').CanvasDocumentSaveIdentity;
    hash: string;
    path: string;
  }
): Promise<DocReceiptInspection> {
  const own = readOriginalReadProjectionFacet(owner);
  requireCurrentDocEngineOrigin(own.authorization, own.core, own.db);
  const actor = captureCurrentHttpDocActor(rawActor);
  const condition = captureCurrentDocCondition(rawCondition);
  requireCurrentDocConstructorEngines(own.authorization, store);
  await own.preflightCurrent(documentId, actor, false);
  const db = own.db;
  requireDocChannelStoreDatabase(store, db);
  requireCurrentDocEngineOrigin(own.authorization, own.core, own.db);
  if (db.$client.inTransaction || own.currentEntry)
    throw new Error('Current document inspection cannot nest.');
  return documentTransaction(db, (tx) => {
    const scope = own.beginCurrent(
      store,
      tx,
      documentId,
      actor,
      false,
      condition,
      documentAuthority
    );
    try {
      if (duplicateSave) own.documentSaveInspections.set(tx, duplicateSave);
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
      own.finalCurrent(store, tx);
      return result;
    } catch (cause) {
      if (!scope.failure) scope.failure = { cause };
      throw scope.failure.cause;
    } finally {
      own.retireCurrent(tx);
    }
  });
}
