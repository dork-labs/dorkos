/**
 * `POST /api/test/heartbeat/beat` — a beat on demand, through the real runner.
 *
 * What it must do: hand the agent to the running beat runner with the timer's
 * own wake, answer only once that beat has finished, and say so plainly when
 * heartbeats are not running rather than answering ok for a beat that never
 * happened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestHeartbeatRoutes } from '../test-heartbeat.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';

// The `/api` chain reads login and the host settings from here; none are set.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(), getDot: vi.fn() },
}));

const running = vi.hoisted(() => ({ handle: undefined as unknown }));
vi.mock('../../services/heartbeats/heartbeats-wiring.js', () => ({
  runningHeartbeats: () => running.handle,
}));

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

describe('POST /api/test/heartbeat/beat', () => {
  beforeEach(() => {
    fixtureTarget.mount(
      honoGroupListener({ path: '/api/test/heartbeat', routes: createTestHeartbeatRoutes() })
    );
  });

  afterEach(() => {
    running.handle = undefined;
  });

  it('asks the runner for a timer beat and answers once it has finished', async () => {
    let finished = false;
    const wake = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      finished = true;
    });
    running.handle = { runner: { wake } };

    const res = await request(fixtureServer)
      .post('/api/test/heartbeat/beat')
      .send({ agentId: 'agent-1' });

    expect(res.status).toBe(200);
    expect(wake).toHaveBeenCalledWith('agent-1', { wake: 'timer' });
    expect(finished).toBe(true);
  });

  it('refuses when heartbeats are not running', async () => {
    const res = await request(fixtureServer)
      .post('/api/test/heartbeat/beat')
      .send({ agentId: 'agent-1' });

    expect(res.status).toBe(503);
  });

  it('refuses a request that names no agent', async () => {
    running.handle = { runner: { wake: vi.fn() } };
    const res = await request(fixtureServer).post('/api/test/heartbeat/beat').send({});

    expect(res.status).toBe(400);
  });
});
