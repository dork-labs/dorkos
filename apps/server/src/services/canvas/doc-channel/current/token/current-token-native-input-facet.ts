import { readOriginalDocIngestLimits } from '../../ingest.js';
import { sameOriginalDocTokenData } from '../../tokens/token-native-comparison.js';
import { createOriginalDocTokenFileSourceReader } from '../../tokens/token-native-file-source.js';
import { parseOriginalDocTokenCapsuleData } from '../../tokens/token-native-data.js';
import { createOriginalDocTokenCurrentReader } from '../../tokens/token-native-current.js';
import { createOriginalDocTokenEventReader } from '../../tokens/token-native-reads.js';
import { readOriginalTokenDocumentManifest } from '../../grant-revalidation.js';
import { verifyOriginalDocTokenNativeCapsule } from '../../../../core/auth/index.js';
import { encodeOriginalDocTokenHeaderAuthentication } from '../../tokens/token-authentication-message.js';
import { createOriginalDocTokenNativeFactsReader } from '../../tokens/token-native-facts.js';
import { readOriginalNativeDocTokenHeaderByHash } from '../../tokens/token-store.js';
import { readCurrentDocBirthRows, publicCurrentDelivery } from '../current-operation-intentions.js';
import { and, eq, canvasDocDeliveries, type DbTransaction } from '@dorkos/db';
import {
  PageEventSchema,
  CanvasChannelCheckboxBindingSchema,
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
  prepareOriginalTokenGrantInput,
  prepareCurrentDocGrantRoutes,
  requireCurrentDocGrantEngine,
  auditCurrentDocGrantRows,
} from '../../grant-revalidation.js';
import { documentTransaction } from '../../storage/store-transaction.js';
import { withCheckboxReadOnlyGate } from '../../writes/authority/authority-snapshot.js';
import { readDocEventRow } from '../../writes/reservations/reservation-policy-census.js';
import { copyCurrentDocData, sameCurrentDocData } from '../current-operation-data.js';
import { envelopeIdentity } from '../../envelope.js';
import { DocIngestRefusal } from '../../ingest-data/ingest-types.js';
import { type CurrentOperationScope } from '../current-operation-types.js';
import {
  DocChannelNotFoundError,
  requireCurrentDocConstructorEngines,
  requireCurrentDocEngineOrigin,
} from '../../authorization.js';
import { readOriginalTokenNativeInputFacet } from '../current-operation-engine.js';
/** Require the original engine and current native token source. */
export function tokenNativeCurrent(
  owner: object,
  own: { store: DocChannelStore; grants: DocChannelGrants; hash: string }
) {
  const facet = readOriginalTokenNativeInputFacet(owner);
  requireCurrentDocEngineOrigin(facet.authorization, facet.core, facet.db);
  requireDocChannelStoreDatabase(own.store, facet.db);
  requireCurrentDocGrantEngine(own.grants, own.store, facet.db);
  if (
    facet.roomPumpStopped ||
    !facet.tokenStore ||
    !facet.readTokenNativeFacts ||
    !facet.tokenCurrentReader ||
    !facet.tokenFileSourceReader
  )
    throw new DocChannelNotFoundError();
  const header = readOriginalNativeDocTokenHeaderByHash(facet.tokenStore, facet.db, own.hash);
  if (!header) throw new DocChannelNotFoundError();
  const payload = verifyOriginalDocTokenNativeCapsule(facet.db, header);
  const data = parseOriginalDocTokenCapsuleData(header, payload);
  if (!sameOriginalDocTokenData(data.facts, facet.readTokenNativeFacts(header.documentId)))
    throw new DocChannelNotFoundError();
  if (
    !sameOriginalDocTokenData(
      data.fileSource.policies,
      facet.tokenFileSourceReader.policies(header.documentId)
    )
  )
    throw new DocChannelNotFoundError();
  facet.tokenCurrentReader(header, data, facet.fixedPorts.originalInstallationId);
  return { header, data };
}
/** Prepare a native token read outside an existing current document transaction. */
export function prepareTokenNativeRead(
  owner: object,
  own: { store: DocChannelStore; grants: DocChannelGrants; hash: string }
) {
  const facet = readOriginalTokenNativeInputFacet(owner);
  if (facet.db.$client.inTransaction || facet.currentEntry) throw new DocChannelNotFoundError();
  const before = facet.tokenNativeCurrent(own);
  // Fixed native identity-intent guard has already refused pending/ambiguous
  // or moved ownership. FILE/manifest observation completes outside SQL.
  if (
    readOriginalTokenDocumentManifest(own.grants, own.store, facet.db, before.header.documentId) !==
    before.header.manifestHash
  )
    throw new DocChannelNotFoundError();
  if (!facet.tokenFileSourceReader) throw new DocChannelNotFoundError();
  const fileSource = facet.tokenFileSourceReader.observe(before.header.documentId);
  if (!sameOriginalDocTokenData(before.data.fileSource, fileSource))
    throw new DocChannelNotFoundError();
  const current = facet.tokenNativeCurrent(own);
  if (
    encodeOriginalDocTokenHeaderAuthentication(
      before.header,
      verifyOriginalDocTokenNativeCapsule(facet.db, before.header)
    ) !==
    encodeOriginalDocTokenHeaderAuthentication(
      current.header,
      verifyOriginalDocTokenNativeCapsule(facet.db, current.header)
    )
  )
    throw new DocChannelNotFoundError();
  return { ...current, fileSource };
}
/** Initialize the original private token facts and file source readers. */
export function initializeTokenReaders(owner: object): void {
  const facet = readOriginalTokenNativeInputFacet(owner);
  facet.originalTokenStore();
  facet.readTokenNativeFacts ??= createOriginalDocTokenNativeFactsReader(facet.db);
  facet.tokenFileSourceReader ??= createOriginalDocTokenFileSourceReader(
    facet.db,
    facet.fixedPorts.originalRoomRepoStore
  );
  facet.tokenCurrentReader ??= createOriginalDocTokenCurrentReader(facet.db);
  facet.tokenEventReader ??= createOriginalDocTokenEventReader(facet.db);
}
/** Restore a native token scope through the original token and source checks. */
export async function restoreTokenScope(
  owner: object,
  store: DocChannelStore,
  grants: DocChannelGrants,
  hash: string
) {
  const facet = readOriginalTokenNativeInputFacet(owner);
  const dependencies = facet.tokenSourceDependencies;
  if (!dependencies || dependencies.store !== store || dependencies.grants !== grants)
    throw new DocChannelNotFoundError();
  facet.initializeTokenReaders();
  const own = { store, grants, hash };
  facet.retainTokenManifestOwner(grants, store);
  facet.prepareTokenNativeRead(own);
  const scope = Object.freeze({ kind: 'original-native-doc-token-scope' as const });
  facet.restoredTokens.set(scope, own);
  return scope;
}
/** Read token replay under its original scope and requested replay or stream permission. */
export async function readTokenReplay(
  owner: object,
  scope: import('../current-operation-types.js').OriginalNativeDocTokenScope,
  since: number,
  limit: number,
  permission: 'replay' | 'stream' = 'replay'
) {
  const facet = readOriginalTokenNativeInputFacet(owner);
  const own = facet.restoredTokens.get(scope);
  if (!own || (permission !== 'replay' && permission !== 'stream'))
    throw new DocChannelNotFoundError();
  const prepared = facet.prepareTokenNativeRead(own);
  let allowed = false;
  for (let index = 0; index < prepared.data.permissions.length; index++)
    if (prepared.data.permissions[index] === permission) allowed = true;
  if (!allowed) throw new DocChannelNotFoundError();
  return documentTransaction(facet.db, () => {
    const current = facet.tokenNativeCurrent(own);
    const page = facet.tokenEventReader!.page(current.header, since, limit);
    facet.tokenNativeCurrent(own);
    return page;
  });
}
/** Read a token event under its original scope and requested permission. */
export async function readTokenEvent(
  owner: object,
  scope: import('../current-operation-types.js').OriginalNativeDocTokenScope,
  eventId: string,
  permission: 'replay' | 'stream'
) {
  const facet = readOriginalTokenNativeInputFacet(owner);
  const own = facet.restoredTokens.get(scope);
  if (!own || (permission !== 'replay' && permission !== 'stream'))
    throw new DocChannelNotFoundError();
  const prepared = facet.prepareTokenNativeRead(own);
  let allowed = false;
  for (let index = 0; index < prepared.data.permissions.length; index++)
    if (prepared.data.permissions[index] === permission) allowed = true;
  if (!allowed) throw new DocChannelNotFoundError();
  return documentTransaction(facet.db, () => {
    const current = facet.tokenNativeCurrent(own);
    const event = facet.tokenEventReader!.event(current.header, eventId);
    facet.tokenNativeCurrent(own);
    return event;
  });
}
/** Inspect a token input receipt through its original captured native scope. */
export async function inspectTokenInputReceipt(
  owner: object,
  scope: import('../current-operation-types.js').OriginalNativeDocTokenScope,
  eventId: string
) {
  const facet = readOriginalTokenNativeInputFacet(owner);
  const own = facet.restoredTokens.get(scope);
  if (!own) throw new DocChannelNotFoundError();
  const prepared = facet.prepareTokenNativeRead(own);
  if (
    !prepared.data.permissions.includes('ingest') ||
    !prepared.data.directions.includes('upstream')
  )
    throw new DocChannelNotFoundError();
  return documentTransaction(facet.db, () => {
    const current = facet.tokenNativeCurrent(own);
    const response = copyCurrentDocData(facet.tokenEventReader!.receipt(current.header, eventId));
    facet.tokenNativeCurrent(own);
    if (!sameCurrentDocData(response, facet.tokenEventReader!.receipt(current.header, eventId)))
      throw new DocChannelNotFoundError();
    return response as import('@dorkos/shared/canvas-channel-schemas').CanvasChannelEventReceipt;
  });
}
/** Submit a token input through the original current document and ingest scope. */
export async function submitTokenCurrent(
  owner: object,
  store: DocChannelStore,
  ingest: DocChannelIngest,
  grants: DocChannelGrants,
  tokenScope: import('../current-operation-types.js').OriginalNativeDocTokenScope,
  raw: unknown
) {
  const facet = readOriginalTokenNativeInputFacet(owner);
  const own = facet.restoredTokens.get(tokenScope);
  if (!own || own.store !== store || own.grants !== grants) throw new DocChannelNotFoundError();
  requireCurrentDocConstructorEngines(facet.authorization, store, ingest, grants);
  const before = facet.prepareTokenNativeRead(own);
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
    facet.db,
    before.header.documentId,
    observed
  );
  facet.prepareTokenNativeRead(own);
  facet.ensureRoom();
  let committedTx: DbTransaction | undefined, committedAt: string | undefined;
  try {
    const response = documentTransaction(facet.db, (tx) => {
      requireCurrentDocEngineOrigin(facet.authorization, facet.core, facet.db);
      if (facet.currentEntry || facet.scopes.has(tx)) throw new DocChannelNotFoundError();
      const current = facet.tokenNativeCurrent(own),
        rows = readCurrentDocBirthRows(tx, current.header.documentId);
      if (
        !rows ||
        rows.generation !== current.header.generation ||
        rows.channel.scope !== current.header.scope
      )
        throw new DocChannelNotFoundError();
      const scope: CurrentOperationScope = {
        authorization: facet.authorization,
        engine: facet.core,
        db: facet.db,
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
      facet.currentEntry = true;
      facet.activeCurrent.add(tx);
      facet.scopes.set(tx, scope);
      try {
        facet.finalCurrent(store, tx);
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
          facet.finalCurrent(store, tx);
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
        scope.access = prepareCurrentDocGrantRoutes(grants, store, facet.authorization, tx);
        scope.now = withCheckboxReadOnlyGate(facet.db, () =>
          captureCurrentDocIngestClock(ingest, store, facet.authorization, tx)
        );
        facet.finalCurrent(store, tx);
        const hasRoom = scope.access.routes.some(
          (decision) =>
            !decision.reason &&
            decision.route.to === 'room:self' &&
            decision.route.turn.mode !== 'none'
        );
        if (hasRoom && !facet.room) throw new DocChannelNotFoundError();
        if (hasRoom) facet.room!.prepare(store, grants, tx);
        facet.finalCurrent(store, tx);
        const result = acceptCurrentDocEventInTransaction(ingest, store, facet.authorization, tx);
        scope.acceptedDocSeq = result.receipt.docSeq;
        const response = copyCurrentDocData({
          receipt: result.receipt,
          deliveries: result.deliveries.map(publicCurrentDelivery),
        });
        if (hasRoom) facet.room!.seal(store, tx, readOriginalDocIngestLimits(ingest, store));
        facet.finalCurrent(store, tx);
        auditCurrentDocIngestRows(ingest, store, facet.authorization, tx);
        auditCurrentDocGrantRows(grants, store, facet.authorization, tx);
        if (hasRoom) {
          facet.room!.audit(store, grants, tx);
          committedTx = tx;
          committedAt = scope.now;
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
    if (committedTx) facet.room!.committed(committedTx, committedAt!);
    return response;
  } catch (cause) {
    if (committedTx) facet.room?.abandoned(committedTx);
    throw cause;
  }
}
