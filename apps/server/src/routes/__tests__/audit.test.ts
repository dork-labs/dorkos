/**
 * `GET /api/audit/verify` (spec `audit-trail`): the chain check over HTTP.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, eq, type Db } from '@dorkos/db';
import { createAuditRouter } from '../audit.js';
import { AuditLog } from '../../services/audit/audit-log.js';

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
    app.use('/api/audit', createAuditRouter(log));
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
});
