/**
 * Who can mark a session canvas document "opened by" an app (DOR-3293,
 * Security 2026-11-10).
 *
 * Only a person's window, through the frame bridge, and only for an app whose
 * screens run right now. An agent sending the mark is refused before anything
 * is written, and an id that names no running app is refused too.
 *
 * Driven through the real API chain, so the agent identity middleware resolves
 * the caller exactly as it does in production.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, canvasDocuments, type Db } from '@dorkos/db';

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createRoomSubsystem, setRoomService } from '../../services/rooms/index.js';
import { setCanvasService } from '../../services/canvas/index.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../services/core/agent-identity/agent-identity-service.js';
import { createSessionCanvasRoutes } from '../session-canvas.js';

const SESSION = '0e7270c6-5555-4666-8777-888888888888';
const PAGE = { type: 'url', url: 'https://example.test/report' } as const;

/** Desk runs; Notes is installed but turned off; nothing else exists. */
const runs = new Set(['desk']);
const testServer = listeningServer(
  honoGroupListener({
    path: '/api/sessions/:id/canvas',
    routes: createSessionCanvasRoutes({ appScreenRuns: (id) => runs.has(id) }),
  })
);

/** A server with no apps at all: the check is unset. */
const bare = listeningServer(
  honoGroupListener({ path: '/api/sessions/:id/canvas', routes: createSessionCanvasRoutes() })
);

const openFor = (extensionId: string) =>
  request(testServer)
    .post(`/api/sessions/${SESSION}/canvas`)
    .send({ content: PAGE, openedBy: { extensionId } });

let db: Db;
const stored = () => db.select().from(canvasDocuments).all();

beforeEach(async () => {
  db = createTestDb();
  runtimeRegistry.setDb(db);
  const subsystem = createRoomSubsystem({ db });
  setRoomService(subsystem.service);
  setCanvasService(subsystem.canvas);
  await runtimeRegistry.persistSessionRuntime(SESSION, 'claude-code', { kind: 'interactive' });
});

afterEach(() => {
  resetAgentIdentityService();
});

describe('the "opened by" mark on a session canvas', () => {
  it('is written for an app whose screens run', async () => {
    const res = await openFor('desk');
    expect(res.status).toBe(201);
    expect(res.body.openedBy).toEqual({ extensionId: 'desk' });
    expect(stored()[0]?.openedByExtensionId).toBe('desk');
  });

  it('is refused for an app that is off, or not installed, and nothing lands', async () => {
    for (const id of ['notes', 'no-such-app']) {
      const res = await openFor(id);
      expect(res.status, id).toBe(400);
      expect(res.body.code).toBe('CANVAS_OPENED_BY_UNKNOWN_APP');
    }
    expect(stored()).toHaveLength(0);
  });

  it('is refused to an agent caller, even naming a running app', async () => {
    const now = new Date().toISOString();
    db.insert(agents)
      .values({
        id: 'ULID_ANA',
        name: 'ana',
        displayName: 'Ana',
        runtime: 'claude-code',
        projectPath: '/agents/ana',
        behaviorJson: '{"responseMode":"silent"}',
        registeredAt: now,
        updatedAt: now,
      })
      .run();
    const token = await initAgentIdentityService(db).mint({
      agentPath: '/agents/ana',
      displayName: 'Ana',
    });

    const res = await request(testServer)
      .post(`/api/sessions/${SESSION}/canvas`)
      .set('X-DorkOS-Agent', token)
      .send({ content: PAGE, openedBy: { extensionId: 'desk' } });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PEOPLE_ONLY');
    expect(stored()).toHaveLength(0);
  });

  it('is refused on a server with no apps at all', async () => {
    const res = await request(bare)
      .post(`/api/sessions/${SESSION}/canvas`)
      .send({ content: PAGE, openedBy: { extensionId: 'desk' } });
    expect(res.status).toBe(400);
    expect(stored()).toHaveLength(0);
  });
});
