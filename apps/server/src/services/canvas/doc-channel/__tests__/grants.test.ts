import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  approvals,
  canvasDocEvents,
  canvasDocGrants,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { ApprovalService } from '../../../core/approvals/approval-service.js';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { DocChannelStore } from '../store.js';
import { DocChannelGrants } from '../grants.js';
import { createDocChannelGrantCapabilities } from '../grant-capabilities.js';
import {
  containedPattern,
  DocRouteGrantError,
  type DocGrantActor,
  type DocGrantAuthority,
  type DocRouteGrantRequest,
  type DocGrantTarget,
} from '../grant-policy.js';
import type { CanvasChannelRoute } from '@dorkos/shared/canvas-channel-schemas';

const owner = { kind: 'local_install' as const, installationId: 'installation' };
const actor: DocGrantActor = {
  surface: 'capability',
  principal: createServerPrincipal({
    kind: 'runtime',
    owner,
    bindingId: 'binding',
    runtime: 'claude-code',
    canonicalSessionId: 'session-a',
    agentId: 'opener',
    agentPath: '/tmp/opener',
  }),
};
const operator: DocGrantActor = {
  surface: 'capability',
  principal: createServerPrincipal({ kind: 'operator', owner }),
};
const ownRoute: CanvasChannelRoute = {
  id: 'route-a',
  on: 'task.*',
  to: 'agent:owner',
  turn: { mode: 'coalesce', windowMs: 1000, maxBatch: 100 },
};
const otherRoute: CanvasChannelRoute = { ...ownRoute, to: 'agent:other' };
let db: Db;
let store: DocChannelStore;
let approval: ApprovalService;
let service: DocChannelGrants;
let authority: DocGrantAuthority;
let dir: string;
let currentTarget: DocGrantTarget;
let currentOrigin: boolean;
let allowed: boolean;
let clock: Date;
function request(overrides: Partial<DocRouteGrantRequest> = {}): DocRouteGrantRequest {
  return {
    documentId: 'doc-a',
    routeId: 'route-a',
    expiresAt: new Date(clock.getTime() + 3600000).toISOString(),
    ...overrides,
  };
}
function configure(route = ownRoute): void {
  service.configure('doc-a', { routes: [route] }, actor);
}
function approved(req = request()) {
  const result = service.grant(req, actor);
  expect(result.kind).toBe('approval_required');
  if (result.kind !== 'approval_required') throw new Error('Expected approval ticket');
  expect(approval.grant(result.ticket.approvalId)).toBeUndefined();
  return result.ticket;
}
function grant(req = request(), token?: string) {
  const result = service.grant(req, actor, token);
  if (result.kind !== 'granted') throw new Error('Expected grant');
  return result.grant;
}
beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
  store = new DocChannelStore(db);
  clock = new Date();
  currentOrigin = true;
  allowed = true;
  currentTarget = {
    agentId: 'opener',
    sessionId: 'session-a',
    runtime: 'claude-code',
    scope: 'session:session-a',
  };
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-grants-'));
  fs.mkdirSync(path.join(dir, '.dork'));
  store.initialize({
    documentId: 'doc-a',
    scope: 'session:session-a',
    openerAgentId: 'opener',
    createdAt: clock.toISOString(),
    updatedAt: clock.toISOString(),
  });
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  approval = new ApprovalService(db);
  authority = {
    resolveScope: (scope) => scope,
    requireCurrent(documentId) {
      if (!allowed) throw new DocRouteGrantError('ACCESS_LOST');
      return { id: documentId, scope: 'session:session-a' };
    },
    requireGrantedCurrent(row) {
      if (!allowed) throw new DocRouteGrantError('ACCESS_LOST');
      return { id: row.documentId, scope: 'session:session-a' };
    },
    resolveTarget({ route }) {
      return route.to === 'log'
        ? { agentId: null, sessionId: null, runtime: null, scope: 'session:session-a' }
        : currentTarget;
    },
    sourceRoot: () => dir,
    originCurrent: () => currentOrigin,
  };
  service = new DocChannelGrants({ db, store, approvals: approval, authority, now: () => clock });
});
afterEach(() => {
  vi.restoreAllMocks();
  db?.$client.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('independent exact document route grants', () => {
  it('logs without declarations and gives declared unapproved routes an explicit saved-only reason', () => {
    expect(service.getCurrentRoutes('doc-a', 'task.toggled', actor)).toEqual([]);
    configure(otherRoute);
    currentTarget.agentId = 'other';
    expect(service.getCurrentRoutes('doc-a', 'task.toggled', actor)).toEqual([
      { route: otherRoute, reason: 'ROUTE_UNAPPROVED' },
    ]);
    expect(service.getCurrentRoutes('doc-a', 'tasking.toggled', actor)).toEqual([]);
  });
  it('lets only the verified recorded opener enable its bounded own route or log route', () => {
    configure();
    const row = grant();
    expect(row.approvalId).toBeNull();
    expect(row.approvedBy).toBe('opener');
    expect(row.limits).toEqual({ envelopeBytes: 16384, eventsPerMinute: 60, turnsPerHour: 10 });
    expect(service.getCurrentRoutes('doc-a', 'task.toggled', actor)[0]?.grantId).toBe(row.grantId);
    expect(grant().grantId).toBe(row.grantId);
    expect(() =>
      service.configure(
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
    expect(() => service.configure('doc-a', { routes: [] }, operator, 'other')).toThrow(
      'OPENER_IMMUTABLE'
    );
    configure({ ...ownRoute, to: 'log', turn: { mode: 'none' } });
    expect(grant().targetAgentId).toBeNull();
  });
  it('requires actual matching operator approval for another target, independent of permission defaults', () => {
    configure(otherRoute);
    currentTarget.agentId = 'other';
    const ticket = approved();
    const row = grant(request(), ticket.token);
    expect(row.approvedBy).toBe(`approval:${ticket.approvalId}`);
    expect(row.approvalEvidence).toMatchObject({
      kind: 'operator_approval',
      approvalId: ticket.approvalId,
      state: 'granted',
    });
    expect((row.approvalEvidence as { inputHash: string }).inputHash).toBe(
      db.select().from(approvals).where(eq(approvals.id, ticket.approvalId)).get()?.inputHash
    );
    expect(grant(request(), ticket.token).grantId).toBe(row.grantId);
    expect(db.select().from(canvasDocGrants).all()).toHaveLength(1);
  });
  it('does not treat capability permission mode or a synthetic approving actor as route approval', async () => {
    configure(otherRoute);
    currentTarget.agentId = 'other';
    const capability = createDocChannelGrantCapabilities(service).find(
      (item) => item.id === 'ui.approve_doc_route'
    )!;
    const output = await capability.invoke({} as never, request(), {
      serverPrincipal: actor.principal,
      permissionMode: 'bypassPermissions',
      approval: { approvedBy: 'invented-person', token: 'invented-token' },
    } as never);
    expect(output).toMatchObject({ kind: 'approval_required' });
    expect(db.select().from(canvasDocGrants).all()).toHaveLength(0);
  });
  it('refuses an approval subject too large for the real approval card instead of truncating exact types', () => {
    configure(otherRoute);
    currentTarget.agentId = 'other';
    const allowedTypes = Array.from({ length: 128 }, (_, i) => `task.${'a'.repeat(64)}${i}`);
    expect(() => service.grant(request({ allowedTypes }), actor)).toThrow(
      'APPROVAL_SUBJECT_TOO_LARGE'
    );
    expect(db.select().from(approvals).all()).toHaveLength(0);
  });
  it('refuses pending, denied and mismatched actual verdicts without a grant', () => {
    configure(otherRoute);
    currentTarget.agentId = 'other';
    const pending = service.grant(request(), actor);
    if (pending.kind !== 'approval_required') throw new Error('ticket');
    expect(() => grant(request(), pending.ticket.token)).toThrow('APPROVAL_PENDING');
    approval.deny(pending.ticket.approvalId, 'No');
    expect(() => grant(request(), pending.ticket.token)).toThrow('APPROVAL_DENIED');
    const ticket = approved();
    expect(() => grant(request({ limits: { eventsPerMinute: 1 } }), ticket.token)).toThrow(
      'APPROVAL_MISMATCHED'
    );
    expect(db.select().from(canvasDocGrants).all()).toHaveLength(0);
    expect(grant(request(), ticket.token).approvalId).toBe(ticket.approvalId);
  });
  it('requires a real outer commit boundary for grant creation and manifest refresh', () => {
    configure();
    expect(() => store.transaction(() => service.grant(request(), actor))).toThrow(
      'AUTHORITY_REFRESH_REQUIRES_COMMIT_BOUNDARY'
    );
    expect(db.select().from(canvasDocGrants).all()).toHaveLength(0);
  });
  it('rolls back approval consumption on failed grant persistence and safely retries the same token', () => {
    configure(otherRoute);
    currentTarget.agentId = 'other';
    const ticket = approved();
    const insertion = vi.spyOn(store, 'insertGrant').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const broadcast = vi.mocked(eventFanOut.broadcast);
    broadcast.mockClear();
    expect(() => grant(request(), ticket.token)).toThrow('disk full');
    expect(broadcast).not.toHaveBeenCalled();
    expect(
      db.select().from(approvals).where(eq(approvals.id, ticket.approvalId)).get()?.consumedAt
    ).toBeNull();
    expect(db.select().from(canvasDocGrants).all()).toHaveLength(0);
    insertion.mockRestore();
    expect(grant(request(), ticket.token).approvalId).toBe(ticket.approvalId);
    const consumed = () =>
      broadcast.mock.calls.filter(
        ([event, data]) =>
          event === 'approval_resolved' && (data as { outcome?: string }).outcome === 'consumed'
      );
    expect(consumed()).toHaveLength(1);
    expect(db.select().from(canvasDocGrants).all()).toHaveLength(1);
    grant(request(), ticket.token);
    expect(consumed()).toHaveLength(1);
  });
  it('rechecks target and current origin after approval preparation, before insertion', () => {
    configure(otherRoute);
    currentTarget.agentId = 'other';
    const ticket = approved();
    const consume = approval.consume.bind(approval);
    vi.spyOn(approval, 'consume').mockImplementation((token, binding, options) => {
      const verdict = consume(token, binding, options);
      currentTarget.runtime = 'codex';
      return verdict;
    });
    expect(() => grant(request(), ticket.token)).toThrow('GRANT_BINDING_CHANGED');
    expect(db.select().from(canvasDocGrants).all()).toHaveLength(0);
    expect(
      db.select().from(approvals).where(eq(approvals.id, ticket.approvalId)).get()?.consumedAt
    ).toBeNull();
    currentOrigin = false;
    expect(() => grant()).toThrow('ORIGIN_AUTHORITY_LOST');
  });
  it('refuses counterfeit principals, cross-scope targets and unsupported room routes', () => {
    configure();
    expect(() =>
      service.grant(request(), { ...actor, principal: JSON.parse(JSON.stringify(actor.principal)) })
    ).toThrow('INVALID_PRINCIPAL');
    currentTarget.scope = 'room:elsewhere';
    expect(() => grant()).toThrow('TARGET_SCOPE_MISMATCH');
    currentTarget.scope = 'session:session-a';
    configure({ ...ownRoute, to: 'room:self' });
    expect(() => grant()).toThrow('ROOM_ROUTE_UNAVAILABLE');
  });
  it('suspends hash-changed grants, enforces narrowed payload/caps and never silently replays saved input', () => {
    configure();
    const row = grant();
    store.appendEvent({
      documentId: 'doc-a',
      eventId: 'saved-input',
      direction: 'upstream',
      type: 'task.toggled',
      payload: { checked: true },
      envelopeHash: 'hash',
      receivedAt: clock.toISOString(),
      provenance: {},
    });
    fs.writeFileSync(
      path.join(dir, '.dork/app.json'),
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
    expect(service.getCurrentRoutes('doc-a', 'task.toggled', actor)[0]?.reason).toBe(
      'MANIFEST_CHANGED'
    );
    expect(store.getGrant(row.grantId)?.revokedAt).not.toBeNull();
    expect(service.getEffectiveLimits('doc-a', actor)).toEqual({
      envelopeBytes: 1024,
      eventsPerMinute: 2,
      turnsPerHour: 1,
    });
    expect(() =>
      service.validateEventPayload('doc-a', 'task.toggled', { checked: 'true' }, actor)
    ).toThrow('INVALID_DECLARED_PAYLOAD');
    expect(() =>
      service.validateEventPayload('doc-a', 'task.toggled', { checked: true }, actor)
    ).not.toThrow();
    grant();
    expect(db.select().from(canvasDocEvents).all()).toHaveLength(1);
    expect(store.listDeliveries('doc-a', 'saved-input')).toEqual([]);
  });
  it('keeps observed manifest suspension after refusal rollback and restoration of old bytes', () => {
    const file = path.join(dir, '.dork/app.json');
    const old = { v: 1, types: { 'task.toggled': { type: 'boolean' } } };
    fs.writeFileSync(file, JSON.stringify(old));
    configure();
    const row = grant();
    fs.writeFileSync(file, JSON.stringify({ ...old, limits: { eventsPerMinute: 1 } }));
    service.refreshAuthority('doc-a', actor);
    expect(() =>
      store.transaction((tx) => {
        service.validateEventPayload('doc-a', 'task.toggled', 'invalid', actor, tx);
      })
    ).toThrow('INVALID_DECLARED_PAYLOAD');
    expect(store.getGrant(row.grantId)?.revokedAt).not.toBeNull();
    fs.writeFileSync(file, JSON.stringify(old));
    service.refreshAuthority('doc-a', actor);
    expect(() =>
      store.transaction((tx) => {
        service.revalidateGrant('doc-a', row.grantId, actor, tx);
      })
    ).toThrow('GRANT_REVOKED');
    expect(store.getGrant(row.grantId)?.revokedAt).not.toBeNull();
  });
  it('refuses a manifest race inside final admission without hidden transaction effects', () => {
    configure();
    const row = grant();
    service.refreshAuthority('doc-a', actor);
    fs.writeFileSync(path.join(dir, '.dork/app.json'), JSON.stringify({ v: 1, types: {} }));
    expect(() =>
      store.transaction((tx) => service.revalidateGrant('doc-a', row.grantId, actor, tx))
    ).toThrow('MANIFEST_CHANGED');
    expect(store.getGrant(row.grantId)?.revokedAt).toBeNull();
    service.refreshAuthority('doc-a', actor);
    expect(store.getGrant(row.grantId)?.revokedAt).not.toBeNull();
  });
  it('durably revokes grants when the manifest becomes invalid, even after repairing it', () => {
    configure();
    const row = grant();
    const file = path.join(dir, '.dork/app.json');
    fs.writeFileSync(file, '{');
    expect(() => service.refreshAuthority('doc-a', actor)).toThrow();
    expect(store.getGrant(row.grantId)?.revokedAt).not.toBeNull();
    fs.unlinkSync(file);
    expect(() => service.revalidateGrant('doc-a', row.grantId, actor)).toThrow('GRANT_REVOKED');
  });
  it('background dispatch derives current scope from durable grant authority and validates immutable batch bindings', () => {
    configure();
    const row = grant();
    store.insertBatch({
      batchId: 'batch-a',
      documentId: 'doc-a',
      scope: 'session:session-a',
      routeId: row.routeId,
      grantId: row.grantId,
      grantRevision: row.revision,
      generation: 'generation-a',
      inputEventIds: ['input-a'],
      effectivePayload: {},
      dueAt: clock.toISOString(),
      status: 'pending',
      createdAt: clock.toISOString(),
      updatedAt: clock.toISOString(),
    });
    const batch = store.getBatch('batch-a')!;
    const check = vi.spyOn(authority, 'requireGrantedCurrent');
    service.refreshGrantedAuthority(row.grantId);
    expect(store.transaction((tx) => service.revalidateBatchGrant(batch, tx)).target).toEqual(
      currentTarget
    );
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: row.grantId }),
      expect.anything()
    );
    expect(() =>
      store.transaction((tx) =>
        service.revalidateBatchGrant({ ...batch, generation: 'forged' }, tx)
      )
    ).toThrow('BATCH_BINDING_CHANGED');
    currentOrigin = false;
    expect(() => store.transaction((tx) => service.revalidateBatchGrant(batch, tx))).toThrow(
      'ORIGIN_AUTHORITY_LOST'
    );
    currentOrigin = true;
    currentTarget.runtime = 'codex';
    expect(() => store.transaction((tx) => service.revalidateBatchGrant(batch, tx))).toThrow(
      'TARGET_IDENTITY_CHANGED'
    );
    allowed = false;
    expect(() => service.refreshGrantedAuthority(row.grantId)).toThrow('ACCESS_LOST');
  });
  it('preserves exact approved evidence across a durable first-turn alias and rejects unrelated identities', () => {
    configure(otherRoute);
    currentTarget.agentId = 'other';
    const ticket = approved();
    const row = grant(request(), ticket.token);
    const originalEvidence = row.approvalEvidence;
    authority.resolveScope = (scope) =>
      scope === 'session:session-a' ? 'session:canonical-a' : scope;
    authority.requireCurrent = (id) => ({ id, scope: 'session:canonical-a' });
    currentTarget = { ...currentTarget, sessionId: 'canonical-a', scope: 'session:canonical-a' };
    db.update(canvasDocGrants)
      .set({ targetSessionId: 'canonical-a' })
      .where(eq(canvasDocGrants.grantId, row.grantId))
      .run();
    expect(service.revalidateGrant('doc-a', row.grantId, actor).approvalEvidence).toEqual(
      originalEvidence
    );
    currentTarget.sessionId = 'unrelated';
    expect(() => service.revalidateGrant('doc-a', row.grantId, actor)).toThrow(
      'TARGET_IDENTITY_CHANGED'
    );
    currentTarget.sessionId = 'canonical-a';
    currentTarget.agentId = 'different-agent';
    expect(() => service.revalidateGrant('doc-a', row.grantId, actor)).toThrow(
      'TARGET_IDENTITY_MISMATCH'
    );
    currentTarget.agentId = 'other';
    currentTarget.runtime = 'codex';
    expect(() => service.revalidateGrant('doc-a', row.grantId, actor)).toThrow(
      'TARGET_IDENTITY_CHANGED'
    );
  });
  it('refuses stored grant fields that no longer match exact approval evidence', () => {
    configure();
    const row = grant();
    db.update(canvasDocGrants)
      .set({ limits: { envelopeBytes: 16384, eventsPerMinute: 1, turnsPerHour: 10 } })
      .where(eq(canvasDocGrants.grantId, row.grantId))
      .run();
    expect(() => service.revalidateGrant('doc-a', row.grantId, actor)).toThrow(
      'GRANT_EVIDENCE_MISMATCH'
    );
  });
  it('consumes an actual approval once under concurrent retries and refuses its changed binding', async () => {
    configure(otherRoute);
    currentTarget.agentId = 'other';
    const ticket = approved();
    const results = await Promise.all(
      [0, 1].map(() => Promise.resolve().then(() => grant(request(), ticket.token)))
    );
    expect(results[0].grantId).toBe(results[1].grantId);
    expect(db.select().from(canvasDocGrants).all()).toHaveLength(1);
    expect(() => grant(request({ allowedTypes: ['task.toggled'] }), ticket.token)).toThrow(
      'APPROVAL_CONSUMED'
    );
  });
  it('revocation during preparation, declaration changes, expiry and lost access stop final dispatch revalidation', () => {
    configure();
    const row = grant();
    service.revoke('doc-a', row.grantId, operator);
    expect(() => service.revalidateGrant('doc-a', row.grantId, actor)).toThrow('GRANT_REVOKED');
    const next = grant();
    configure({ ...ownRoute, turn: { mode: 'immediate', maxBatch: 1 } });
    expect(() => service.revalidateGrant('doc-a', next.grantId, actor)).toThrow(
      'DECLARATION_CHANGED'
    );
    const last = grant();
    clock = new Date(clock.getTime() + 3600001);
    expect(() => service.revalidateGrant('doc-a', last.grantId, actor)).toThrow('GRANT_EXPIRED');
    allowed = false;
    expect(() => service.getCurrentRoutes('doc-a', 'task.toggled', actor)).toThrow('ACCESS_LOST');
  });
  it('requires exact independent write binding and operator approval even for own-agent routes', () => {
    configure();
    const write = {
      operation: 'checkbox-toggle' as const,
      sourceIdentity: 'source',
      resolvedCwd: dir,
      treeKind: 'agent-cwd' as const,
      canonicalPath: path.join(dir, 'tasks.md'),
    };
    expect(() => service.grant(request({ write }), actor)).toThrow('WRITE_BINDING_MISMATCH');
    authority.resolveWriteBinding = () => write;
    const ticket = approved(request({ write }));
    expect(grant(request({ write }), ticket.token).approvalId).toBe(ticket.approvalId);
    authority.resolveWriteBinding = () => ({ ...write, canonicalPath: path.join(dir, 'other.md') });
    expect(service.getCurrentRoutes('doc-a', 'task.toggled', actor)[0]?.reason).toBe(
      'WRITE_BINDING_MISMATCH'
    );
  });
  it('matches wildcard segments and refuses broader granted type patterns', () => {
    expect(containedPattern('task.*', 'task.toggled')).toBe(true);
    expect(containedPattern('task.*', 'tasking.toggled')).toBe(false);
    expect(containedPattern('task.toggled', 'task.*')).toBe(false);
    configure();
    expect(() => grant(request({ allowedTypes: ['other.*'] }))).toThrow('TYPE_OUTSIDE_ROUTE');
    const row = grant(request({ allowedTypes: ['task.toggled'] }));
    expect(service.getCurrentRoutes('doc-a', 'task.toggled', actor)[0]?.grantId).toBe(row.grantId);
    expect(service.getCurrentRoutes('doc-a', 'task.other', actor)[0]?.reason).toBe(
      'TYPE_NOT_GRANTED'
    );
  });
});
