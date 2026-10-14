/**
 * `POST /api/keep-awake/session` and `DELETE /api/keep-awake/session` — a timed
 * session, written to the real config through the same guarded door as
 * `PATCH /api/config`, and reflected at once in the status the routes answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { KeepAwakeStatusSchema } from '@dorkos/shared/schemas';
import { createKeepAwake, type KeepAwakeOptions } from '@dorkos/keep-awake';

vi.mock('../../services/core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));

/** Stands in for the `X-DorkOS-Agent` header an agent's CLI attaches. */
let agentHeader: string | undefined;

const target = swappableServer();
const server = target.server;

/** A holder that never touches the OS. */
class FakeChild extends EventEmitter {
  pid = 999;
  kill(): boolean {
    this.emit('exit', null, 'SIGTERM');
    return true;
  }
}

describe('/api/keep-awake/session', () => {
  let tmpDir: string;
  let stopService: () => Promise<void>;
  let readStored: () => string | null;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-keep-awake-session-'));
    process.env.DORK_HOME = tmpDir;
    const { initConfigManager } = await import('../../services/core/config-manager.js');
    const configManager = initConfigManager(tmpDir);
    readStored = () => configManager.get('keepAwake').manualUntil;
    configManager.set('keepAwake', { ...configManager.get('keepAwake'), mode: 'off' });

    const { keepAwakeService } = await import('../../services/core/keep-awake/index.js');
    keepAwakeService.start({
      readSettings: () => configManager.get('keepAwake'),
      onSettingsChange: (listener) => configManager.onChange((change) => listener(change.sections)),
      broadcast: () => {},
      readPower: async () => null,
      createKeepAwake: (options?: KeepAwakeOptions) =>
        createKeepAwake({
          ...options,
          platform: 'darwin',
          env: {},
          fileExists: () => false,
          readFile: () => null,
          spawn: () => new FakeChild() as never,
        }),
    });
    stopService = () => keepAwakeService.stop();

    const router = (await import('../keep-awake.js')).default;
    const { honoGroupListener } = await import('../../http/__tests__/hono-group-listener.js');
    agentHeader = undefined;
    target.mount(
      honoGroupListener(
        { path: '/api/keep-awake', routes: router },
        {
          before: async (c, next) => {
            if (agentHeader) c.env.incoming.headers['x-dorkos-agent'] = agentHeader;
            await next();
          },
        }
      )
    );
  });

  afterEach(async () => {
    await stopService();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('starts a session for some minutes, stores it, and answers the new status', async () => {
    const before = Date.now();
    const res = await request(server).post('/api/keep-awake/session').send({ minutes: 60 });
    expect(res.status).toBe(200);
    expect(KeepAwakeStatusSchema.parse(res.body)).toEqual(res.body);
    expect(res.body).toMatchObject({ mode: 'off', enabled: false, asserted: true });

    const until = Date.parse(res.body.manual.until);
    expect(until).toBeGreaterThanOrEqual(before + 60 * 60_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 60 * 60_000);
    expect(readStored()).toBe(res.body.manual.until);
  });

  it('starts a session until a given time, and replaces one already running', async () => {
    await request(server).post('/api/keep-awake/session').send({ minutes: 10 }).expect(200);
    const until = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    const res = await request(server).post('/api/keep-awake/session').send({ until }).expect(200);
    expect(res.body.manual).toEqual({ until });
    expect(readStored()).toBe(until);
  });

  it.each([
    ['nothing', {}],
    ['zero minutes', { minutes: 0 }],
    ['more than a day of minutes', { minutes: 1441 }],
    ['fractional minutes', { minutes: 1.5 }],
    ['both fields', { minutes: 5, until: new Date(Date.now() + 60_000).toISOString() }],
    ['an unreadable time', { until: 'tonight' }],
  ])('refuses %s with 400 and writes nothing', async (_label, body) => {
    const res = await request(server).post('/api/keep-awake/session').send(body);
    expect(res.status).toBe(400);
    expect(readStored()).toBeNull();
  });

  it('refuses an end in the past or more than a day away', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const tooFar = new Date(Date.now() + 25 * 60 * 60_000).toISOString();
    expect(
      (await request(server).post('/api/keep-awake/session').send({ until: past })).status
    ).toBe(400);
    expect(
      (await request(server).post('/api/keep-awake/session').send({ until: tooFar })).status
    ).toBe(400);
    expect(readStored()).toBeNull();
  });

  it('ends the session, and answers the same when none runs', async () => {
    await request(server).post('/api/keep-awake/session').send({ minutes: 30 }).expect(200);
    const ended = await request(server).delete('/api/keep-awake/session').expect(200);
    expect(ended.body).toMatchObject({ manual: null, mode: 'off' });
    expect(readStored()).toBeNull();
    await request(server).delete('/api/keep-awake/session').expect(200);
  });

  it('refuses an agent, both ways, like PATCH /api/config does', async () => {
    agentHeader = 'agent-token';
    const start = await request(server).post('/api/keep-awake/session').send({ minutes: 30 });
    expect(start.status).toBe(403);
    expect(start.body.code).toBe('operator_only_config');
    expect(start.body.paths).toEqual(['keepAwake.manualUntil']);
    expect(readStored()).toBeNull();

    agentHeader = undefined;
    await request(server).post('/api/keep-awake/session').send({ minutes: 30 }).expect(200);
    agentHeader = 'agent-token';
    expect((await request(server).delete('/api/keep-awake/session')).status).toBe(403);
    expect(readStored()).not.toBeNull();
  });
});
