/**
 * `POST /api/test/persistent`, `GET /api/test/persistent` and
 * `POST /api/test/reap` — the seam a browser test drives the held-process path
 * with (DOR-1326).
 *
 * Two properties are worth pinning here rather than only in the e2e, because
 * both are invisible from a spec that passes.
 *
 * **The opt-in is per session.** The test-mode server is shared by four
 * concurrent Playwright projects, so a control that leaked into a neighbour's
 * sessions would warm chats no spec asked to warm — and the symptom would be a
 * Steer row appearing in an unrelated suite, days later, on a different file.
 *
 * **The read goes through the RUNTIME.** Warmth has no product API (it is
 * invisible to the person by design), so this route is the only way a browser
 * can see it — which makes it worth proving it reports what
 * `getSessionWarmth`/`canSteerSession` say rather than a number of its own.
 *
 * The router is mounted on a bare express app rather than reached through
 * `createApp`, matching `test-control-agent-token.test.ts`: `app.ts` mounts
 * `/api/test/*` only under `DORKOS_TEST_RUNTIME`, so mounting it directly tests
 * the handler rather than the env gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { testControlRouter } from '../test-control.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';
import { heldProcesses } from '../../services/runtimes/test-mode/held-process.js';
import { TestModeRuntime } from '../../services/runtimes/test-mode/test-mode-runtime.js';

const SESSION = 'aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEIGHBOUR = 'bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
/** A session owned by a runtime these controls do not speak for. */
const FOREIGN = 'ccccccc1-cccc-4ccc-8ccc-cccccccccccc';

describe('the held-process controls', () => {
  let app: express.Express;

  beforeEach(() => {
    runtimeRegistry.setDb(createTestDb());
    runtimeRegistry.register(new TestModeRuntime());
    runtimeRegistry.setDefault('test-mode');
    app = express();
    app.use(express.json());
    app.use('/api/test', testControlRouter);
  });

  afterEach(() => {
    heldProcesses.reset();
  });

  /** What the runtime says about a session, as the browser leg reads it. */
  async function readState(sessionId: string) {
    const res = await request(app).get('/api/test/persistent').query({ sessionId });
    expect(res.status).toBe(200);
    return res.body as {
      enabled: boolean;
      warmth: string;
      steerable: boolean;
      stageable: boolean;
    };
  }

  it('reports a session nobody opted in as cold, unsteerable and unstageable', async () => {
    expect(await readState(SESSION)).toEqual({
      enabled: false,
      warmth: 'cold',
      steerable: false,
      stageable: false,
    });
  });

  it('turns the held path on for the named session and nobody else', async () => {
    const res = await request(app)
      .post('/api/test/persistent')
      .send({ sessionId: SESSION, enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, sessionId: SESSION, enabled: true });

    expect(await readState(SESSION)).toMatchObject({
      enabled: true,
      steerable: true,
      stageable: true,
    });
    // The whole reason the control names a session: a neighbouring project's
    // chat on this same server must be untouched.
    expect(await readState(NEIGHBOUR)).toMatchObject({
      enabled: false,
      steerable: false,
      stageable: false,
    });
  });

  it('reports the warmth a completed turn left behind, and gives it back on a reap', async () => {
    await request(app).post('/api/test/persistent').send({ sessionId: SESSION, enabled: true });

    const runtime = runtimeRegistry.getDefault();
    for await (const _event of runtime.sendMessage(SESSION, 'hello', { cwd: '/projects/test' })) {
      // Drained: what matters is the process the finished turn left held.
    }
    expect(await readState(SESSION)).toMatchObject({ warmth: 'warm' });

    const reaped = await request(app).post('/api/test/reap').send({ sessionId: SESSION });
    expect(reaped.status).toBe(200);
    // Cold again, without a test having to wait out an idle window nothing can
    // hurry — and still on the path, so the next message boots a fresh process.
    expect(await readState(SESSION)).toMatchObject({ warmth: 'cold', steerable: true });
  });

  it('refuses to opt in a session bound to a runtime that is not test-mode', async () => {
    // This server registers a claude-code-typed alias, and `?runtime=` can bind
    // a session to another instance entirely — so an opt-in written for a
    // session some OTHER adapter owns would sit there unread, and the failure
    // would surface much later as a Steer row that never appeared.
    runtimeRegistry.register(new FakeAgentRuntime('not-test-mode'));
    await runtimeRegistry.persistSessionRuntime(FOREIGN, 'not-test-mode');

    const res = await request(app)
      .post('/api/test/persistent')
      .send({ sessionId: FOREIGN, enabled: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not-test-mode');
    expect(heldProcesses.isEnabled(FOREIGN)).toBe(false);
    // The read and the reap refuse it on the same terms, so the three controls
    // can never disagree about which runtime they are speaking for.
    expect(
      (await request(app).get('/api/test/persistent').query({ sessionId: FOREIGN })).status
    ).toBe(400);
    expect((await request(app).post('/api/test/reap').send({ sessionId: FOREIGN })).status).toBe(
      400
    );
  });

  it('refuses a request that names no session', async () => {
    expect((await request(app).post('/api/test/persistent').send({ enabled: true })).status).toBe(
      400
    );
    expect((await request(app).get('/api/test/persistent')).status).toBe(400);
    expect((await request(app).post('/api/test/reap').send({})).status).toBe(400);
  });
});
