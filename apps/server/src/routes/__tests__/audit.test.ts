/**
 * `/api/audit` (spec `audit-trail`): the chain check and the reads over HTTP,
 * served by the capability mount from the `audit.*` capabilities, so the
 * visibility rule is the capabilities' own.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, eq, type Db } from '@dorkos/db';
import { noopLogger } from '@dorkos/shared/logger';
import { createCapabilityHttpRoutes } from '../capability-http.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { composeRegistry } from '../../services/core/capabilities/index.js';
import { auditDomain } from '../../services/audit/audit-capabilities.js';
import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';

// The routes are served through the `/api` chain, whose host guard and session
// gate read the login setting: off, as on a fresh install.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => undefined), set: vi.fn() },
}));

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

describe('Audit routes', () => {
  let db: Db;
  let log: AuditLog;

  beforeEach(() => {
    db = createTestDb();
    log = new AuditLog(db);
    for (let i = 0; i < 3; i += 1) {
      log.record({
        actor: { accountId: 'system', kind: 'system', name: 'DorkOS' },
        source: { surface: 'system' },
        action: 'system.started',
        operation: 'execute',
        outcome: 'ok',
        summary: 'DorkOS started',
      });
    }
    const registry = composeRegistry([auditDomain], {
      logger: noopLogger,
      auditDeps: {
        log,
        accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
      },
    });
    fixtureTarget.mount(
      honoGroupListener({
        path: '/',
        routes: createCapabilityHttpRoutes({
          registry: () => registry,
          capabilities: auditDomain.capabilities,
        }),
      })
    );
  });

  it('reports an intact chain', async () => {
    const res = await request(fixtureServer).get('/api/audit/verify');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, checked: 3, lastSeq: 3 });
  });

  it('reports where an edited chain breaks', async () => {
    db.$client.exec('DROP TRIGGER audit_events_append_only_update');
    db.update(auditEvents).set({ summary: 'edited' }).where(eq(auditEvents.seq, 3)).run();
    const res = await request(fixtureServer).get('/api/audit/verify');
    expect(res.body).toMatchObject({ ok: false, firstBreak: { seq: 3 } });
  });

  it('checks a stretch named in the query string, and refuses a bad one', async () => {
    const stretch = await request(fixtureServer).get('/api/audit/verify?fromSeq=2&limit=1');
    expect(stretch.body).toMatchObject({ ok: true, checked: 1, lastSeq: 2 });
    const bad = await request(fixtureServer).get('/api/audit/verify?fromSeq=0');
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_request');
  });

  describe('reads', () => {
    const AGENT = { 'X-DorkOS-Agent': 'agent-token' };

    beforeEach(() => {
      log.record({
        actor: { accountId: 'install:inst-1', kind: 'person', name: 'Owner' },
        source: { surface: 'http', ip: '10.0.0.1' },
        action: 'auth.signed_in',
        operation: 'auth',
        outcome: 'ok',
        summary: 'Signed in',
        visibility: 'admins',
      });
    });

    it('pages newest first for the owner, admins rows included', async () => {
      const first = await request(fixtureServer).get('/api/audit?limit=2');
      expect(first.status).toBe(200);
      expect(first.body.events.map((e: { seq: number }) => e.seq)).toEqual([4, 3]);
      const next = await request(fixtureServer)
        .get('/api/audit')
        .query({ limit: 2, cursor: first.body.nextCursor });
      expect(next.body.events.map((e: { seq: number }) => e.seq)).toEqual([2, 1]);
      expect(next.body.nextCursor).toBeNull();
    });

    it('refuses a cursor it did not give, or gave another reader, rather than starting again', async () => {
      const ownerCursor = (await request(fixtureServer).get('/api/audit?limit=1')).body.nextCursor;
      const asAgent = await request(fixtureServer)
        .get('/api/audit')
        .query({ cursor: ownerCursor })
        .set(AGENT);
      expect(asAgent.status).toBe(400);
      expect(asAgent.body).toMatchObject({ code: 'invalid_request' });
      const made = await request(fixtureServer).get('/api/audit/accounts/system/timeline?cursor=3');
      expect(made.status).toBe(400);
    });

    it('never shows an agent an admins row, in a list or by id', async () => {
      const list = await request(fixtureServer).get('/api/audit').set(AGENT);
      expect(list.body.events.map((e: { action: string }) => e.action)).not.toContain(
        'auth.signed_in'
      );
      expect(list.body.events).toHaveLength(3);
      const admins = log.query({ action: 'auth.', limit: 1 }, { kind: 'owner' }).events[0]!;
      const hidden = await request(fixtureServer).get(`/api/audit/${admins.id}`).set(AGENT);
      expect(hidden.status).toBe(404);
      expect(hidden.body).toMatchObject({
        code: 'not_found',
        detail: 'No audit event with that id.',
      });
      const asOwner = await request(fixtureServer).get(`/api/audit/${admins.id}`);
      expect(asOwner.status).toBe(200);
      expect(asOwner.body.event).toMatchObject({ action: 'auth.signed_in' });
    });

    it('never shows an agent where a person’s own chat is, nor answers a filter on it', async () => {
      // No session lookup is set here, so every session reads as private.
      log.record({
        actor: { accountId: 'agent-1', kind: 'agent', name: 'Researcher' },
        source: { surface: 'runtime-tool', sessionId: 'chat-x', turnId: 't1', toolCallId: 'c1' },
        action: 'runtime.tool_used',
        operation: 'execute',
        outcome: 'ok',
        summary: 'Ran a tool',
      });
      const list = await request(fixtureServer).get('/api/audit?action=runtime.').set(AGENT);
      expect(list.body.events[0].source).toEqual({ surface: 'runtime-tool' });
      const one = await request(fixtureServer)
        .get(`/api/audit/${list.body.events[0].id}`)
        .set(AGENT);
      expect(one.body).not.toHaveProperty('session');
      const filtered = await request(fixtureServer).get('/api/audit?sessionId=chat-x').set(AGENT);
      expect(filtered.body).toEqual({ events: [], nextCursor: null });

      const asOwner = await request(fixtureServer).get('/api/audit?sessionId=chat-x');
      expect(asOwner.body.events[0].source).toMatchObject({ sessionId: 'chat-x' });
    });

    it('reads one account’s timeline and refuses a bad filter', async () => {
      const timeline = await request(fixtureServer).get('/api/audit/accounts/system/timeline');
      expect(timeline.status).toBe(200);
      expect(timeline.body.events).toHaveLength(3);
      expect((await request(fixtureServer).get('/api/audit?operation=nope')).status).toBe(400);
    });
  });
});
