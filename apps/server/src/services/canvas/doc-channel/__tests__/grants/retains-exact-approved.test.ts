import {
  owner,
  actor,
  operator,
  ownRoute,
  otherRoute,
  request,
  configure,
  approved,
  grant,
  st,
} from './harness.js';
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  approvals,
  agents,
  sessionMetadata,
  canvasDocEvents,
  canvasDocGrants,
  eq,
} from '@dorkos/db';
import { eventFanOut } from '../../../../core/event-fan-out.js';
import { createServerPrincipal } from '../../../../connectors/principal/server-principal.js';
import { createDocChannelGrantCapabilities } from '../../grant-capabilities.js';

describe('independent exact document route grants', () => {
  it('retains the exact approved path when all mutable agent and session records relocate', () => {
    const now = st.clock.toISOString();
    st.db
      .insert(agents)
      .values({
        id: 'other',
        name: 'Other',
        runtime: 'claude-code',
        projectPath: '/tmp/approved',
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    st.db
      .insert(sessionMetadata)
      .values([
        {
          sessionId: 'session-a',
          runtime: 'claude-code',
          agentPath: '/tmp/approved',
          createdAt: now,
        },
        {
          sessionId: 'canonical',
          runtime: 'claude-code',
          agentPath: '/tmp/approved',
          createdAt: now,
        },
      ])
      .run();
    st.authority.resolveTarget = () => {
      const agent = st.db.select().from(agents).where(eq(agents.id, 'other')).get()!;
      const session = st.db
        .select()
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, 'session-a'))
        .get()!;
      return {
        agentId: agent.id,
        sessionId: session.sessionId,
        runtime: session.runtime,
        scope: 'session:session-a',
        agentPath: agent.projectPath,
      };
    };
    configure(otherRoute);
    const ticket = approved();
    const row = grant(request(), ticket.token);
    expect(st.service.revalidateGrant('doc-a', row.grantId, actor).grantId).toBe(row.grantId);
    st.db.update(agents).set({ projectPath: '/tmp/relocated' }).where(eq(agents.id, 'other')).run();
    st.db.update(sessionMetadata).set({ agentPath: '/tmp/relocated' }).run();
    expect(() => st.service.revalidateGrant('doc-a', row.grantId, actor)).toThrow(
      'TARGET_IDENTITY_CHANGED'
    );
    expect(
      (
        st.store.getGrant(row.grantId)!.approvalEvidence as {
          binding: { target: { agentPath: string } };
        }
      ).binding.target.agentPath
    ).toBe('/tmp/approved');
  });

  it('logs without declarations and gives declared unapproved routes an explicit saved-only reason', () => {
    expect(st.service.getCurrentRoutes('doc-a', 'task.toggled', actor)).toEqual([]);
    configure(otherRoute);
    st.currentTarget.agentId = 'other';
    expect(st.service.getCurrentRoutes('doc-a', 'task.toggled', actor)).toEqual([
      { route: otherRoute, reason: 'ROUTE_UNAPPROVED' },
    ]);
    expect(st.service.getCurrentRoutes('doc-a', 'tasking.toggled', actor)).toEqual([]);
  });

  it('lets only the verified recorded opener enable its bounded own route or log route', () => {
    configure();
    const row = grant();
    expect(row.approvalId).toBeNull();
    expect(row.approvedBy).toBe('opener');
    expect(row.limits).toEqual({ envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 });
    expect(st.service.getCurrentRoutes('doc-a', 'task.toggled', actor)[0]?.grantId).toBe(
      row.grantId
    );
    expect(grant().grantId).toBe(row.grantId);
    expect(() =>
      st.service.configure(
        'doc-a',
        { routes: [ownRoute] },
        {
          ...actor,
          principal: createServerPrincipal({
            kind: 'agent',
            owner,
            agentId: 'viewer',
            agentPath: '/tmp/viewer',
          }),
        }
      )
    ).toThrow('OPENER_REQUIRED');
    expect(() => st.service.configure('doc-a', { routes: [] }, operator, 'other')).toThrow(
      'OPENER_IMMUTABLE'
    );
    configure({ ...ownRoute, to: 'log', turn: { mode: 'none' } });
    expect(grant().targetAgentId).toBeNull();
  });

  it('requires actual matching operator approval for another target, independent of permission defaults', () => {
    configure(otherRoute);
    st.currentTarget.agentId = 'other';
    const ticket = approved();
    const row = grant(request(), ticket.token);
    expect(row.approvedBy).toBe(`approval:${ticket.approvalId}`);
    expect(row.approvalEvidence).toMatchObject({
      kind: 'operator_approval',
      approvalId: ticket.approvalId,
      state: 'granted',
    });
    expect((row.approvalEvidence as { inputHash: string }).inputHash).toBe(
      st.db.select().from(approvals).where(eq(approvals.id, ticket.approvalId)).get()?.inputHash
    );
    expect(grant(request(), ticket.token).grantId).toBe(row.grantId);
    expect(st.db.select().from(canvasDocGrants).all()).toHaveLength(1);
  });

  it('does not treat capability permission mode or a synthetic approving actor as route approval', async () => {
    configure(otherRoute);
    st.currentTarget.agentId = 'other';
    const capability = createDocChannelGrantCapabilities(st.service).find(
      (item) => item.id === 'ui.approve_doc_route'
    )!;
    const output = await capability.invoke({} as never, request(), {
      serverPrincipal: actor.principal,
      permissionMode: 'bypassPermissions',
      approval: { approvedBy: 'invented-person', token: 'invented-token' },
    } as never);
    expect(output).toMatchObject({ kind: 'approval_required' });
    expect(st.db.select().from(canvasDocGrants).all()).toHaveLength(0);
  });

  it('refuses an approval subject too large for the real approval card instead of truncating exact types', () => {
    configure(otherRoute);
    st.currentTarget.agentId = 'other';
    const allowedTypes = Array.from({ length: 128 }, (_, i) => `task.${'a'.repeat(64)}${i}`);
    expect(() => st.service.grant(request({ allowedTypes }), actor)).toThrow(
      'APPROVAL_SUBJECT_TOO_LARGE'
    );
    expect(st.db.select().from(approvals).all()).toHaveLength(0);
  });

  it('refuses pending, denied and mismatched actual verdicts without a grant', () => {
    configure(otherRoute);
    st.currentTarget.agentId = 'other';
    const pending = st.service.grant(request(), actor);
    if (pending.kind !== 'approval_required') throw new Error('ticket');
    expect(() => grant(request(), pending.ticket.token)).toThrow('APPROVAL_PENDING');
    st.approval.deny(pending.ticket.approvalId, 'No');
    expect(() => grant(request(), pending.ticket.token)).toThrow('APPROVAL_DENIED');
    const ticket = approved();
    expect(() => grant(request({ limits: { eventsPerMinute: 1 } }), ticket.token)).toThrow(
      'APPROVAL_MISMATCHED'
    );
    expect(st.db.select().from(canvasDocGrants).all()).toHaveLength(0);
    expect(grant(request(), ticket.token).approvalId).toBe(ticket.approvalId);
  });

  it('requires a real outer commit boundary for grant creation and manifest refresh', () => {
    configure();
    expect(() => st.store.transaction(() => st.service.grant(request(), actor))).toThrow(
      'AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY'
    );
    expect(st.db.select().from(canvasDocGrants).all()).toHaveLength(0);
  });

  it('rolls back approval consumption on failed grant persistence and safely retries the same token', () => {
    configure(otherRoute);
    st.currentTarget.agentId = 'other';
    const ticket = approved();
    const insertion = vi.spyOn(st.store, 'insertGrant').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const broadcast = vi.mocked(eventFanOut.broadcast);
    broadcast.mockClear();
    expect(() => grant(request(), ticket.token)).toThrow('disk full');
    expect(broadcast).not.toHaveBeenCalled();
    expect(
      st.db.select().from(approvals).where(eq(approvals.id, ticket.approvalId)).get()?.consumedAt
    ).toBeNull();
    expect(st.db.select().from(canvasDocGrants).all()).toHaveLength(0);
    insertion.mockRestore();
    expect(grant(request(), ticket.token).approvalId).toBe(ticket.approvalId);
    const consumed = () =>
      broadcast.mock.calls.filter(
        ([event, data]) =>
          event === 'approval_resolved' && (data as { outcome?: string }).outcome === 'consumed'
      );
    expect(consumed()).toHaveLength(1);
    expect(st.db.select().from(canvasDocGrants).all()).toHaveLength(1);
    grant(request(), ticket.token);
    expect(consumed()).toHaveLength(1);
  });

  it('rechecks target and current origin after approval preparation, before insertion', () => {
    configure(otherRoute);
    st.currentTarget.agentId = 'other';
    const ticket = approved();
    const consume = st.approval.consume.bind(st.approval);
    vi.spyOn(st.approval, 'consume').mockImplementation((token, binding, options) => {
      const verdict = consume(token, binding, options);
      st.currentTarget.runtime = 'codex';
      return verdict;
    });
    expect(() => grant(request(), ticket.token)).toThrow('GRANT_BINDING_CHANGED');
    expect(st.db.select().from(canvasDocGrants).all()).toHaveLength(0);
    expect(
      st.db.select().from(approvals).where(eq(approvals.id, ticket.approvalId)).get()?.consumedAt
    ).toBeNull();
    st.currentOrigin = false;
    expect(() => grant()).toThrow('ORIGIN_AUTHORITY_LOST');
  });

  it('refuses counterfeit principals, cross-scope targets and unsupported room routes', () => {
    configure();
    expect(() =>
      st.service.grant(request(), {
        ...actor,
        principal: JSON.parse(JSON.stringify(actor.principal)),
      })
    ).toThrow('INVALID_PRINCIPAL');
    st.currentTarget.scope = 'room:elsewhere';
    expect(() => grant()).toThrow('TARGET_SCOPE_MISMATCH');
    st.currentTarget.scope = 'session:session-a';
    configure({ ...ownRoute, to: 'room:self' });
    expect(() => grant()).toThrow('ROOM_ROUTE_UNAVAILABLE');
  });

  it('suspends hash-changed grants, enforces narrowed payload/caps and never silently replays saved input', () => {
    configure();
    const row = grant();
    st.store.appendEvent({
      documentId: 'doc-a',
      eventId: 'saved-input',
      direction: 'upstream',
      type: 'task.toggled',
      payload: { checked: true },
      envelopeHash: 'hash',
      receivedAt: st.clock.toISOString(),
      provenance: {},
    });
    fs.writeFileSync(
      path.join(st.dir, '.dork/app.json'),
      JSON.stringify({
        v: 1,
        types: {
          'task.toggled': {
            type: 'object',
            properties: { checked: { type: 'boolean' } },
            required: ['checked'],
            additionalProperties: false,
          },
        },
        limits: { envelopeBytes: 1024, eventsPerMinute: 2, turnsPerHour: 1 },
      })
    );
    expect(st.service.getCurrentRoutes('doc-a', 'task.toggled', actor)[0]?.reason).toBe(
      'MANIFEST_CHANGED'
    );
    expect(st.store.getGrant(row.grantId)?.revokedAt).not.toBeNull();
    expect(st.service.getEffectiveLimits('doc-a', actor)).toEqual({
      envelopeBytes: 1024,
      eventsPerMinute: 2,
      turnsPerHour: 1,
    });
    expect(() =>
      st.service.validateEventPayload('doc-a', 'task.toggled', { checked: 'true' }, actor)
    ).toThrow('INVALID_DECLARED_PAYLOAD');
    expect(() =>
      st.service.validateEventPayload('doc-a', 'task.toggled', { checked: true }, actor)
    ).not.toThrow();
    grant();
    expect(st.db.select().from(canvasDocEvents).all()).toHaveLength(1);
    expect(st.store.listDeliveries('doc-a', 'saved-input')).toEqual([]);
  });
});
