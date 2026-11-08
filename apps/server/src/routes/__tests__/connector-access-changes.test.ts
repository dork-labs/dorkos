/** The person's access-change routes: owner only, with the reason exactly as written. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { AccessNarrowingError } from '../../services/connectors/access/access-narrowing.js';
import { createConnectorAccessChangeRoutes } from '../connector-access-changes.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const fixtureTarget = swappableServer();
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-access-changes-'));
beforeAll(() => {
  initConfigManager(configDir);
});
afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('access-change routes', () => {
  const narrowing = { undo: vi.fn() };
  let db: Db;

  beforeEach(() => {
    vi.clearAllMocks();
    narrowing.undo.mockResolvedValue({ undoId: 'undo-a' });
    db = createDb(':memory:');
    runMigrations(db);
  });

  function buildApp(options: { user?: RequestUser; loginEnabled?: boolean } = {}) {
    return honoGroupListener(
      {
        path: '/api/connectors',
        routes: createConnectorAccessChangeRoutes({
          narrowing,
          db,
          resolveOwner: () => OWNER,
          loginEnabled: () => options.loginEnabled ?? false,
          trustedOrigins: () => ['http://localhost:4242'],
          isAccountOwner: (user) => user?.userId === 'user-a',
        }),
      },
      {
        before: async (c, next) => {
          if (options.user) c.set('user', options.user);
          await next();
        },
      }
    );
  }

  it.each([
    ['get', '/api/connectors/access-changes'],
    ['post', '/api/connectors/access-changes/change-a/undo'],
    ['get', '/api/connectors/access-changes/change-a'],
  ] as const)(
    'refuses an agent, an approval token and a foreign page on %s %s',
    async (method, url) => {
      await request(fixtureTarget.mount(buildApp()))
        [method](url)
        .set('X-DorkOS-Agent', 'agent-a')
        .expect(403);
      await request(fixtureTarget.mount(buildApp()))
        [method](url)
        .set('x-dorkos-approval', 'token')
        .expect(403);
      await request(fixtureTarget.mount(buildApp()))
        [method](url)
        .set('Origin', 'https://evil.example')
        .expect(403);
      await request(
        fixtureTarget.mount(
          buildApp({ user: { userId: 'user-b', credential: 'cookie' }, loginEnabled: true })
        )
      )
        [method](url)
        .set('Origin', 'http://localhost:4242')
        .expect(403);
      expect(narrowing.undo).not.toHaveBeenCalled();
    }
  );

  it('lets the owner list changes and undo one', async () => {
    await request(fixtureTarget.mount(buildApp()))
      .get('/api/connectors/access-changes')
      .expect(200, { changes: [] });
    await request(fixtureTarget.mount(buildApp()))
      .post('/api/connectors/access-changes/change-a/undo')
      .expect(200, { changeId: 'change-a', undoId: 'undo-a' });
    expect(narrowing.undo).toHaveBeenCalledWith(OWNER, 'change-a');
  });

  it('answers one change the owner does not have with 404', async () => {
    await request(fixtureTarget.mount(buildApp()))
      .get('/api/connectors/access-changes/change-z')
      .expect(404, { error: 'Nothing to show there.', code: 'UNDO_NOT_FOUND' });
  });

  it('answers a stale Undo with 409 and an unknown one with 404', async () => {
    narrowing.undo.mockRejectedValueOnce(new AccessNarrowingError('UNDO_STALE'));
    await request(fixtureTarget.mount(buildApp()))
      .post('/api/connectors/access-changes/change-a/undo')
      .expect(409);
    narrowing.undo.mockRejectedValueOnce(new AccessNarrowingError('UNDO_NOT_FOUND'));
    await request(fixtureTarget.mount(buildApp()))
      .post('/api/connectors/access-changes/change-z/undo')
      .expect(404);
  });
});
