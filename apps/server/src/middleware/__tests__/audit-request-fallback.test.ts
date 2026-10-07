/**
 * The audit fallback for mutating requests (spec `audit-trail` PR2 review): a
 * write no choke point recorded still leaves one line (who, method, route,
 * outcome; never the body, query or ids), and a write a choke point did record
 * adds nothing, including one recorded in a narrower scope inside the request.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, type Db } from '@dorkos/db';
import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';
import {
  initAuditTrail,
  recordAudit,
  resetAuditTrail,
  runAsAgent,
} from '../../services/audit/audit-trail.js';
import { auditActor } from '../audit-actor.js';
import { auditRequestFallback, routePatternOf } from '../audit-request-fallback.js';

const fixtureTarget = swappableServer();
const server = fixtureTarget.server;

describe('auditRequestFallback', () => {
  let db: Db;
  let app: express.Express;

  beforeEach(() => {
    db = createTestDb();
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    app = express();
    app.use(express.json());
    app.use(auditActor);
    app.use(auditRequestFallback);
    // A route with no choke point behind it.
    app.post('/api/rooms/:id/pins', (_req, res) => {
      res.json({ ok: true });
    });
    app.delete('/api/rooms/:id', (_req, res) => {
      res.status(403).json({ error: 'no' });
    });
    // A route whose work is recorded by a choke point.
    app.post('/api/covered', (_req, res) => {
      recordAudit({ action: 'covered.done', operation: 'modify', outcome: 'ok', summary: 'Done' });
      res.json({ ok: true });
    });
    // A route whose work is recorded in a narrower scope (an agent's call).
    app.post('/api/nested', async (_req, res) => {
      await runAsAgent(
        { agentPath: '/projects/scout', displayName: 'Scout' },
        undefined,
        async () => {
          recordAudit({
            action: 'nested.done',
            operation: 'modify',
            outcome: 'ok',
            summary: 'Done',
          });
        }
      );
      res.json({ ok: true });
    });
    app.get('/api/rooms', (_req, res) => {
      res.json([]);
    });
    app.patch('/api/rooms/:id/read', (_req, res) => {
      res.json({ ok: true });
    });
    fixtureTarget.mount(app);
  });
  afterEach(() => resetAuditTrail());

  /** Rows after `finish` has fired. */
  const rows = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return db.select().from(auditEvents).all();
  };

  it('records an unrecorded write with method and route, never body, query or id', async () => {
    const roomId = '01J9Z3K8M2Q4R6S7T8V9W0X1Y2';
    await request(server)
      .post(`/api/rooms/${roomId}/pins?secret=shh`)
      .send({ text: 'pin me', token: 'abc' });

    const [row] = await rows();
    expect(row).toMatchObject({
      action: 'http.post',
      operation: 'execute',
      targetType: 'route',
      targetId: '/api/rooms/:id/pins',
      outcome: 'ok',
      actorId: 'install:inst-1',
    });
    expect(JSON.stringify(row)).not.toMatch(/pin me|abc|shh|01J9Z3K8/);
  });

  it('records a refused write as refused', async () => {
    await request(server).delete('/api/rooms/01J9Z3K8M2Q4R6S7T8V9W0X1Y2');
    expect(await rows()).toMatchObject([{ action: 'http.delete', outcome: 'refused' }]);
  });

  it('adds nothing when a choke point recorded the request', async () => {
    await request(server).post('/api/covered');
    expect((await rows()).map((row) => row.action)).toEqual(['covered.done']);
  });

  it('adds nothing when the record was made in a narrower scope inside the request', async () => {
    await request(server).post('/api/nested');
    expect((await rows()).map((row) => row.action)).toEqual(['nested.done']);
  });

  it('records nothing for reads, and nothing for marking something read', async () => {
    await request(server).get('/api/rooms');
    await request(server).patch('/api/rooms/01J9Z3K8M2Q4R6S7T8V9W0X1Y2/read');
    expect(await rows()).toEqual([]);
  });

  it('records nothing for conversation: chat messages, room posts, reactions, threads', async () => {
    for (const path of [
      '/api/sessions/3f2b8c1e-1d2a-4c9b-9e7f-0a1b2c3d4e5f/messages',
      '/api/sessions/3f2b8c1e-1d2a-4c9b-9e7f-0a1b2c3d4e5f/queue/q1',
      '/api/rooms/general/entries',
      '/api/rooms/general/entries/e1/reactions',
      '/api/rooms/general/threads',
      '/api/rooms/general/attachments',
      '/api/communities/c1/rooms/r1/entries',
    ]) {
      app.post(path, (_req, res) => {
        res.json({ ok: true });
      });
      await request(server).post(path).send({ text: 'private thoughts' });
    }
    expect(await rows()).toEqual([]);
  });

  it('writes id-shaped segments as :id', () => {
    expect(routePatternOf('/api/sessions/3f2b8c1e-1d2a-4c9b-9e7f-0a1b2c3d4e5f/messages')).toBe(
      '/api/sessions/:id/messages'
    );
    expect(routePatternOf('/api/tasks/42/run')).toBe('/api/tasks/:id/run');
    expect(routePatternOf('/api/marketplace/packages/flow/install')).toBe(
      '/api/marketplace/packages/flow/install'
    );
  });
});
