import {
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
import { canvasDocGrants, eq } from '@dorkos/db';
import { containedPattern } from '../../grant-policy.js';

describe('independent exact document route grants', () => {
  it('keeps observed manifest suspension after refusal rollback and restoration of old bytes', () => {
    const file = path.join(st.dir, '.dork/app.json');
    const old = { v: 1, types: { 'task.toggled': { type: 'boolean' } } };
    fs.writeFileSync(file, JSON.stringify(old));
    configure();
    const row = grant();
    fs.writeFileSync(file, JSON.stringify({ ...old, limits: { eventsPerMinute: 1 } }));
    st.service.refreshAuthority('doc-a', actor);
    expect(() =>
      st.store.transaction((tx) => {
        st.service.validateEventPayload('doc-a', 'task.toggled', 'invalid', actor, tx);
      })
    ).toThrow('INVALID_DECLARED_PAYLOAD');
    expect(st.store.getGrant(row.grantId)?.revokedAt).not.toBeNull();
    fs.writeFileSync(file, JSON.stringify(old));
    st.service.refreshAuthority('doc-a', actor);
    expect(() =>
      st.store.transaction((tx) => {
        st.service.revalidateGrant('doc-a', row.grantId, actor, tx);
      })
    ).toThrow('GRANT_REVOKED');
    expect(st.store.getGrant(row.grantId)?.revokedAt).not.toBeNull();
  });

  it('refuses a manifest race inside final admission without hidden transaction effects', () => {
    configure();
    const row = grant();
    st.service.refreshAuthority('doc-a', actor);
    fs.writeFileSync(path.join(st.dir, '.dork/app.json'), JSON.stringify({ v: 1, types: {} }));
    expect(() =>
      st.store.transaction((tx) => st.service.revalidateGrant('doc-a', row.grantId, actor, tx))
    ).toThrow('MANIFEST_CHANGED');
    expect(st.store.getGrant(row.grantId)?.revokedAt).toBeNull();
    st.service.refreshAuthority('doc-a', actor);
    expect(st.store.getGrant(row.grantId)?.revokedAt).not.toBeNull();
  });

  it('durably revokes grants when the manifest becomes invalid, even after repairing it', () => {
    configure();
    const row = grant();
    const file = path.join(st.dir, '.dork/app.json');
    fs.writeFileSync(file, '{');
    expect(() => st.service.refreshAuthority('doc-a', actor)).toThrow();
    expect(st.store.getGrant(row.grantId)?.revokedAt).not.toBeNull();
    fs.unlinkSync(file);
    expect(() => st.service.revalidateGrant('doc-a', row.grantId, actor)).toThrow('GRANT_REVOKED');
  });

  it('background dispatch derives current scope from durable grant authority and validates immutable batch bindings', () => {
    configure();
    const row = grant();
    st.store.insertBatch({
      batchId: 'batch-a',
      documentId: 'doc-a',
      scope: 'session:session-a',
      routeId: row.routeId,
      grantId: row.grantId,
      grantRevision: row.revision,
      generation: 'generation-a',
      inputEventIds: ['input-a'],
      effectivePayload: {},
      dueAt: st.clock.toISOString(),
      status: 'pending',
      createdAt: st.clock.toISOString(),
      updatedAt: st.clock.toISOString(),
    });
    const batch = st.store.getBatch('batch-a')!;
    const check = vi.spyOn(st.authority, 'requireGrantedCurrent');
    st.service.refreshGrantedAuthority(row.grantId);
    expect(st.store.transaction((tx) => st.service.revalidateBatchGrant(batch, tx)).target).toEqual(
      st.currentTarget
    );
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ grantId: row.grantId }),
      expect.anything()
    );
    expect(() =>
      st.store.transaction((tx) =>
        st.service.revalidateBatchGrant({ ...batch, generation: 'forged' }, tx)
      )
    ).toThrow('BATCH_BINDING_CHANGED');
    st.currentOrigin = false;
    expect(() => st.store.transaction((tx) => st.service.revalidateBatchGrant(batch, tx))).toThrow(
      'ORIGIN_AUTHORITY_LOST'
    );
    st.currentOrigin = true;
    st.currentTarget.runtime = 'codex';
    expect(() => st.store.transaction((tx) => st.service.revalidateBatchGrant(batch, tx))).toThrow(
      'TARGET_IDENTITY_CHANGED'
    );
    st.allowed = false;
    expect(() => st.service.refreshGrantedAuthority(row.grantId)).toThrow('ACCESS_LOST');
  });

  it('preserves exact approved evidence across a durable first-turn alias and rejects unrelated identities', () => {
    configure(otherRoute);
    st.currentTarget.agentId = 'other';
    const ticket = approved();
    const row = grant(request(), ticket.token);
    const originalEvidence = row.approvalEvidence;
    st.authority.resolveScope = (scope) =>
      scope === 'session:session-a' ? 'session:canonical-a' : scope;
    st.authority.requireCurrent = (id) => ({ id, scope: 'session:canonical-a' });
    st.currentTarget = {
      ...st.currentTarget,
      sessionId: 'canonical-a',
      scope: 'session:canonical-a',
    };
    st.db
      .update(canvasDocGrants)
      .set({ targetSessionId: 'canonical-a' })
      .where(eq(canvasDocGrants.grantId, row.grantId))
      .run();
    expect(st.service.revalidateGrant('doc-a', row.grantId, actor).approvalEvidence).toEqual(
      originalEvidence
    );
    st.currentTarget.sessionId = 'unrelated';
    expect(() => st.service.revalidateGrant('doc-a', row.grantId, actor)).toThrow(
      'TARGET_IDENTITY_CHANGED'
    );
    st.currentTarget.sessionId = 'canonical-a';
    st.currentTarget.agentId = 'different-agent';
    expect(() => st.service.revalidateGrant('doc-a', row.grantId, actor)).toThrow(
      'TARGET_IDENTITY_MISMATCH'
    );
    st.currentTarget.agentId = 'other';
    st.currentTarget.runtime = 'codex';
    expect(() => st.service.revalidateGrant('doc-a', row.grantId, actor)).toThrow(
      'TARGET_IDENTITY_CHANGED'
    );
  });

  it('refuses stored grant fields that no longer match exact approval evidence', () => {
    configure();
    const row = grant();
    st.db
      .update(canvasDocGrants)
      .set({ limits: { envelopeBytes: 16384, eventsPerMinute: 1, turnsPerHour: 10 } })
      .where(eq(canvasDocGrants.grantId, row.grantId))
      .run();
    expect(() => st.service.revalidateGrant('doc-a', row.grantId, actor)).toThrow(
      'GRANT_EVIDENCE_MISMATCH'
    );
  });

  it('consumes an actual approval once under concurrent retries and refuses its changed binding', async () => {
    configure(otherRoute);
    st.currentTarget.agentId = 'other';
    const ticket = approved();
    const results = await Promise.all(
      [0, 1].map(() => Promise.resolve().then(() => grant(request(), ticket.token)))
    );
    expect(results[0].grantId).toBe(results[1].grantId);
    expect(st.db.select().from(canvasDocGrants).all()).toHaveLength(1);
    // While the route is on, a retry hears that first (DOR-2665)...
    expect(() => grant(request({ allowedTypes: ['task.toggled'] }), ticket.token)).toThrow(
      'ROUTE_ALREADY_GRANTED'
    );
    // ...and once it is off, the spent token still cannot be reused.
    st.service.revoke('doc-a', results[0].grantId, operator);
    expect(() => grant(request({ allowedTypes: ['task.toggled'] }), ticket.token)).toThrow(
      'APPROVAL_CONSUMED'
    );
  });

  it('revocation during preparation, declaration changes, expiry and lost access stop final dispatch revalidation', () => {
    configure();
    const row = grant();
    st.service.revoke('doc-a', row.grantId, operator);
    expect(() => st.service.revalidateGrant('doc-a', row.grantId, actor)).toThrow('GRANT_REVOKED');
    const next = grant();
    configure({ ...ownRoute, turn: { mode: 'immediate', maxBatch: 1 } });
    expect(() => st.service.revalidateGrant('doc-a', next.grantId, actor)).toThrow(
      'DECLARATION_CHANGED'
    );
    const last = grant();
    st.clock = new Date(st.clock.getTime() + 3600001);
    expect(() => st.service.revalidateGrant('doc-a', last.grantId, actor)).toThrow('GRANT_EXPIRED');
    st.allowed = false;
    expect(() => st.service.getCurrentRoutes('doc-a', 'task.toggled', actor)).toThrow(
      'ACCESS_LOST'
    );
  });

  it('requires exact independent write binding and operator approval even for own-agent routes', () => {
    configure();
    const write = {
      operation: 'checkbox-toggle' as const,
      sourceIdentity: 'source',
      resolvedCwd: st.dir,
      treeKind: 'agent-cwd' as const,
      canonicalPath: path.join(st.dir, 'tasks.md'),
    };
    expect(() => st.service.grant(request({ write }), actor)).toThrow('WRITE_BINDING_MISMATCH');
    st.authority.resolveWriteBinding = () => write;
    const ticket = approved(request({ write }));
    expect(grant(request({ write }), ticket.token).approvalId).toBe(ticket.approvalId);
    st.authority.resolveWriteBinding = () => ({
      ...write,
      canonicalPath: path.join(st.dir, 'other.md'),
    });
    expect(st.service.getCurrentRoutes('doc-a', 'task.toggled', actor)[0]?.reason).toBe(
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
    expect(st.service.getCurrentRoutes('doc-a', 'task.toggled', actor)[0]?.grantId).toBe(
      row.grantId
    );
    expect(st.service.getCurrentRoutes('doc-a', 'task.other', actor)[0]?.reason).toBe(
      'TYPE_NOT_GRANTED'
    );
  });
});
