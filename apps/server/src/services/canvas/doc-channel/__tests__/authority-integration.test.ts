/** Actual approval evidence and physical canonical movement share one durable identity. */
import { expect, it } from 'vitest';
import { agents, approvals as approvalRows, eq, sessionMetadata } from '@dorkos/db';
import { ApprovalService } from '../../../core/approvals/approval-service.js';
import {
  createServerPrincipal,
  isServerPrincipal,
} from '../../../connectors/principal/server-principal.js';
import { DocChannelAuthorization } from '../authorization.js';
import { DocChannelGrants } from '../grants.js';
import type { DocGrantAuthority } from '../grant-policy.js';
import { FROM, TO, harness } from './lifecycle-fixtures.js';

it('preserves consumed approval evidence through a same-path canonical move and refuses later relocation', () => {
  const h = harness();
  const owner = { kind: 'local_install' as const, installationId: 'installation' };
  const actor = {
    surface: 'capability' as const,
    principal: createServerPrincipal({ kind: 'operator', owner }),
  };
  try {
    const document = h.canvas.open(FROM, 'human', { type: 'json', data: { unchanged: true } });
    const authorization = new DocChannelAuthorization(h.db, h.documents, {
      ownsInstallation: (claims) =>
        claims.owner.kind === 'local_install' &&
        claims.owner.installationId === owner.installationId,
      principalCurrent: (proof) => isServerPrincipal(proof) && proof.claims.kind === 'operator',
      roomMembership: () => undefined,
    });
    const authority: DocGrantAuthority = {
      resolveScope: (scope) => h.documents.lifecycle.resolveScope(scope),
      requireCurrent: (...args) => authorization.requireCurrent(...args),
      requireGrantedCurrent: (grant, tx) => {
        const evidence = grant.approvalEvidence as {
          binding?: { origin?: { owner?: { kind?: string; installationId?: string } } };
          approvalId?: string;
          consumedAt?: string;
        };
        // Use the actual recorded approval and verified current fixture owner;
        // canonical physical readiness still goes through document authorization.
        const recordedOwner = evidence.binding?.origin?.owner;
        if (
          recordedOwner?.kind !== owner.kind ||
          recordedOwner.installationId !== owner.installationId
        )
          throw new Error('Recorded owner authority is unavailable');
        const approval = tx
          .select()
          .from(approvalRows)
          .where(eq(approvalRows.id, grant.approvalId!))
          .get();
        if (
          !approval ||
          approval.state !== 'granted' ||
          !approval.consumedAt ||
          approval.id !== evidence.approvalId ||
          approval.consumedAt !== evidence.consumedAt
        )
          throw new Error('Consumed approval authority is unavailable');
        return authorization.requireCurrent(grant.documentId, actor, true, tx);
      },
      sourceRoot: () => null,
      originCurrent: () =>
        h.db.select().from(agents).where(eq(agents.id, 'agent-1')).get()?.status === 'active',
      resolveTarget: ({ scope }) => {
        const session = h.db
          .select()
          .from(sessionMetadata)
          .where(eq(sessionMetadata.sessionId, scope.slice('session:'.length)))
          .get()!;
        const agent = h.db.select().from(agents).where(eq(agents.id, 'agent-1')).get()!;
        if (session.agentPath !== agent.projectPath || session.runtime !== agent.runtime)
          throw new Error('Target changed');
        return {
          scope,
          agentId: agent.id,
          sessionId: session.sessionId,
          runtime: session.runtime,
          agentPath: agent.projectPath,
        };
      },
    };
    const approvals = new ApprovalService(h.db);
    const grants = new DocChannelGrants({ db: h.db, store: h.store, approvals, authority });
    grants.configure(
      document.id,
      {
        routes: [
          {
            id: 'route',
            on: 'task.*',
            to: 'agent:owner',
            turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
          },
        ],
      },
      actor,
      'agent-1'
    );
    const request = {
      documentId: document.id,
      routeId: 'route',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const prepared = grants.grant(request, actor);
    expect(prepared.kind).toBe('approval_required');
    if (prepared.kind !== 'approval_required') throw new Error('Expected actual approval');
    approvals.grant(prepared.ticket.approvalId);
    const granted = grants.grant(request, actor, prepared.ticket.token);
    if (granted.kind !== 'granted') throw new Error('Expected consumed approval');
    const originalEvidence = structuredClone(granted.grant.approvalEvidence);
    h.documents.rekeyScope(FROM, TO);
    expect(h.store.getGrant(granted.grant.grantId)).toMatchObject({
      targetSessionId: 'canonical',
      approvalEvidence: originalEvidence,
    });
    expect(grants.revalidateGrant(document.id, granted.grant.grantId, actor).targetSessionId).toBe(
      'canonical'
    );
    expect(grants.getCurrentRoutes(document.id, 'task.comment', actor)[0]).toMatchObject({
      grantId: granted.grant.grantId,
      grantRevision: granted.grant.revision,
    });
    expect(h.canvas.get(TO, document.id)?.content).toEqual({
      type: 'json',
      data: { unchanged: true },
    });
    h.db
      .update(agents)
      .set({ projectPath: '/agents/relocated' })
      .where(eq(agents.id, 'agent-1'))
      .run();
    h.db.update(sessionMetadata).set({ agentPath: '/agents/relocated' }).run();
    expect(() => grants.revalidateGrant(document.id, granted.grant.grantId, actor)).toThrow(
      'TARGET_IDENTITY_CHANGED'
    );
    expect(grants.getCurrentRoutes(document.id, 'task.comment', actor)[0]).toMatchObject({
      reason: 'TARGET_IDENTITY_CHANGED',
    });
    expect(h.store.getGrant(granted.grant.grantId)?.approvalEvidence).toEqual(originalEvidence);
  } finally {
    h.db.$client.close();
  }
});
