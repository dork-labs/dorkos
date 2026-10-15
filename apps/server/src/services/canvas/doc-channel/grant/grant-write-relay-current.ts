import {
  and,
  eq,
  isNull,
  canvasDocChannels,
  approvals,
  canvasDocGrants,
  type DbTransaction,
} from '@dorkos/db';
import { redactSecretsInText } from '../../../core/approvals/approval-summary.js';
import { type DocGrantRow, type DocBatchRow } from '../store.js';
import { type DocAppManifest } from '../app-manifest.js';
import {
  DocRouteGrantError,
  declaredRoute,
  type DocGrantActor,
  type DocGrantTarget,
  type DocOriginalWriteObservation,
} from '../grant-policy.js';
import { documentTransaction } from '../storage/store-transaction.js';
import {
  grantCoreNow,
  grantCoreAccess,
  grantCoreVerifyCurrentGrant,
} from './grant-current-core.js';
import { sameCurrentDocData } from '../current/current-operation-data.js';
import {
  withCheckboxReadOnlyGate,
  checkboxAuthorityClock,
  captureCheckboxGrantContext,
} from '../writes/authority/authority-snapshot.js';
import { readOriginalGrantRevalidationView } from '../grant-revalidation.js';

/** Pure original write grant check: supplied observation replaces ONLY legacy filesystem ports. */
export function revalidateOriginalWriteGrant(
  grantOwner: object,
  documentId: string,
  grantId: string,
  revision: number,
  scope: string,
  observed: DocOriginalWriteObservation,
  tx: DbTransaction
): DocGrantRow {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  const capturedTime = checkboxAuthorityClock(() => facet.services.now?.() ?? new Date());
  const original = facet.services.store.getGrant(grantId, tx);
  if (
    !original ||
    original.documentId !== documentId ||
    original.revision !== revision ||
    !original.routeId
  )
    throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  const channel = facet.services.store.getChannel(documentId, tx);
  if (!channel) throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
  const context = captureCheckboxGrantContext(
    facet.services.authority,
    original,
    channel,
    scope,
    tx
  );
  const fresh = facet.services.store.getGrant(grantId, tx);
  if (!fresh || fresh.documentId !== documentId || fresh.revision !== revision)
    throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  const evidence = fresh.approvalEvidence as {
    kind?: string;
    binding?: unknown;
    approvalId?: string;
    inputHash?: string;
  };
  const approval = fresh.approvalId
    ? tx.select().from(approvals).where(eq(approvals.id, fresh.approvalId)).get()
    : undefined;
  if (
    evidence.kind !== 'operator_approval' ||
    !approval ||
    !approval.detail ||
    approval.detail !== redactSecretsInText(JSON.stringify(evidence.binding))
  )
    throw new DocRouteGrantError('GRANT_EVIDENCE_MISMATCH');
  return grantCoreVerifyCurrentGrant(
    {
      ...facet.services,
      authority: { ...facet.services.authority, ...context },
      now: () => new Date(capturedTime),
    },
    documentId,
    grantId,
    scope,
    tx,
    observed
  );
}

/**
 * Background dispatch uses persisted server grant evidence, never an expired
 * opener-turn proof or a freshly minted broad operator identity.
 */
export function revalidateBatchGrant(
  grantOwner: object,
  batch: DocBatchRow,
  tx: DbTransaction
): { grant: DocGrantRow; target: DocGrantTarget } {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  const current = facet.services.store.getBatch(batch.batchId, tx);
  if (
    !current ||
    current.documentId !== batch.documentId ||
    current.generation !== batch.generation ||
    current.grantId !== batch.grantId ||
    current.grantRevision !== batch.grantRevision ||
    current.routeId !== batch.routeId
  )
    throw new DocRouteGrantError('BATCH_BINDING_CHANGED');
  const grant = facet.services.store.getGrant(current.grantId, tx);
  if (
    !grant ||
    grant.documentId !== current.documentId ||
    grant.revision !== current.grantRevision ||
    grant.routeId !== current.routeId
  )
    throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  const access = facet.services.authority.requireGrantedCurrent(grant, tx);
  if (
    access.id !== current.documentId ||
    access.scope !== facet.services.authority.resolveScope(current.scope, tx)
  )
    throw new DocRouteGrantError('BATCH_SCOPE_CHANGED');
  const verified = facet.verifyCurrentGrant(current.documentId, grant.grantId, access.scope, tx);
  return {
    grant: verified,
    target: facet.services.authority.resolveTarget(
      {
        documentId: current.documentId,
        scope: access.scope,
        route: declaredRoute(
          facet.services.store.getChannel(current.documentId, tx)!,
          current.routeId
        ),
        openerAgentId: verified.openerAgentId,
      },
      tx
    ),
  };
}

