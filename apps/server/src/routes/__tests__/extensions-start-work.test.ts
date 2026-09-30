/**
 * `POST /api/extensions/:id/start-work` (spec `flow-multiproject` §7.7,
 * §11.3): what `api.startWork` calls. A person's request starts one chat and
 * answers its id; an agent-headed request, a cross-site one, and every rule's
 * refusal start nothing and answer the refusal's code.
 *
 * Every person-bar case carries the residual the bar documents: with Require
 * login off, a local caller that does not name itself an agent passes.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const state = vi.hoisted(() => ({ authEnabled: false }));
const launches = vi.hoisted(() => [] as Array<{ sessionId: string; request: { cwd?: string } }>);

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) =>
      key === 'auth'
        ? { enabled: state.authEnabled }
        : { enabled: [], disabled: [], approvedToRun: [] },
    set: () => {},
  },
}));
vi.mock('../../env.js', () => ({ env: { DORKOS_PORT: 7777 } }));
vi.stubEnv('VITE_PORT', '7779');
vi.mock('../../services/session/launch/launch-session.js', () => ({
  AGENT_LAUNCH_CAP_MESSAGE: 'Too many agent-started sessions are running (8).',
  isSessionLaunchRefusal: (result: object) => 'refused' in result,
  dispatchSessionMessage: vi.fn(async (opts: (typeof launches)[number]) => {
    launches.push(opts);
    return { accepted: true, canonicalId: opts.sessionId, queued: false, queuePosition: 1 };
  }),
}));

import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import type { ProjectInfo } from '@dorkos/extension-api/server';
import { createExtensionsRouter } from '../extensions.js';
import { SessionStartedByStore } from '../../services/session/origin/session-started-by-store.js';
import { StartWorkService, setStartWorkService } from '../../services/extensions/start-work.js';

const target = swappableServer();
const server = target.server;
const TRUSTED_ORIGIN = 'http://localhost:7777';

afterAll(() => vi.unstubAllEnvs());

const BODY = {
  project: '/repos/dorkos',
  prompt: 'Say hello, then stop.',
  title: 'Saying hello in dorkos',
  reason: 'You asked for a hello',
};

const DORKOS: ProjectInfo = {
  root: '/repos/dorkos',
  name: 'dorkos',
  originRepo: null,
  lastSeenAt: '',
};

let store: SessionStartedByStore;
let signedInUser: { userId: string; credential: 'cookie' } | undefined;
let statusOf: Record<string, string>;

beforeEach(() => {
  launches.length = 0;
  state.authEnabled = false;
  signedInUser = undefined;
  statusOf = { hello: 'compiled', off: 'disabled' };
  store = new SessionStartedByStore(createTestDb());
  setStartWorkService(
    new StartWorkService({
      store,
      projects: {
        rootWithin: async (dir: string) => (dir.startsWith('/repos/dorkos') ? DORKOS.root : null),
        listForExtension: async () => [],
        list: async () => [DORKOS],
      },
      extensionName: (id) => (id === 'hello' ? 'Hello World' : id),
      runningSessionIds: () => [],
      defaultRuntime: () => 'test-mode',
      rename: async () => undefined,
    })
  );
  const manager = {
    get: (id: string) =>
      statusOf[id]
        ? {
            id,
            status: statusOf[id],
            manifest: { id, name: id === 'hello' ? 'Hello World' : 'Off', version: '1.0.0' },
          }
        : undefined,
    listPublic: () => [],
  };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    if (signedInUser) res.locals.user = signedInUser;
    next();
  });
  app.use(
    '/api/extensions',
    createExtensionsRouter(manager as never, '/tmp/unused', () => null)
  );
  target.mount(app);
});

afterEach(() => {
  setStartWorkService(undefined);
});

describe('POST /api/extensions/:id/start-work', () => {
  it('starts one chat for a person and answers its id', async () => {
    const res = await request(server)
      .post('/api/extensions/hello/start-work')
      .set('Origin', TRUSTED_ORIGIN)
      .send(BODY);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: expect.any(String) });
    expect(launches).toHaveLength(1);
    expect(launches[0]!.request.cwd).toBe('/repos/dorkos');
    expect(store.get(res.body.sessionId)).toMatchObject({
      kind: 'extension',
      extensionId: 'hello',
      reason: BODY.reason,
    });
  });

  it('refuses an agent-headed request and starts nothing', async () => {
    const res = await request(server)
      .post('/api/extensions/hello/start-work')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send(BODY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('start_work_person_required');
    expect(res.body.message).toMatch(/DorkOS started nothing/);
    expect(launches).toHaveLength(0);
  });

  it('refuses a request from another site and starts nothing', async () => {
    const res = await request(server)
      .post('/api/extensions/hello/start-work')
      .set('Origin', 'https://evil.example')
      .send(BODY);

    expect(res.status).toBe(403);
    expect(launches).toHaveLength(0);
  });

  it('refuses a caller without the cookie while Require login is on', async () => {
    state.authEnabled = true;
    const refused = await request(server)
      .post('/api/extensions/hello/start-work')
      .set('Origin', TRUSTED_ORIGIN)
      .send(BODY);
    expect(refused.status).toBe(403);
    expect(launches).toHaveLength(0);

    signedInUser = { userId: 'u1', credential: 'cookie' };
    const allowed = await request(server)
      .post('/api/extensions/hello/start-work')
      .set('Origin', TRUSTED_ORIGIN)
      .send(BODY);
    expect(allowed.status).toBe(200);
  });

  it('answers not_a_project with 404 for a folder in no project', async () => {
    const res = await request(server)
      .post('/api/extensions/hello/start-work')
      .send({ ...BODY, project: '/tmp/scratch' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error:
        "That folder isn't in a project Hello World can start work in. Choose a folder inside one of your projects.",
      code: 'not_a_project',
    });
    expect(launches).toHaveLength(0);
  });

  it('answers start_limit with 429 past the hourly limit', async () => {
    const now = new Date().toISOString();
    for (let i = 0; i < 10; i++) {
      store.insert({
        sessionId: `s-${i}`,
        kind: 'extension',
        extensionId: 'hello',
        startedBySessionId: null,
        originExtensionId: 'hello',
        reason: 'r',
        createdAt: now,
      });
    }
    const res = await request(server).post('/api/extensions/hello/start-work').send(BODY);

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('start_limit');
    expect(launches).toHaveLength(0);
  });

  it('answers 400 for a body that breaks a length rule', async () => {
    const res = await request(server)
      .post('/api/extensions/hello/start-work')
      .send({ ...BODY, title: 'x'.repeat(81) });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/title of 1 to 80 characters/);
    expect(launches).toHaveLength(0);
  });

  it('answers a generic 500, never the error itself, when the server fails', async () => {
    setStartWorkService(
      new StartWorkService({
        store,
        projects: {
          rootWithin: async () => DORKOS.root,
          listForExtension: async () => [],
          list: async () => [DORKOS],
        },
        extensionName: () => 'Hello World',
        runningSessionIds: () => [],
        defaultRuntime: () => {
          throw new TypeError("Cannot read properties of undefined (reading 'type')");
        },
      })
    );
    const res = await request(server).post('/api/extensions/hello/start-work').send(BODY);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'The chat could not be started. Try again.' });
    expect(launches).toHaveLength(0);
  });

  it('answers 404 for an unknown extension and 409 for one that is off', async () => {
    const unknown = await request(server).post('/api/extensions/nope/start-work').send(BODY);
    expect(unknown.status).toBe(404);
    const off = await request(server).post('/api/extensions/off/start-work').send(BODY);
    expect(off.status).toBe(409);
    expect(off.body.error).toBe('Turn on Off in Settings → Extensions first.');
    expect(launches).toHaveLength(0);
  });
});
