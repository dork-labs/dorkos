/**
 * The audit fallback for mutating requests (spec `audit-trail` PR2 review): a
 * write no choke point recorded still leaves one line (who, method, route,
 * outcome; never the body, query or ids), and a write a choke point did record
 * adds nothing, including one recorded in a narrower scope inside the request.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, type Db } from '@dorkos/db';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));

import { AuditLog } from '../../services/audit/audit-log.js';
import { AccountIds } from '../../services/audit/account-ids.js';
import {
  initAuditTrail,
  recordAudit,
  resetAuditTrail,
  runAsAgent,
} from '../../services/audit/audit-trail.js';
import { routePatternOf } from '../audit-request-fallback.js';
import { createApiApp } from '../../http/api-chain.js';
import { frontDoorListener } from '../../http/front-door.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';

const fixtureTarget = swappableServer();
const server = fixtureTarget.server;

/** Conversation: things said, which the fallback never records. */
const CONVERSATION_PATHS = [
  '/api/sessions/3f2b8c1e-1d2a-4c9b-9e7f-0a1b2c3d4e5f/messages',
  '/api/sessions/3f2b8c1e-1d2a-4c9b-9e7f-0a1b2c3d4e5f/queue/q1',
  '/api/rooms/general/entries',
  '/api/rooms/general/entries/e1/reactions',
  '/api/rooms/general/threads',
  '/api/rooms/general/attachments',
  '/api/communities/c1/rooms/r1/entries',
];

describe('the audit fallback, in the chain', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
    });
    // The real chain: its audit-actor step, then the fallback.
    const app = createApiApp({ admission: new MainRequestAdmission() });
    // A route with no choke point behind it.
    app.post('/api/rooms/:id/pins', (c) => c.json({ ok: true }));
    app.delete('/api/rooms/:id', (c) => c.json({ error: 'no' }, 403));
    // A route whose work is recorded by a choke point.
    app.post('/api/covered', (c) => {
      recordAudit({ action: 'covered.done', operation: 'modify', outcome: 'ok', summary: 'Done' });
      return c.json({ ok: true });
    });
    // A route whose work is recorded in a narrower scope (an agent's call).
    app.post('/api/nested', async (c) => {
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
      return c.json({ ok: true });
    });
    app.get('/api/rooms', (c) => c.json([]));
    app.patch('/api/rooms/:id/read', (c) => c.json({ ok: true }));
    for (const path of CONVERSATION_PATHS) app.post(path, (c) => c.json({ ok: true }));
    fixtureTarget.mount(frontDoorListener(app));
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
      .send({ text: 'pin me', token: 'zz-secret-qq' });

    const [row] = await rows();
    expect(row).toMatchObject({
      action: 'http.post',
      operation: 'execute',
      targetType: 'route',
      targetId: '/api/rooms/:id/pins',
      outcome: 'ok',
      actorId: 'install:inst-1',
    });
    expect(JSON.stringify(row)).not.toMatch(/pin me|zz-secret-qq|shh|01J9Z3K8/);
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
    for (const path of CONVERSATION_PATHS) {
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
