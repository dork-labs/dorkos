import { isServerPrincipal } from '../../../connectors/principal/server-principal.js';
import {
  CanvasChannelDeclarationSchema,
  type CanvasChannelDeclaration,
} from '@dorkos/shared/canvas-channel-schemas';
import { hashApprovalInput } from '../../../core/approvals/approval-input-hash.js';
import { validateDocGrantTarget } from '../grant-policy.js';
import {
  and,
  eq,
  isNull,
  canvasDocChannels,
  canvasDocGrants,
  type DbTransaction,
} from '@dorkos/db';
import { type CanvasChannelRoute } from '@dorkos/shared/canvas-channel-schemas';
import { type DocAppManifest } from '../app-manifest.js';
import { DocRouteGrantError, type DocGrantActor } from '../grant-policy.js';
import { grantCoreManifest } from './grant-current-core.js';
import { checkboxAuthorityClock } from '../writes/authority/authority-snapshot.js';
import { readOriginalGrantCreationView } from '../grant-revalidation.js';

/** Original grant responsibility, after exact private owner recognition. */
export function privateSuspendOriginalGrants(
  grantOwner: object,
  documentId: string,
  tx: DbTransaction
): void {
  const facet = readOriginalGrantCreationView(grantOwner);
  tx.update(canvasDocGrants)
    .set({ revokedAt: facet.privateNow() })
    .where(and(eq(canvasDocGrants.documentId, documentId), isNull(canvasDocGrants.revokedAt)))
    .run();
}

/** Original grant responsibility, after exact private owner recognition. */
export function privateRefreshOriginalAuthority(
  grantOwner: object,
  documentId: string,
  actor: DocGrantActor
): void {
  const facet = readOriginalGrantCreationView(grantOwner);
  if (facet.deps.db.$client.inTransaction)
    throw new DocRouteGrantError('AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY');
  let failure: { cause: unknown } | undefined;
  try {
    facet.store.transaction((tx) => {
      facet.privateAccess(documentId, actor, tx);
      const source = facet.originalTokenManifestReads.get(facet.originalOwner);
      if (!source || source.db !== facet.deps.db)
        throw new DocRouteGrantError('GRANT_AUTHORITY_LOST');
      let manifest: DocAppManifest | undefined;
      try {
        manifest = source.source(documentId, tx);
      } catch (cause) {
        failure = { cause };
      }
      const channel = facet.store.getChannel(documentId, tx)!;
      const hash = manifest?.hash ?? null;
      if (failure || channel.manifestHash !== hash) {
        let lateFailure: { cause: unknown } | undefined;
        try {
          tx.update(canvasDocChannels)
            .set({ manifestHash: hash, updatedAt: facet.privateNow() })
            .where(eq(canvasDocChannels.documentId, documentId))
            .run();
        } catch (cause) {
          lateFailure = { cause };
        }
        // Attempt the original suspension even if the channel update failed.
        try {
          facet.privateSuspendOriginalGrants(documentId, tx);
        } catch (cause) {
          lateFailure ??= { cause };
        }
        if (lateFailure) throw lateFailure.cause;
      }
    });
  } catch (cause) {
    failure ??= { cause };
  }
  if (failure) throw failure.cause;
}

/** Original grant responsibility, after exact private owner recognition. */
export function privateNow(grantOwner: object): string {
  const facet = readOriginalGrantCreationView(grantOwner);
  return new Date(checkboxAuthorityClock(() => facet.deps.now?.() ?? new Date())).toISOString();
}

/** Original grant responsibility, after exact private owner recognition. */
export function privateAccess(
  grantOwner: object,
  documentId: string,
  actor: DocGrantActor,
  tx?: DbTransaction
): { id: string; scope: string } {
  const facet = readOriginalGrantCreationView(grantOwner);
  if (!isServerPrincipal(actor.principal)) throw new DocRouteGrantError('INVALID_PRINCIPAL');
  return facet.deps.authority.requireCurrent(documentId, actor, true, tx);
}

