import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { RequestUser } from '../../services/core/auth/index.js';
import { eventFanOut } from '../../services/core/event-fan-out.js';
import { NotificationStore } from '../../services/notifications/notification-store.js';
import { NotificationService } from '../../services/notifications/notification-service.js';
import { createNotificationsRouter } from '../notifications.js';

let db: Db;
let service: NotificationService;

/**
 * Mount the router behind stand-ins for the two middlewares that sit in front of
 * it. `sessionGate` and the agent-identity resolver both write onto
 * `res.locals`, and a case has to present exactly one credential.
 */
function buildApp(
  options: { user?: RequestUser; agentIdentity?: { agentId: string } } = {}
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (options.user) res.locals.user = options.user;
    if (options.agentIdentity) res.locals.agentIdentity = options.agentIdentity;
    next();
  });
  app.use('/api/notifications', createNotificationsRouter(service));
  return app;
}

/** Raise `count` distinct turn notifications, oldest first. */
async function seed(count: number, sessionId = 'sess-1'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const result = await service.notify('turn.completed', {
      sessionId,
      sessionLabel: 'acme',
      agentId: `agent-${sessionId}`,
      completedAt: `2026-08-20T00:00:${String(i).padStart(2, '0')}.000Z`,
    });
    if (result.notification) ids.push(result.notification.id);
  }
  return ids;
}

beforeEach(() => {
  db = createDb(':memory:');
  runMigrations(db);
  service = new NotificationService(new NotificationStore(db));
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/notifications', () => {
  it('lists the newest first, with the unread count', async () => {
    const ids = await seed(3);
    const res = await request(buildApp()).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body.notifications.map((n: { id: string }) => n.id)).toEqual([...ids].reverse());
    expect(res.body.unreadCount).toBe(3);
    expect(res.body.nextCursor).toBeNull();
  });

  it('pages with a cursor, without repeating or skipping a row', async () => {
    const ids = await seed(5);
    const app = buildApp();

    const first = await request(app).get('/api/notifications').query({ limit: 2 });
    expect(first.body.notifications).toHaveLength(2);
    expect(first.body.nextCursor).toBe(first.body.notifications[1].id);

    const second = await request(app)
      .get('/api/notifications')
      .query({ limit: 2, before: first.body.nextCursor });
    const third = await request(app)
      .get('/api/notifications')
      .query({ limit: 2, before: second.body.nextCursor });

    const seen = [
      ...first.body.notifications,
      ...second.body.notifications,
      ...third.body.notifications,
    ].map((n: { id: string }) => n.id);
    expect(seen).toEqual([...ids].reverse());
    expect(new Set(seen).size).toBe(5);
    expect(third.body.nextCursor).toBeNull();
  });

  it('filters to one session', async () => {
    await seed(2, 'sess-1');
    await seed(1, 'sess-2');

    const res = await request(buildApp()).get('/api/notifications').query({ sessionId: 'sess-2' });
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].sessionId).toBe('sess-2');
    // The count is deliberately unfiltered: a bell that counted only the open
    // lens would go quiet the moment somebody opened one session.
    expect(res.body.unreadCount).toBe(3);
  });

  it('filters to one agent', async () => {
    await seed(2, 'sess-1');
    await seed(1, 'sess-2');

    const res = await request(buildApp())
      .get('/api/notifications')
      .query({ agentId: 'agent-sess-2' });
    expect(res.body.notifications).toHaveLength(1);
  });

  it('filters to one kind', async () => {
    await seed(2);
    await service.resolveStanding(
      'ask.pending',
      { sessionId: 'sess-1', interactionId: 'int-1', sessionLabel: 'acme', summary: 'a' },
      { outcome: 'expired' }
    );

    const res = await request(buildApp()).get('/api/notifications').query({ kind: 'ask.pending' });
    expect(res.body.notifications).toHaveLength(1);
    expect(res.body.notifications[0].outcome).toBe('expired');
  });

  it('filters to several kinds at once, comma-separated', async () => {
    // The shape home's activity group asks for: the three kinds that mean
    // something broke, in one request. Without it that surface has to read the
    // unfiltered list and narrow in the client, where a page of finished turns
    // washes the failures out of the first 25 rows.
    await seed(2);
    await service.notify('dead-letter.created', { deadLetterId: 'dl-1', reason: 'no route' });
    await service.notify('agent.unreachable', { agentId: 'a-9', agentName: 'tangerines' });

    const res = await request(buildApp())
      .get('/api/notifications')
      .query({ kind: 'dead-letter.created,agent.unreachable' });

    expect(res.status).toBe(200);
    expect(res.body.notifications.map((n: { kind: string }) => n.kind).sort()).toEqual([
      'agent.unreachable',
      'dead-letter.created',
    ]);
    // The unread count stays fleet-wide, whatever the filter: it is what the
    // bell draws, and a count scoped to the lens would go quiet the moment
    // somebody opened one page.
    expect(res.body.unreadCount).toBe(4);
  });

  it('ignores whitespace around a comma-separated kind list', async () => {
    await seed(1);
    await service.notify('agent.unreachable', { agentId: 'a-9', agentName: 'tangerines' });

    const res = await request(buildApp())
      .get('/api/notifications')
      .query({ kind: ' agent.unreachable , turn.completed ' });

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(2);
  });

  it('refuses a kind it has never heard of rather than answering an unfiltered list', async () => {
    // Silently dropping the typo would answer a filter nobody asked for, which
    // reads as "there is nothing of that kind" instead of "that is not a kind".
    await seed(2);

    const res = await request(buildApp())
      .get('/api/notifications')
      .query({ kind: 'agent.unreachable,not-a-kind' });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('not-a-kind');
  });

  it('filters to the unread ones, and reads `unread=false` as "everything"', async () => {
    const ids = await seed(2);
    service.markRead(ids[0]);
    const app = buildApp();

    const unread = await request(app).get('/api/notifications').query({ unread: 'true' });
    expect(unread.body.notifications).toHaveLength(1);

    // `z.coerce.boolean` would map the string 'false' to true and hide a row.
    const all = await request(app).get('/api/notifications').query({ unread: 'false' });
    expect(all.body.notifications).toHaveLength(2);
  });

  it('refuses a limit outside its bounds rather than silently clamping', async () => {
    const res = await request(buildApp()).get('/api/notifications').query({ limit: 500 });
    expect(res.status).toBe(400);
  });

  it('shows an agent nothing, and says so as an empty list rather than a refusal', async () => {
    await seed(3);
    const res = await request(buildApp({ agentIdentity: { agentId: 'agent-x' } })).get(
      '/api/notifications'
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notifications: [], nextCursor: null, unreadCount: 0 });
  });

  it('shows an agent nothing even when it presents a token that resolved to nothing', async () => {
    await seed(1);
    const res = await request(buildApp())
      .get('/api/notifications')
      .set('x-dorkos-agent', 'agent-token-abc');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toEqual([]);
  });

  it('lets a program holding the operator API key read the history', async () => {
    await seed(1);
    const res = await request(
      buildApp({ user: { userId: 'user_program', credential: 'api-key' } as RequestUser })
    ).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(1);
  });

  it('stays hidden from an agent caller for the four DOR-1408 kinds, even one presenting as the very agentId the row is about', async () => {
    // Before DOR-1408, `turn.completed`, `session.error`, `ask.pending` and
    // `dead-letter.created` never carried an `agentId` at all, so this could
    // never have been tested against them. `notificationEntitlement` gates on
    // the CALLER's principal kind (`readCallerPrincipal`), never on whether a
    // row's payload happens to name them — `BroadcastAudience` is typed
    // `(principal) => boolean` with no notification in scope, so there is no
    // seam for a payload field to narrow or widen who receives it. Presenting
    // as `agent-x`, the exact agent every seeded row below is about, is the
    // adversarial case: if delivery were ever keyed off payload `agentId`
    // this would be the one caller a bug could let through.
    await service.notify('turn.completed', {
      sessionId: 'sess-x',
      sessionLabel: 'acme',
      completedAt: '2026-08-20T00:00:00.000Z',
      agentId: 'agent-x',
    });
    await service.resolveStanding(
      'session.error',
      {
        sessionId: 'sess-x',
        sessionLabel: 'acme',
        since: '2026-08-20T00:00:00.000Z',
        agentId: 'agent-x',
      },
      { outcome: 'cleared' }
    );
    await service.resolveStanding(
      'ask.pending',
      {
        sessionId: 'sess-x',
        interactionId: 'int-x',
        sessionLabel: 'acme',
        summary: 'Run a shell command',
        agentId: 'agent-x',
      },
      { outcome: 'expired' }
    );
    await service.notify('dead-letter.created', {
      deadLetterId: 'dl-x',
      reason: 'budget exceeded',
      agentId: 'agent-x',
    });

    const operatorRes = await request(buildApp()).get('/api/notifications');
    expect(operatorRes.body.notifications).toHaveLength(4);

    const agentRes = await request(buildApp({ agentIdentity: { agentId: 'agent-x' } })).get(
      '/api/notifications'
    );
    expect(agentRes.status).toBe(200);
    expect(agentRes.body.notifications).toEqual([]);
  });
});

