import {
  checkInstallationFileSaveScope,
  readOriginalDocumentFileSave,
  requireOriginalDocumentFileSaveCompleted,
} from '../../writes/installation-file-writes.js';
import { createOriginalDocTokenFileSourceReader } from '../../tokens/token-native-file-source.js';
import { createHash } from 'node:crypto';
import {
  CanvasChannelSelectionRequestSchema,
  StoredPageEventSchema,
  type CanvasChannelEventReceipt,
} from '@dorkos/shared/canvas-channel-schemas';
import { type DocChannelStore } from '../../store.js';
import { type DocChannelIngest } from '../../ingest.js';
import { type DocChannelGrants } from '../../grants.js';
import { readDocEventRow } from '../../writes/reservations/reservation-policy-census.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current-operation-data.js';
import { envelopeIdentity } from '../../envelope.js';
import { DocIngestRefusal } from '../../ingest-data/ingest-types.js';
import {
  captureCurrentHttpDocActor,
  DocChannelNotFoundError,
  requireCurrentDocConstructorEngines,
  type DocChannelActor,
} from '../../authorization.js';
import { readOriginalEditorSaveSelectionFacet } from '../current-operation-engine.js';
/** Prepare an editor save using the original handle, actor and grant currentness checks. */
export async function prepareDocumentSave(
  owner: object,
  store: DocChannelStore,
  grants: DocChannelGrants,
  handle: object,
  rawActor: DocChannelActor
) {
  const facet = readOriginalEditorSaveSelectionFacet(owner);
  requireCurrentDocConstructorEngines(facet.authorization, store, undefined, grants);
  const actual = readOriginalDocumentFileSave(handle, facet.db, store);
  const request = copyCurrentDocData(actual.input.documentSave!);
  const actor = captureCurrentHttpDocActor(rawActor);
  if (actor.principal.claims.kind !== 'operator' || facet.documentSaves.has(handle))
    throw new DocChannelNotFoundError();
  const expected =
    actual.input.expectedHash ??
    (actual.input.expectedContent === undefined
      ? undefined
      : createHash('sha256').update(actual.input.expectedContent).digest('hex'));
  if (expected !== request.expectedFileHash) throw new DocChannelNotFoundError();
  await facet.preflightCurrent(request.documentId, actor, false);
  const reader = (facet.tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
    facet.db,
    facet.fixedPorts.originalRoomRepoStore
  ));
  const fileSource = reader.observe(request.documentId);
  if (
    !fileSource.canonicalFile ||
    fileSource.canonicalFile !== actual.identity.canonicalPath ||
    fileSource.policies.physical.tree_kind === 'room-main'
  )
    throw new DocChannelNotFoundError();
  const source = facet.editorSelectionReader.readFile(fileSource.canonicalFile);
  const hash = createHash('sha256').update(actual.input.content).digest('hex');
  const event = copyCurrentDocData(
    StoredPageEventSchema.parse({
      v: 1,
      id: request.eventId,
      type: 'doc.saved',
      payload: { previousFileHash: request.expectedFileHash, fileHash: hash },
    })
  );
  const captured = await facet.captureDocument(
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
  const retained = readDocEventRow(facet.db, request.documentId, request.eventId);
  if (retained) {
    if (retained.envelopeHash !== envelopeIdentity(event).hash || source.hash !== hash)
      throw new DocIngestRefusal('DOC_EVENT_ID_CONFLICT', 409);
    // Await the actual canonical owner/path/caller checks before the last original document fence.
    await checkInstallationFileSaveScope(handle);
    const inspected = await facet.inspectCurrent(
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
      !sameCurrentDocData(retained, readDocEventRow(facet.db, request.documentId, request.eventId))
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
  facet.documentSaves.set(handle, {
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
/** Complete the prepared editor save through its original captured transaction scope. */
export async function completeDocumentSave(
  owner: object,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  handle: object,
  rawActor: DocChannelActor
) {
  const facet = readOriginalEditorSaveSelectionFacet(owner);
  const own = facet.documentSaves.get(handle);
  if (
    !own ||
    own.consumed ||
    own.store !== store ||
    own.grants !== grants ||
    !sameCurrentDocData(own.actor, captureCurrentHttpDocActor(rawActor))
  )
    throw new DocChannelNotFoundError();
  own.consumed = true;
  requireOriginalDocumentFileSaveCompleted(handle, facet.db, store, own.hash);
  const actual = readOriginalDocumentFileSave(handle, facet.db, store);
  if (
    !sameCurrentDocData(own.request, actual.input.documentSave) ||
    !own.fileSource.canonicalFile ||
    actual.identity.canonicalPath !== own.fileSource.canonicalFile ||
    !sameCurrentDocData(
      own.fileSource,
      facet.tokenFileSourceReader!.observe(own.request.documentId)
    )
  )
    throw new DocChannelNotFoundError();
  facet.editorSelectionReader.readFile(own.fileSource.canonicalFile, own.hash);
  return facet.submitCurrent(
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
/** Validate and submit the current editor selection with the original scope and source checks. */
export async function selectionCurrent(
  owner: object,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  raw: unknown,
  rawActor: DocChannelActor
): Promise<CanvasChannelEventReceipt> {
  const facet = readOriginalEditorSaveSelectionFacet(owner);
  const request = CanvasChannelSelectionRequestSchema.parse(copyCurrentDocData(raw));
  const actor = captureCurrentHttpDocActor(rawActor);
  if (actor.principal.claims.kind !== 'operator') throw new DocChannelNotFoundError();
  requireCurrentDocConstructorEngines(facet.authorization, store, ingest, grants);
  await facet.preflightCurrent(request.documentId, actor, true);
  const reader = (facet.tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
    facet.db,
    facet.fixedPorts.originalRoomRepoStore
  ));
  const fileSource = reader.observe(request.documentId);
  if (!fileSource.canonicalFile) throw new DocChannelNotFoundError();
  const source = facet.editorSelectionReader.read(fileSource.canonicalFile, request);
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
  return facet.submitCurrent(
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
