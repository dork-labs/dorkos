/**
 * `/api/audit` (spec `audit-trail`): the chain check and the reads over HTTP,
 * under the same visibility rule as the capabilities.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, eq, type Db } from '@dorkos/db';
import { createAuditRouter } from '../audit.js';
import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';

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
    const app = express();
    app.use(
      '/api/audit',
      createAuditRouter({
        log,
        accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
      })
    );
    fixtureTarget.mount(app);
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
      expect(first.body.nextBeforeSeq).toBe(3);
      const next = await request(fixtureServer).get('/api/audit?limit=2&beforeSeq=3');
      expect(next.body.events.map((e: { seq: number }) => e.seq)).toEqual([2, 1]);
      expect(next.body.nextBeforeSeq).toBeUndefined();
    });

    it('never shows an agent an admins row, in a list or by id', async () => {
      const list = await request(fixtureServer).get('/api/audit').set(AGENT);
      expect(list.body.events.map((e: { action: string }) => e.action)).not.toContain(
        'auth.signed_in'
      );
      expect(list.body.events).toHaveLength(3);
      const admins = log.query({ action: 'auth.', limit: 1 }, { kind: 'owner' }).events[0]!;
      expect((await request(fixtureServer).get(`/api/audit/${admins.id}`).set(AGENT)).status).toBe(
        404
      );
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
      expect(filtered.body).toEqual({ events: [] });

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
