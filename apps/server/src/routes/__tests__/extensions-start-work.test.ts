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
// CORS lets this test origin through, so it reaches the route's own origin
// bar, which judges against the server's static set and not this list.
vi.stubEnv('DORKOS_CORS_ORIGIN', 'https://evil.example');
// The session gate lets every request through: these cases are about the
// route's own bar, and each one sets the user the gate would have proved
// (`before` below), as the Express version stubbed `res.locals.user`.
vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StartTurnInput } from '@dorkos/shared/turn-port';
import { createRunRecord, type RunRecord } from '../../services/runs/index.js';
import type { ProjectInfo } from '@dorkos/extension-api/server';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { createExtensionsRoutes } from '../extensions.js';
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
let record: RunRecord;
/** Every start the turn port was asked for. */
let launches: StartTurnInput[];
let signedInUser: { userId: string; credential: 'cookie' } | undefined;
let statusOf: Record<string, string>;

beforeEach(() => {
  const db = createTestDb();
  record = createRunRecord(db, { epoch: '01BOOTEPOCHROUTESTART00000' });
  launches = [];
  const start = record.port.start.bind(record.port);
  vi.spyOn(record.port, 'start').mockImplementation((input) => {
    launches.push(input);
    return start(input);
  });
  state.authEnabled = false;
  signedInUser = undefined;
  statusOf = { hello: 'compiled', off: 'disabled' };
  store = new SessionStartedByStore(createTestDb());
  setStartWorkService(
    new StartWorkService({
      port: () => record.port,
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
  target.mount(
    honoGroupListener(
      {
        path: '/api/extensions',
        routes: createExtensionsRoutes({
          manager: manager as never,
          dorkHome: '/tmp/unused',
          getCwd: () => null,
        }),
      },
      {
        before: async (c, next) => {
          if (c.req.header('x-test-via') === 'wifi') markIngress(c.env.incoming, 'wifi');
          if (signedInUser) c.set('user', signedInUser as never);
          await next();
        },
      }
    )
  );
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
    expect(launches[0]!.cwd).toBe('/repos/dorkos');
    expect(store.get(res.body.sessionId)).toMatchObject({
      kind: 'extension',
      extensionId: 'hello',
      reason: BODY.reason,
    });
  });

  it('holds a chat an extension starts to the runtime default from Wi-Fi, and not from here', async () => {
    // A Wi-Fi sign-in is always a session cookie.
    signedInUser = { userId: 'owner', credential: 'cookie' };
    const wifi = await request(server)
      .post('/api/extensions/hello/start-work')
      .set('Origin', TRUSTED_ORIGIN)
      .set('x-test-via', 'wifi')
      .send(BODY);
    expect(wifi.status).toBe(200);
    expect(launches[0]!.permissionCeiling).toBe('runtime-default');

    const here = await request(server)
      .post('/api/extensions/hello/start-work')
      .set('Origin', TRUSTED_ORIGIN)
      .send(BODY);
    expect(here.status).toBe(200);
    expect(launches[1]!.permissionCeiling).toBeUndefined();
  });

  it('refuses an agent-headed request and starts nothing', async () => {
    const res = await request(server)
      .post('/api/extensions/hello/start-work')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send(BODY);

    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(res.body.code).toBe('person_only');
    expect(res.body.detail).toMatch(/DorkOS started nothing/);
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
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(res.body).toMatchObject({
      detail: 'Choose a folder inside one of your projects.',
      code: 'not_found',
    });
    // The service's own sentence, which names the extension, stays in the log.
    expect(JSON.stringify(res.body)).not.toContain('Hello World');
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
    expect(res.body).toMatchObject({ code: 'rate_limited' });
    expect(launches).toHaveLength(0);
  });

  it('answers 400 for a body that breaks a length rule', async () => {
    const res = await request(server)
      .post('/api/extensions/hello/start-work')
      .send({ ...BODY, title: 'x'.repeat(81) });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(res.body.detail).toBe('Keep the prompt, title and reason within their length limits.');
    expect(launches).toHaveLength(0);
  });

  it('answers a generic 500, never the error itself, when the server fails', async () => {
    setStartWorkService(
      new StartWorkService({
        port: () => record.port,
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
    expect(res.body).toMatchObject({
      code: 'internal_error',
      detail: 'The chat couldn’t be started. Try again.',
    });
    expect(JSON.stringify(res.body)).not.toContain('Cannot read properties');
    expect(launches).toHaveLength(0);
  });

  it('answers not_running for an unknown extension and one that is off, never not_found', async () => {
    // `not_found` from this route means a folder outside every project, which
    // the app throws as `not_a_project`: an unknown extension must not read so.
    const unknown = await request(server).post('/api/extensions/nope/start-work').send(BODY);
    expect(unknown.status).toBe(409);
    expect(unknown.body.code).toBe('not_running');
    const off = await request(server).post('/api/extensions/off/start-work').send(BODY);
    expect(off.status).toBe(409);
    expect(off.body).toMatchObject({
      code: 'not_running',
      detail: 'Turn on Off in Settings → Extensions first.',
    });
    expect(launches).toHaveLength(0);
  });
});