/** Original base responsibility, after exact private owner recognition. */
export function privateRelayRefresh(grantOwner: object, grantId: string): void {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  const services = facet.fixedServices;
  if (services.db.$client.inTransaction)
    throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
  const failure = documentTransaction(services.db, (tx) => {
    const observed = withCheckboxReadOnlyGate(services.db, () => {
      const grant = facet.relayStore.getGrant(grantId, tx);
      if (!grant) throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
      services.authority.requireGrantedCurrent(grant, tx);
      let manifest: DocAppManifest | undefined;
      let failure: { cause: unknown } | undefined;
      try {
        manifest = facet.tokenManifestReader.read(
          services.authority.sourceRoot(grant.documentId, tx)
        );
      } catch (cause) {
        failure = { cause };
      }
      return {
        documentId: grant.documentId,
        hash: manifest?.hash ?? null,
        now: facet.privateFixedNow(),
        failure,
      };
    });
    const channel = facet.privateReadCurrentChannel(observed.documentId, tx);
    if (!channel) throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
    if (observed.failure || channel.manifestHash !== observed.hash) {
      tx.update(canvasDocChannels)
        .set({ manifestHash: observed.hash, updatedAt: observed.now })
        .where(eq(canvasDocChannels.documentId, observed.documentId))
        .run();
      tx.update(canvasDocGrants)
        .set({ revokedAt: observed.now })
        .where(
          and(
            eq(canvasDocGrants.documentId, observed.documentId),
            isNull(canvasDocGrants.revokedAt)
          )
        )
        .run();
    }
    return observed.failure;
  });
  if (failure) throw failure.cause;
}

/** Original base responsibility, after exact private owner recognition. */
export function privateRelayBatch(
  grantOwner: object,
  batch: DocBatchRow,
  tx: DbTransaction
): { grant: DocGrantRow; target: DocGrantTarget } {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  const current = facet.relayStore.getBatch(batch.batchId, tx);
  if (
    !current ||
    current.documentId !== batch.documentId ||
    current.generation !== batch.generation ||
    current.grantId !== batch.grantId ||
    current.grantRevision !== batch.grantRevision ||
    current.routeId !== batch.routeId
  )
    throw new DocRouteGrantError('BATCH_BINDING_CHANGED');
  const grant = facet.relayStore.getGrant(current.grantId, tx);
  if (
    !grant ||
    grant.documentId !== current.documentId ||
    grant.revision !== current.grantRevision ||
    grant.routeId !== current.routeId
  )
    throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
  const services = facet.fixedServices;
  return withCheckboxReadOnlyGate(services.db, () => {
    const before = facet.privateSourceRows(current.documentId, tx);
    const access = services.authority.requireGrantedCurrent(grant, tx);
    if (
      access.id !== current.documentId ||
      access.scope !== services.authority.resolveScope(current.scope, tx)
    )
      throw new DocRouteGrantError('BATCH_SCOPE_CHANGED');
    const verified = grantCoreVerifyCurrentGrant(
      services,
      current.documentId,
      grant.grantId,
      access.scope,
      tx
    );
    const channel = facet.relayStore.getChannel(current.documentId, tx);
    if (!channel) throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
    const target = services.authority.resolveTarget(
      {
        documentId: current.documentId,
        scope: access.scope,
        route: declaredRoute(channel, current.routeId),
        openerAgentId: verified.openerAgentId,
      },
      tx
    );
    const after = facet.privateSourceRows(current.documentId, tx);
    if (!sameCurrentDocData(before, after)) throw new DocRouteGrantError('GRANT_BINDING_CHANGED');
    return { grant: verified, target };
  });
}

/** Original base responsibility, after exact private owner recognition. */
export function privateFixedNow(grantOwner: object): string {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  return grantCoreNow(facet.fixedServices);
}

/** Original base responsibility, after exact private owner recognition. */
export function privateFixedAccess(
  grantOwner: object,
  documentId: string,
  actor: DocGrantActor,
  tx?: DbTransaction
): { id: string; scope: string } {
  const facet = readOriginalGrantRevalidationView(grantOwner);
  return grantCoreAccess(facet.fixedServices, documentId, actor, tx);
}
