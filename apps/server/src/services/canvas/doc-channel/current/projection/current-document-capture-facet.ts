import { readOriginalDocIngestLimits } from '../../ingest.js';
import { sameOriginalDocTokenData } from '../../tokens/token-native-comparison.js';
import { readOriginalTokenDocumentManifest } from '../../grant-revalidation.js';
import { sql, type DbTransaction } from '@dorkos/db';
import { CanvasChannelCheckboxBindingSchema } from '@dorkos/shared/canvas-channel-schemas';
import { type DocChannelStore } from '../../store.js';
import { auditCurrentDocIngestRows } from '../../ingest.js';
import { type DocChannelGrants } from '../../grants.js';
import {
  prepareCurrentDocGrantRoutes,
  prepareCurrentDocCheckboxGrantRoutes,
  captureCurrentDocumentGrantDependencies,
  auditCurrentDocGrantRows,
} from '../../grant-revalidation.js';
import { documentTransaction } from '../../storage/store-transaction.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current-operation-data.js';
import {
  captureCurrentHttpDocActor,
  DocChannelNotFoundError,
  requireCurrentDocConstructorEngines,
  requireCurrentDocEngineOrigin,
  type DocChannelActor,
} from '../../authorization.js';
import {
  readOriginalCheckboxCompletionStage,
  consumeOriginalCheckboxCompletionStage,
} from '../../writes/completion.js';
import { prepareCurrentCheckboxIngest, finishCurrentCheckboxIngest } from '../../ingest.js';
import { readOriginalDocumentCaptureFacet } from '../current-operation-engine.js';
/** Complete the captured checkbox write under the original document and transaction authority. */
export function completeCheckbox(
  engineOwner: object,
  store: DocChannelStore,
  grants: DocChannelGrants,
  owner: object,
  tx: DbTransaction
) {
  const facet = readOriginalDocumentCaptureFacet(engineOwner);
  requireCurrentDocEngineOrigin(facet.authorization, facet.core, facet.db);
  const original = readOriginalCheckboxCompletionStage(owner, store, tx);
  // Recovery has no authenticated live ingress actor. It cannot reconstruct one from its row.
  const { data, ingest } = original;
  if (data.subject.kind !== 'live')
    throw new Error(
      'Native checkbox Room source requires original authenticated producer custody.'
    );
  const scope = facet.beginCurrent(store, tx, data.access.documentId, data.subject.actor, true, {
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
      facet.authorization,
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
    if (hasRoom && (facet.roomPumpStopped || !facet.room))
      throw new Error('Original checkbox Room source admission is unavailable.');
    facet.finalCurrent(store, tx);
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
    if (hasRoom) facet.room!.prepare(store, grants, tx);
    facet.finalCurrent(store, tx);
    prepareCurrentCheckboxIngest(ingest, store, facet.authorization, tx, original.phase);
    const receipt = consumeOriginalCheckboxCompletionStage(owner, store, tx);
    if (receipt.status !== 'changed')
      throw new Error('Original checkbox source did not commit a change.');
    scope.acceptedDocSeq = receipt.receipt.docSeq;
    finishCurrentCheckboxIngest(ingest, store, tx);
    if (hasRoom) facet.room!.seal(store, tx, readOriginalDocIngestLimits(ingest, store));
    facet.finalCurrent(store, tx);
    auditCurrentDocIngestRows(ingest, store, facet.authorization, tx);
    auditCurrentDocGrantRows(grants, store, facet.authorization, tx);
    if (hasRoom) facet.room!.audit(store, grants, tx);
    if (facet.room && route.route.turn.mode !== 'none') {
      facet.checkboxCommits.set(tx, {
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
    facet.room?.abandoned(tx);
    if (!scope.failure) scope.failure = { cause };
    throw scope.failure.cause;
  } finally {
    facet.retireCurrent(tx);
  }
}
/** Read document authority only through the captured original engine and grant source. */
export function readDocumentAuthority(
  engineOwner: object,
  store: DocChannelStore,
  grants: DocChannelGrants,
  authority: import('../current-operation-types.js').OriginalCurrentDocumentAuthority
) {
  const facet = readOriginalDocumentCaptureFacet(engineOwner);
  const own = facet.documentAuthorities.get(authority);
  if (!own || own.store !== store || own.grants !== grants) throw new DocChannelNotFoundError();
  return own;
}
/** Capture the document and actor source after the original currentness and file guards. */
export async function captureDocument(
  engineOwner: object,
  store: DocChannelStore,
  grants: DocChannelGrants,
  documentId: string,
  rawActor: DocChannelActor,
  rawIds: readonly string[],
  authority?: import('../current-operation-types.js').OriginalCurrentDocumentAuthority,
  nativeFileSource?: import('../../tokens/token-native-file-source.js').OriginalDocTokenFileSource,
  selectOriginalEvent?: import('@dorkos/shared/canvas-channel-schemas').StoredPageEvent
): Promise<import('../current-operation-types.js').OriginalCurrentDocumentData> {
  const facet = readOriginalDocumentCaptureFacet(engineOwner);
  const actor = captureCurrentHttpDocActor(rawActor);
  const requestedGrantIds = Object.freeze([...rawIds]);
  if (
    requestedGrantIds.some((id) => typeof id !== 'string' || !id) ||
    new Set(requestedGrantIds).size !== requestedGrantIds.length
  )
    throw new DocChannelNotFoundError();
  requireCurrentDocConstructorEngines(facet.authorization, store, undefined, grants);
  await facet.preflightCurrent(documentId, actor, false);
  if (facet.db.$client.inTransaction || facet.currentEntry) throw new DocChannelNotFoundError();
  // Only the engine's original native FILE reader supplies this observation.
  // The persisted approved write binding is compared, never reused as current source evidence.
  let writeObservation: import('../../grant-policy.js').DocOriginalWriteObservation | undefined;
  if (nativeFileSource) {
    if (
      !facet.tokenFileSourceReader ||
      !sameOriginalDocTokenData(nativeFileSource, facet.tokenFileSourceReader.observe(documentId))
    )
      throw new DocChannelNotFoundError();
    if (nativeFileSource.canonicalFile !== null) {
      const physical = nativeFileSource.policies.physical;
      writeObservation = Object.freeze({
        manifestHash: readOriginalTokenDocumentManifest(grants, store, facet.db, documentId),
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
  return documentTransaction(facet.db, (tx) => {
    const scope = facet.beginCurrent(store, tx, documentId, actor, false, 'server-initial-replay');
    try {
      // Host selection retains only IDs chosen by the original fresh route core.
      // No request field or reflected grant method supplies this dependency set.
      scope.originalWriteObservation = writeObservation;
      if (selectOriginalEvent) scope.event = copyCurrentDocData(selectOriginalEvent);
      const selected = selectOriginalEvent
        ? prepareCurrentDocGrantRoutes(grants, store, facet.authorization, tx)
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
      const dependencyRows = facet.documentGrantRows(documentId, tx);
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
      const old = authority && facet.documentAuthorities.get(authority);
      if (
        authority &&
        (!old ||
          old.store !== store ||
          old.grants !== grants ||
          !sameCurrentDocData(old.baseline, baseline))
      )
        throw new DocChannelNotFoundError();
      scope.documentGrantSelection = { grants, ids: grantIds, writeObservation };
      facet.finalCurrent(store, tx);
      if (!sameCurrentDocData(dependencyRows, facet.documentGrantRows(documentId, tx)))
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
        facet.documentAuthorities.set(token, {
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
      facet.retireCurrent(tx);
    }
  });
}
