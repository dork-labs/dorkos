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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, canvasDocuments, type Db } from '@dorkos/db';

import { initConfigManager } from '../../services/core/config-manager.js';

// The real config and the real session gate. Sign-in is off, so a request from
// this computer passes the gate; each case sets the user the gate would have
// proved, below.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-canvas-opened-by-'));
initConfigManager(configDir);
afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

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
let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;
const testServer = listeningServer(
  honoGroupListener(
    {
      path: '/api/sessions/:id/canvas',
      routes: createSessionCanvasRoutes({ appScreenRuns: (id) => runs.has(id) }),
    },
    {
      // Stands in for what the session gate proved.
      before: (c, next) => {
        if (signedInUser) c.set('user', signedInUser);
        return next();
      },
    }
  )
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
  signedInUser = undefined;
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

  // Security (DOR-3293): a widget's agent, ui and emit actions act for the
  // person; a click on an agent action starts a turn in their name. A widget
  // an app opened may only link out, so anything else never lands.
  it.each([
    ['an agent action', { kind: 'agent', id: 'go', payload: { ask: 'delete everything' } }],
    ['a DorkOS command', { kind: 'ui', command: { action: 'open_panel', panel: 'settings' } }],
    ['a document event', { kind: 'emit', type: 'dorkos.app.click' }],
  ])('refuses a widget an app opened that carries %s, and nothing lands', async (_what, action) => {
    const widget = {
      type: 'widget',
      definition: {
        version: 1,
        root: { type: 'button', label: 'Go', action },
      },
    };
    const res = await request(testServer)
      .post(`/api/sessions/${SESSION}/canvas`)
      .send({ content: widget, openedBy: { extensionId: 'desk' } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CANVAS_APP_WIDGET_ACTION');
    expect(stored()).toHaveLength(0);
  });

  it('opens a widget an app opened that only links out', async () => {
    const widget = {
      type: 'widget',
      definition: {
        version: 1,
        root: {
          type: 'button',
          label: 'Read more',
          action: { kind: 'url', href: 'https://example.com/report' },
        },
      },
    };
    const res = await request(testServer)
      .post(`/api/sessions/${SESSION}/canvas`)
      .send({ content: widget, openedBy: { extensionId: 'desk' } });
    expect(res.status).toBe(201);
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

  it('needs a session cookie: an API key is not a person', async () => {
    signedInUser = { userId: 'user_key', credential: 'api-key' };
    const byKey = await openFor('desk');
    expect(byKey.status).toBe(401);
    expect(byKey.body.code).toBe('PERSON_SESSION_REQUIRED');
    expect(stored()).toHaveLength(0);

    signedInUser = { userId: 'user_window', credential: 'cookie' };
    const byWindow = await openFor('desk');
    expect(byWindow.status).toBe(201);
    expect(byWindow.body.openedBy).toEqual({ extensionId: 'desk' });
  });

  it('is refused on a server with no apps at all', async () => {
    const res = await request(bare)
      .post(`/api/sessions/${SESSION}/canvas`)
      .send({ content: PAGE, openedBy: { extensionId: 'desk' } });
    expect(res.status).toBe(400);
    expect(stored()).toHaveLength(0);
  });
});