/** Replace declarations as data, invalidating old authority without routing old events. */
export function configure(
  grantOwner: object,
  documentId: string,
  declaration: CanvasChannelDeclaration,
  actor: DocGrantActor,
  selectedOpenerAgentId?: string
): void {
  const facet = readOriginalGrantCreationView(grantOwner);
  return facet.privateConfigure(documentId, declaration, actor, selectedOpenerAgentId);
}

/** Original grant responsibility, after exact private owner recognition. */
export function privateConfigure(
  grantOwner: object,
  documentId: string,
  declaration: CanvasChannelDeclaration,
  actor: DocGrantActor,
  selectedOpenerAgentId?: string
): void {
  const facet = readOriginalGrantCreationView(grantOwner);
  const validated = CanvasChannelDeclarationSchema.parse(declaration);
  facet.privateRefreshOriginalAuthority(documentId, actor);
  facet.store.transaction((tx) => {
    const { scope } = facet.privateAccess(documentId, actor, tx);
    const channel = facet.store.getChannel(documentId, tx)!;
    const claims = actor.principal.claims;
    const actorAgent = claims.kind === 'agent' || claims.kind === 'runtime' ? claims.agentId : null;
    if (claims.kind !== 'operator' && (!actorAgent || actorAgent !== channel.openerAgentId))
      throw new DocRouteGrantError('OPENER_REQUIRED');
    let openerAgentId = channel.openerAgentId;
    if (selectedOpenerAgentId) {
      if (claims.kind !== 'operator' || (openerAgentId && openerAgentId !== selectedOpenerAgentId))
        throw new DocRouteGrantError('OPENER_IMMUTABLE');
      const route: CanvasChannelRoute = {
        id: 'opener-selection',
        on: 'doc.opened',
        to: `agent:${selectedOpenerAgentId}`,
        turn: { mode: 'none' },
      };
      const target = facet.deps.authority.resolveTarget(
        { documentId, scope, route, openerAgentId },
        tx
      );
      validateDocGrantTarget(scope, route, openerAgentId, target);
      openerAgentId = selectedOpenerAgentId;
    }
    const declarationHash = hashApprovalInput(validated);
    if (channel.declarationHash !== declarationHash)
      facet.privateSuspendOriginalGrants(documentId, tx);
    tx.update(canvasDocChannels)
      .set({
        declaration: validated,
        declarationHash,
        openerAgentId,
        updatedAt: facet.privateNow(),
      })
      .where(eq(canvasDocChannels.documentId, documentId))
      .run();
    grantCoreManifest(facet.deps, documentId, tx);
  });
}

/** Explicit revoke; a later grant never implicitly retries input saved under this one. */
export function revoke(
  grantOwner: object,
  documentId: string,
  grantId: string,
  actor: DocGrantActor
): void {
  const facet = readOriginalGrantCreationView(grantOwner);
  return facet.privateRevoke(documentId, grantId, actor);
}

/** Original grant responsibility, after exact private owner recognition. */
export function privateRevoke(
  grantOwner: object,
  documentId: string,
  grantId: string,
  actor: DocGrantActor
): void {
  const facet = readOriginalGrantCreationView(grantOwner);
  facet.store.transaction((tx) => {
    facet.privateAccess(documentId, actor, tx);
    const row = facet.store.getGrant(grantId, tx);
    if (!row || row.documentId !== documentId) throw new DocRouteGrantError('GRANT_NOT_FOUND', 404);
    const claims = actor.principal.claims;
    if (
      claims.kind !== 'operator' &&
      (!(claims.kind === 'agent' || claims.kind === 'runtime') ||
        claims.agentId !== row.openerAgentId)
    )
      throw new DocRouteGrantError('OPENER_REQUIRED');
    facet.store.revokeGrant(grantId, row.revision, facet.privateNow(), tx);
  });
}
