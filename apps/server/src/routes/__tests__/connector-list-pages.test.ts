/**
 * The owner's connection lists come a page at a time, newest first (DOR-4982),
 * on the mount and on the hand routes alike, and a cursor a list did not give
 * is refused, never read as the first page.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { initConfigManager } from '../../services/core/config-manager.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { INVALID_CURSOR_DETAIL } from '../../lib/paging/keyset-page.js';
import { createConnectorManagementRoutes } from '../connector-management.js';
import { createConnectorResourcesRoutes } from '../connector-resources.js';
import { withOwnerDoors } from './connector-owner-doors.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const fixtureTarget = swappableServer();
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-connector-list-pages-'));
beforeAll(() => initConfigManager(configDir));
afterAll(() => fs.rmSync(configDir, { recursive: true, force: true }));

const at = (day: number) => `2026-11-0${day}T00:00:00.000Z`;
const base = {
  registry: { migrationHealth: () => ({ status: 'ready', migrated: false }) },
  resolveOwner: () => OWNER,
  loginEnabled: () => false,
  trustedOrigins: () => ['http://localhost:4242'],
};

/** Every page of `url`, following `nextCursor`, as the rows `field` holds. */
async function walk(app: ReturnType<typeof honoGroupListener>, url: string, field: string) {
  const ids: unknown[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const page = await request(fixtureTarget.mount(app)).get(`${url}${query}`).expect(200);
    ids.push(...page.body[field]);
    cursor = page.body.nextCursor;
  } while (cursor);
  return ids;
}

describe('the owner’s connection lists, a page at a time', () => {
  const reviews = {
    get: vi.fn(),
    list: vi.fn(() => [1, 3, 2].map((day) => ({ reviewRequestId: `r${day}`, createdAt: at(day) }))),
  };
  const mount = honoGroupListener(
    withOwnerDoors(createConnectorManagementRoutes, {
      ...base,
      reviews,
    } as unknown as Parameters<typeof createConnectorManagementRoutes>[0])
  );
  const ages = new Map([1, 2, 3].map((day) => [`c${day}`, at(day)]));
  const hand = honoGroupListener(
    withOwnerDoors(createConnectorResourcesRoutes, {
      ...base,
      signIns: { refreshOnDemand: async () => undefined },
      query: {
        listConnections: async () => ['c2', 'c1', 'c3'].map((connectionId) => ({ connectionId })),
        createdAtOf: () => ages,
      },
    } as unknown as Parameters<typeof createConnectorResourcesRoutes>[0])
  );

  it('walks a mounted list newest first, each row once', async () => {
    const rows = await walk(mount, '/api/connectors/reviews?limit=2', 'reviews');
    expect(rows.map((row) => (row as { reviewRequestId: string }).reviewRequestId)).toEqual([
      'r3',
      'r2',
      'r1',
    ]);
  });

  it('walks a hand-route list newest connected first, each row once', async () => {
    const rows = await walk(hand, '/api/connectors/connections?limit=1', 'connections');
    expect(rows).toEqual([{ connectionId: 'c3' }, { connectionId: 'c2' }, { connectionId: 'c1' }]);
  });

  it('refuses a cursor another list gave, on the mount and by hand, with one sentence', async () => {
    const pending = await request(fixtureTarget.mount(mount))
      .get('/api/connectors/reviews?state=pending&limit=1')
      .expect(200);
    const refusals = [
      await request(fixtureTarget.mount(mount)).get(
        `/api/connectors/reviews?limit=1&cursor=${pending.body.nextCursor}`
      ),
      await request(fixtureTarget.mount(hand)).get('/api/connectors/connections?cursor=nope'),
    ];
    for (const refused of refusals) {
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        code: 'invalid_request',
        detail: INVALID_CURSOR_DETAIL,
      });
    }
  });
});
