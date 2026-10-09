/** Narrow responder checks permit a granted target to acknowledge a document without reading its owning session. */
import { agents, sessionMetadata, eq } from '@dorkos/db';
import {
  isServerPrincipal,
  type ServerPrincipalProof,
  type ServerPrincipalClaims,
} from '../../../connectors/principal/server-principal.js';
import type { DocChannelAuthorization } from '../authorization.js';
import type { DocChannelGrants } from '../grants.js';
import type { DocChannelStore } from '../store.js';
import { DocDownstreamError, type DocDownstreamAuthority } from './service.js';

/** Required live runtime binding check and durable canonical identity resolution. */
export interface DocResponderPorts {
  principalCurrent(proof: ServerPrincipalProof): boolean;
  ownsInstallation(claims: ServerPrincipalClaims): boolean;
  resolveScope(scope: string): string;
  revalidateRuntime(proof: ServerPrincipalProof): Promise<boolean>;
}
/** Compose owning-scope writes and approved runtime preflight; Room sends still require native responder custody. */
export function createDocDownstreamAuthority(
  store: DocChannelStore,
  authorization: DocChannelAuthorization,
  grants: DocChannelGrants,
  ports: DocResponderPorts
): DocDownstreamAuthority {
  const refuse = (): never => {
    throw new DocDownstreamError('CANVAS_DOCUMENT_NOT_FOUND', 404);
  };
  return {
    async prepare(documentId, actor, batchId) {
      if (!batchId) {
        await authorization.require(documentId, actor, true);
        return;
      }
      if (
        !isServerPrincipal(actor.principal) ||
        actor.principal.claims.kind !== 'runtime' ||
        !ports.ownsInstallation(actor.principal.claims) ||
        !ports.principalCurrent(actor.principal) ||
        !(await ports.revalidateRuntime(actor.principal))
      )
        refuse();
      const batch = store.getBatch(batchId);
      if (!batch || batch.documentId !== documentId) refuse();
      const grant = store.getGrant(batch!.grantId);
      const claims = actor.principal.claims;
      if (
        claims.kind !== 'runtime' ||
        !grant ||
        grant.documentId !== documentId ||
        grant.targetAgentId !== claims.agentId ||
        grant.targetRuntime !== claims.runtime
      )
        refuse();
      if (
        !batch!.scope.startsWith('room:') &&
        (claims.kind !== 'runtime' ||
          !grant!.targetSessionId ||
          ports.resolveScope(`session:${grant!.targetSessionId}`) !==
            ports.resolveScope(`session:${claims.canonicalSessionId}`))
      )
        refuse();
      grants.refreshGrantedAuthority(batch!.grantId);
      // Room preflight does not authorize a write: send must enter the original committed emission frame.
    },
    requireWriteCurrent(documentId, actor, tx) {
      const identity = authorization.requireCurrent(documentId, actor, true, tx);
      const claims = actor.principal.claims;
      return {
        ...identity,
        senderKey:
          claims.kind === 'runtime'
            ? `runtime:${claims.runtime}:${claims.agentId}`
            : `principal:${JSON.stringify(claims)}`,
        evidence: { kind: claims.kind },
      };
    },
    requireResponderCurrent(documentId, batch, actor, tx) {
      if (
        !isServerPrincipal(actor.principal) ||
        actor.surface !== 'capability' ||
        !ports.ownsInstallation(actor.principal.claims) ||
        !ports.principalCurrent(actor.principal)
      )
        refuse();
      const claims = actor.principal.claims;
      if (claims.kind !== 'runtime') return refuse();
      const { grant, target } = grants.revalidateBatchGrant(batch, tx);
      if (target.scope.startsWith('room:'))
        throw new DocDownstreamError('ROOM_APP_ACK_RESPONDER_UNAVAILABLE', 409);
      const scope = ports.resolveScope(`session:${claims.canonicalSessionId}`);
      const session = tx
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, scope.slice(8)))
        .get();
      const agent = tx.select().from(agents).where(eq(agents.id, claims.agentId)).get();
      if (
        grant.documentId !== documentId ||
        target.agentId !== claims.agentId ||
        target.runtime !== claims.runtime ||
        !target.sessionId ||
        ports.resolveScope(`session:${target.sessionId}`) !== scope ||
        target.agentPath !== claims.agentPath ||
        session?.runtime !== claims.runtime ||
        session.agentPath !== claims.agentPath ||
        agent?.status !== 'active' ||
        agent.runtime !== claims.runtime ||
        agent.projectPath !== claims.agentPath ||
        !['accepted', 'dispatching', 'turn_started', 'turn_done', 'failed', 'in_doubt'].includes(
          batch.status
        )
      )
        refuse();
      return {
        id: documentId,
        scope: batch.scope,
        senderKey: `runtime:${claims.runtime}:${claims.agentId}`,
        evidence: {
          agentId: claims.agentId,
          runtime: claims.runtime,
          sessionId: scope.slice(8),
          agentPath: claims.agentPath,
          grantId: grant.grantId,
          grantRevision: grant.revision,
          bindingId: claims.bindingId,
        },
      };
    },
  };
}
