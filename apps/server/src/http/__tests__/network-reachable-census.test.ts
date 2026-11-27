/**
 * The hand routes reachable from a sign-in on your network on purpose
 * (allowlist category `network-reachable`, Security's ruling on DOR-4978, held
 * until the API-key audience lands, DOR-5267).
 *
 * The set is pinned: adding one is Security's call. And one of them,
 * `PATCH /api/agents/:agentId/permissions`, is network-reachable only to LOWER an
 * agent's power: from Wi-Fi any raise is refused with `not_from_wifi`
 * (`wifi-raise-guard.ts`, DOR-3037). These rows fail if that guard is ever
 * dropped from the route, in its code or in what it answers.
 *
 * @vitest-environment node
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

import { HAND_ROUTE_ALLOWLIST } from '../hand-routes/allowlist.js';
import { createPermissionsRoutes } from '../../routes/permissions.js';
import { honoGroupListener } from './hono-group-listener.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { WIFI_RAISE_REFUSAL } from '../../services/core/auth/sessions/wifi-raise-guard.js';
import {
  TWO_AGENTS,
  createPermissionWorld,
} from '../../services/core/permissions/__tests__/permission-fixtures.js';

import { initConfigManager } from '../../services/core/config-manager.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { session, user } from '@dorkos/db';
import { initAuth } from '../../services/core/auth/index.js';
import {
  createCanvasDocWorkReviewRoutes,
  HELD_DEVICE_REPLAY,
} from '../../routes/canvas-doc-work-review.js';
import type { DocChannelHttp } from '../../routes/canvas-doc-events.js';

// The real config in a throwaway folder: login off, nothing else set.
let configHome: string;
beforeAll(() => {
  configHome = mkdtempSync(path.join(tmpdir(), 'dorkos-network-reachable-'));
  initConfigManager(configHome);
});
afterAll(() => rmSync(configHome, { recursive: true, force: true }));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PERMISSIONS_ROUTES = path.join(HERE, '..', '..', 'routes', 'permissions.ts');

const target = swappableServer();

/** The real permission routes on Full power, reached from Wi-Fi on `x-test-via`. */
function wifiApp() {
  const world = createPermissionWorld({ preset: 'full', agents: TWO_AGENTS });
  const built = honoGroupListener(
    {
      path: '/api',
      routes: createPermissionsRoutes({
        permissions: world.service,
        activity: world.activity,
        isLoginEnabled: () => false,
      }),
    },
    {
      before: async (c, next) => {
        markIngress(c.env.incoming, 'wifi');
        c.set('user', { userId: 'owner', credential: 'cookie' });
        await next();
      },
    }
  );
  return target.mount(built);
}

