import { requireOriginalDocumentFileSaveCompleted } from '../../writes/installation-file-writes.js';
import { createOriginalEditorSelectionReader } from '../../editor/selection-source.js';
import { readOriginalDocIngestLimits } from '../../ingest.js';
import { sameOriginalDocTokenData } from '../../tokens/token-native-comparison.js';
import { createOriginalDocTokenFileSourceReader } from '../../tokens/token-native-file-source.js';
import { readOriginalTokenDocumentManifest } from '../../grant-revalidation.js';
import {
  captureCurrentDocCondition,
  publicCurrentDelivery,
} from '../current-operation-intentions.js';
import { and, eq, sql, canvasDocDeliveries, type DbTransaction } from '@dorkos/db';
import {
  StoredPageEventSchema,
  PageEventSchema,
  CanvasChannelCheckboxBindingSchema,
  type CanvasChannelEventReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import { requireDocChannelStoreDatabase, type DocChannelStore } from '../../store.js';
import {
  type DocChannelIngest,
  acceptCurrentDocEventInTransaction,
  captureCurrentDocIngestClock,
  auditCurrentDocIngestRows,
} from '../../ingest.js';
import { type DocChannelGrants } from '../../grants.js';
import {
  prepareCurrentDocGrantRoutes,
  auditCurrentDocGrantRows,
  refreshCurrentDocGrantAuthority,
} from '../../grant-revalidation.js';
import { documentTransaction } from '../../storage/store-transaction.js';
import { withCheckboxReadOnlyGate } from '../../writes/authority/authority-snapshot.js';
import { readDocEventRow } from '../../writes/reservations/reservation-policy-census.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current-operation-data.js';
import { envelopeIdentity } from '../../envelope.js';
import { isSqliteStorageError } from '../../ingest.js';
import { DocIngestRefusal } from '../../ingest-data/ingest-types.js';
import { type DocEventCondition } from '../current-operation-types.js';
import {
  captureCurrentHttpDocActor,
  DocChannelNotFoundError,
  requireCurrentDocConstructorEngines,
  requireCurrentDocEngineOrigin,
  type DocChannelActor,
} from '../../authorization.js';
import { readOriginalEventAdmissionFacet } from '../current-operation-engine.js';
/** Admit and ingest an event under the original document actor and grant scope. */
export async function submitCurrent(
  owner: object,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  documentId: string,
  raw: unknown,
  rawActor: DocChannelActor,
  rawCondition: DocEventCondition,
  documentAuthority?: import('../current-operation-types.js').OriginalCurrentDocumentAuthority,
  selection?: {
    request: import('@dorkos/shared/canvas-channel-schemas').CanvasChannelSelectionRequest;
    fileSource: import('../../tokens/token-native-file-source.js').OriginalDocTokenFileSource;
    source: ReturnType<ReturnType<typeof createOriginalEditorSelectionReader>['read']>;
  },
  documentSave?: object,
  presenceFocus?: object
): Promise<CanvasChannelEventReceipt> {
  const facet = readOriginalEventAdmissionFacet(owner);
  requireCurrentDocEngineOrigin(facet.authorization, facet.core, facet.db);
  const actor = captureCurrentHttpDocActor(rawActor);
  const condition = captureCurrentDocCondition(rawCondition);
  requireCurrentDocConstructorEngines(facet.authorization, store);
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
    const own = facet.presenceFocusStages.get(presenceFocus);
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
    facet.requirePresenceFocusPreflight(presenceFocus, store);
  }
  if (documentSave) {
    const own = facet.documentSaves.get(documentSave);
    if (
      !own?.consumed ||
      own.store !== store ||
      own.grants !== grants ||
      !sameCurrentDocData(own.event, event) ||
      documentId !== own.request.documentId ||
      condition.expectedGeneration !== own.request.expectedGeneration
    )
      throw new DocChannelNotFoundError();
    requireOriginalDocumentFileSaveCompleted(documentSave, facet.db, store, own.hash);
  }
  requireCurrentDocConstructorEngines(facet.authorization, store, ingest, grants);
  await facet.preflightCurrent(documentId, actor, true);
  let refresh: { cause: unknown } | undefined;
  try {
    refreshCurrentDocGrantAuthority(grants, store, facet.authorization, documentId, actor);
  } catch (cause) {
    refresh = { cause };
  }
  const db = facet.db;
  requireDocChannelStoreDatabase(store, db);
  requireCurrentDocEngineOrigin(facet.authorization, facet.core, facet.db);
  if (db.$client.inTransaction || facet.currentEntry)
    throw new Error('Current document admission cannot nest.');
  // An approved FILE write binding also constrains ordinary comments routed by that grant.
  // Observe it through the engine's fixed native reader outside SQL, never a caller DTO.
  let fileSource:
    import('../../tokens/token-native-file-source.js').OriginalDocTokenFileSource | undefined;
  let writeObservation: import('../../grant-policy.js').DocOriginalWriteObservation | undefined;
  if (
    !refresh &&
    !readDocEventRow(db, documentId, event.id) &&
    db.get(sql`
      SELECT 1 FROM canvas_doc_grants WHERE document_id=${documentId}
      AND revoked_at IS NULL AND write_operation IS NOT NULL LIMIT 1`)
  ) {
    const reader = (facet.tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
      db,
      facet.fixedPorts.originalRoomRepoStore
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
    const reader = facet.tokenFileSourceReader;
    if (!reader || !sameCurrentDocData(selection.fileSource, reader.observe(documentId)))
      throw new DocChannelNotFoundError();
    documentAuthority = (
      await facet.captureDocument(
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
  facet.ensureRoom();
  let committedTx: DbTransaction | undefined;
  let committedAt: string | undefined;
  let committed = false;
  try {
    const response = documentTransaction(db, (tx) => {
      const scope = facet.beginCurrent(
        store,
        tx,
        documentId,
        actor,
        true,
        condition,
        documentAuthority
      );
      if (selection) facet.editorSelections.set(tx, selection);
      if (presenceFocus) facet.presenceFocusTransactions.set(tx, presenceFocus);
      if (documentSave) {
        const saved = facet.documentSaves.get(documentSave)!;
        if (!saved.fileSource.canonicalFile) throw new DocChannelNotFoundError();
        facet.documentSaveCompletions.set(tx, {
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
          facet.finalCurrent(store, tx);
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
          scope.access = prepareCurrentDocGrantRoutes(grants, store, facet.authorization, tx);
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
            const own = facet.documentAuthorities.get(scope.documentAuthority)!;
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
          captureCurrentDocIngestClock(ingest, store, facet.authorization, tx)
        );
        facet.finalCurrent(store, tx);
        const hasRoom = scope.access?.routes.some(
          (decision) =>
            !decision.reason &&
            decision.route.to === 'room:self' &&
            decision.route.turn.mode !== 'none'
        );
        if (hasRoom && facet.roomPumpStopped)
          throw new Error('Original Room pump admission is stopped.');
        if (hasRoom && !facet.room)
          throw new Error('Room acceptance requires original native construction custody.');
        if (hasRoom) facet.room!.prepare(store, grants, tx);
        // Producer capture callbacks precede the same private currentness gate and every effect.
        if (hasRoom) facet.finalCurrent(store, tx);
        const result = acceptCurrentDocEventInTransaction(ingest, store, facet.authorization, tx);
        if (!retained) scope.acceptedDocSeq = result.receipt.docSeq;
        const response = copyCurrentDocData({
          receipt: result.receipt,
          deliveries: result.deliveries.map(publicCurrentDelivery),
        });
        if (hasRoom) facet.room!.seal(store, tx, readOriginalDocIngestLimits(ingest, store));
        // All writes, status frames and immutable response capture precede private final callback/currentness.
        // Final original row/grant/outbox SQL audits themselves contain no callbacks.
        facet.finalCurrent(store, tx);
        auditCurrentDocIngestRows(ingest, store, facet.authorization, tx);
        if (!retained) auditCurrentDocGrantRows(grants, store, facet.authorization, tx);
        if (hasRoom) {
          facet.room!.audit(store, grants, tx);
          committedTx = tx;
          committedAt = scope.now!;
        }
        return response;
      } catch (cause) {
        facet.room?.abandoned(tx);
        if (!scope.failure) scope.failure = { cause };
        throw scope.failure.cause;
      } finally {
        facet.retireCurrent(tx);
      }
    });
    committed = true;
    if (presenceFocus) {
      const focus = facet.presenceFocusStages.get(presenceFocus);
      if (!focus) throw new Error('Original committed focus stage missing.');
      // Native SQL returned from COMMIT. Retain the actual focus transition before
      // original committed callbacks can fail or reenter; a retry cannot relog it.
      facet.presenceLedger.commit(focus.plan);
    }
    if (committedTx) facet.room!.committed(committedTx, committedAt!);
    return response;
  } catch (cause) {
    if (committedTx) facet.room?.abandoned(committedTx);
    if (!committed && isSqliteStorageError(cause))
      throw new DocIngestRefusal('DOC_EVENT_STORAGE_FAILURE', 507);
    throw cause;
  }
}