describe('marking notifications read', () => {
  it('marks one read and reports the new count', async () => {
    const ids = await seed(2);
    const res = await request(buildApp()).patch(`/api/notifications/${ids[0]}/read`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, marked: 1, unreadCount: 1 });
  });

  it('marks everything read', async () => {
    await seed(3);
    const res = await request(buildApp()).post('/api/notifications/read-all');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, marked: 3, unreadCount: 0 });
  });

  it('answers 200 with nothing marked for an id that does not exist', async () => {
    const res = await request(buildApp()).patch('/api/notifications/nope/read');
    expect(res.status).toBe(200);
    expect(res.body.marked).toBe(0);
  });

  it('refuses an agent outright, and changes nothing', async () => {
    const ids = await seed(1);
    const app = buildApp({ agentIdentity: { agentId: 'agent-x' } });

    const one = await request(app).patch(`/api/notifications/${ids[0]}/read`);
    const all = await request(app).post('/api/notifications/read-all');

    expect(one.status).toBe(403);
    expect(one.body.code).toBe('NOTIFICATIONS_OPERATOR_ONLY');
    expect(all.status).toBe(403);
    expect(service.list({ limit: 25, unread: false }).unreadCount).toBe(1);
  });

  it('refuses a program holding an API key: seeing is not the same as having seen', async () => {
    const ids = await seed(1);
    const app = buildApp({
      user: { userId: 'user_program', credential: 'api-key' } as RequestUser,
    });

    const res = await request(app).patch(`/api/notifications/${ids[0]}/read`);
    expect(res.status).toBe(403);
    expect(service.list({ limit: 25, unread: false }).unreadCount).toBe(1);
  });
});