describe('network-reachable hand routes', () => {
  it('are exactly the fifteen Security ruled on (DOR-5267)', () => {
    const reachable = HAND_ROUTE_ALLOWLIST.filter(
      (entry) => entry.category === 'network-reachable'
    ).map((entry) => `${entry.method} ${entry.path}`);
    expect(reachable.sort()).toEqual(
      [
        // The four agent routes (this census's own ruling).
        'PATCH /api/agents/:agentId/permissions',
        'PATCH /api/agents/current',
        'POST /api/agents/resolve',
        'POST /api/mesh/agents/:id/heartbeat',
        // The seven scheduled-task writes (the same ruling, #4450).
        'DELETE /api/tasks/:id',
        'PATCH /api/tasks/:id',
        'POST /api/tasks',
        'POST /api/tasks/:id/approve-file',
        'POST /api/tasks/:id/trigger',
        'POST /api/tasks/:id/undo-agent-mode',
        'POST /api/tasks/runs/:id/cancel',
        // A person's review of a document's routes and unfinished work (Security, t1j).
        'POST /api/canvas/docs/:id/routes/:routeId/review',
        'POST /api/canvas/docs/:id/routes/:routeId/revoke',
        'POST /api/canvas/docs/:id/work/:batchId/replay',
        'POST /api/canvas/docs/:id/work/:batchId/clear',
      ].sort()
    );
  });

  it('keep the Wi-Fi raise guard in the agent permissions write', () => {
    const source = readFileSync(PERMISSIONS_ROUTES, 'utf8');
    const start = source.indexOf("router.patch('/agents/:agentId/permissions'");
    expect(start, 'the route is still a hand route in routes/permissions.ts').toBeGreaterThan(-1);
    const handler = source.slice(start, source.indexOf('router.', start + 10));
    expect(handler).toContain('agentPatchRaises(');
    expect(handler).toContain('fromWifi(c) && raises');
    expect(handler).toContain("problem(c, 'not_from_wifi', { detail: wifiRaiseRefusal().error })");
  });

  it('refuse a raise from Wi-Fi with not_from_wifi, and take a lowering', async () => {
    const app = wifiApp();
    const path = '/api/agents/agent-test/permissions';
    const raise = await request(app)
      .patch(path)
      .send({ filesAndCommands: 'autonomy', surface: 'agent-page' });
    expect(raise.status).toBe(403);
    expect(raise.body).toMatchObject({ code: 'not_from_wifi', detail: WIFI_RAISE_REFUSAL });

    const lower = await request(app)
      .patch(path)
      .send({ areas: { rooms: 'blocked' }, surface: 'agent-page' });
    expect(lower.status).toBe(200);
  });
});

describe('a held device on a network-reachable document review route', () => {
  /** The owner's two Wi-Fi sign-ins: the phone was let run agents, the laptop was not. */
  function seedOwner(): void {
    const db = createTestDb();
    initAuth(db, configHome);
    const now = new Date();
    db.insert(user)
      .values({ id: 'user_owner', name: 'Owner', email: 'owner@census.test', updatedAt: now })
      .run();
    for (const id of ['phone', 'laptop']) {
      db.insert(session)
        .values({
          id,
          token: `token-${id}`,
          userId: 'user_owner',
          route: 'wifi',
          expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          updatedAt: now,
          lastActiveAt: now,
          wifiAgentTurnsAt: id === 'phone' ? now : null,
        })
        .run();
    }
  }

  /** The work review routes, reached from Wi-Fi on the owner's sign-in from `device`. */
  function fromDevice(device: string, workReview: object) {
    const source = () => ({ workReview, actor: () => ({}) }) as unknown as DocChannelHttp;
    return target.mount(
      honoGroupListener(
        { path: '/api/canvas/docs', routes: createCanvasDocWorkReviewRoutes(source) },
        {
          before: async (c, next) => {
            markIngress(c.env.incoming, 'wifi');
            c.set('user', {
              userId: 'user_owner',
              credential: 'cookie',
              sessionId: device,
              route: 'wifi',
            });
            await next();
          },
        }
      )
    );
  }

  it('refuses a replay from a held device with person_only, before the work runs', async () => {
    seedOwner();
    const workReview = { replay: vi.fn(), clear: vi.fn() };
    const res = await request(fromDevice('laptop', workReview)).post(
      '/api/canvas/docs/doc-1/work/batch-1/replay'
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'person_only', detail: HELD_DEVICE_REPLAY });
    expect(workReview.replay).not.toHaveBeenCalled();
  });

  it('keeps clearing reachable from a held device, and a replay from a device let run agents', async () => {
    seedOwner();
    const workReview = { replay: vi.fn(), clear: vi.fn() };
    const clear = await request(fromDevice('laptop', workReview)).post(
      '/api/canvas/docs/doc-1/work/batch-1/clear'
    );
    expect(clear.body.detail).not.toBe(HELD_DEVICE_REPLAY);
    const replay = await request(fromDevice('phone', workReview)).post(
      '/api/canvas/docs/doc-1/work/batch-1/replay'
    );
    expect(replay.body.detail).not.toBe(HELD_DEVICE_REPLAY);
  });
});
