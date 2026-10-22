/**
 * `POST /api/test/held-action/start` — the demo workspace's waiting held
 * action (`test-control-held-action.ts`).
 *
 * What is worth pinning: the seam is added only on a test-mode server, and
 * the hold it starts has nothing behind it to run. It is never released,
 * whether it is cancelled or its window runs out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import {
  DestructiveHoldService,
  type DestructiveHoldDeps,
} from '../../services/connectors/execution/destructive-hold.js';
import {
  createTestHeldActionRoutes,
  registerTestHeldActionGroup,
} from '../test-control-held-action.js';

const addTestControlGroup = vi.hoisted(() => vi.fn());
vi.mock('../test-control.js', () => ({ addTestControlGroup }));

// The `/api` chain reads login and the host settings from here; none are set.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(), getDot: vi.fn() },
}));

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

const SCOUT = '/fleet/scout';
const BODY = {
  agentPath: SCOUT,
  sessionId: 'session-scout',
  actionName: 'Delete draft “Q4 pricing notes”',
  serviceName: 'Gmail',
};

let events: Array<Record<string, unknown>>;
let raise: ReturnType<typeof vi.fn>;
let holds: DestructiveHoldService;

beforeEach(() => {
  events = [];
  raise = vi.fn(async () => ({ notification: { id: 'n-1' } }));
  holds = new DestructiveHoldService({
    activity: {
      tryEmit: async (event: Record<string, unknown>) => {
        events.push(event);
        return true;
      },
      listByEventTypes: async () => [],
    } as unknown as DestructiveHoldDeps['activity'],
    notify: raise as unknown as DestructiveHoldDeps['notify'],
    push: vi.fn(),
  });
  fixtureTarget.mount(
    honoGroupListener({
      path: '/api/test/held-action',
      routes: createTestHeldActionRoutes({
        holds,
        agentAt: (agentPath) =>
          agentPath === SCOUT
            ? { id: 'agent-scout', name: 'scout', displayName: 'Scout' }
            : undefined,
      }),
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
  addTestControlGroup.mockClear();
});

/** The event types the hold has written, in order. */
function steps(): unknown[] {
  return events.map((event) => event.eventType);
}

describe('registerTestHeldActionGroup', () => {
  it('adds nothing outside test mode', () => {
    expect(registerTestHeldActionGroup(false, { holds, agentAt: () => undefined })).toBe(false);
    expect(addTestControlGroup).not.toHaveBeenCalled();
  });

  it('hangs the route under /api/test/held-action in test mode', () => {
    expect(registerTestHeldActionGroup(true, { holds, agentAt: () => undefined })).toBe(true);
    expect(addTestControlGroup).toHaveBeenCalledWith('/held-action', expect.anything());
  });
});

describe('POST /api/test/held-action/start', () => {
  it('starts a real waiting hold, named by the registry', async () => {
    const res = await request(fixtureServer).post('/api/test/held-action/start').send(BODY);
    expect(res.status).toBe(201);
    expect(steps()).toEqual(['connector.destructive_held']);
    expect(raise).toHaveBeenCalledWith(
      'connector.destructive_pending',
      expect.objectContaining({
        holdId: res.body.holdId,
        agentId: 'agent-scout',
        agentName: 'Scout',
        actionName: BODY.actionName,
        serviceName: 'Gmail',
      })
    );
  });

  it('ends a cancelled hold without releasing it', async () => {
    const res = await request(fixtureServer).post('/api/test/held-action/start').send(BODY);
    expect(holds.cancel(res.body.holdId, { kind: 'person' })).toEqual({ ok: true });
    expect(steps()).toEqual(['connector.destructive_held', 'connector.destructive_cancelled']);
  });

  it('refuses, never releases, a hold whose window runs out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const res = await request(fixtureServer)
      .post('/api/test/held-action/start')
      .send({ ...BODY, holdMs: 1_000 });
    expect(res.status).toBe(201);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(steps()).toEqual(['connector.destructive_held', 'connector.destructive_cancelled'])
    );
    expect(events[1]?.metadata).toMatchObject({ reason: 'changed' });
    expect(await holds.release(res.body.holdId)).toEqual({ ok: false });
    expect(steps()).not.toContain('connector.destructive_released');
  });

  it('refuses an agent that is not registered here', async () => {
    const res = await request(fixtureServer)
      .post('/api/test/held-action/start')
      .send({ ...BODY, agentPath: '/fleet/nobody' });
    expect(res.status).toBe(404);
    expect(events).toEqual([]);
  });

  it('refuses a window longer than six hours', async () => {
    const res = await request(fixtureServer)
      .post('/api/test/held-action/start')
      .send({ ...BODY, holdMs: 6 * 60 * 60 * 1000 + 1 });
    expect(res.status).toBe(400);
    expect(events).toEqual([]);
  });
});
