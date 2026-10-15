/**
 * `PUT /api/heartbeats/triage-credits` (spec `heartbeats` §6.3): only the owner
 * answers the credits offer, never an agent, and the answer is recorded.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The chain these routes run behind reads config and the tunnel per request.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(null), set: vi.fn() },
}));
vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: { status: { enabled: false, connected: false, url: null } },
}));
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

const refusal = vi.hoisted(() => ({
  value: undefined as undefined | 'not-a-person' | 'not-the-owner',
}));
vi.mock('../../lib/caller-authority.js', () => ({
  refuseUnlessAccountOwner: () => refusal.value,
}));

import { createHeartbeatTriageRoutes } from '../heartbeat-triage.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';

const target = swappableServer();
let choice: boolean | null;
let records: Array<[boolean | null, boolean]>;

beforeEach(() => {
  choice = null;
  records = [];
  refusal.value = undefined;
  const routes = createHeartbeatTriageRoutes({
    choice: () => choice,
    setChoice: (next) => {
      choice = next;
    },
    record: (before, after) => records.push([before, after]),
  });
  target.mount(honoGroupListener({ path: '/api/heartbeats/triage-credits', routes }));
});

describe('PUT /api/heartbeats/triage-credits', () => {
  it('stores Use credits and Not now, recording each change once', async () => {
    const yes = await request(target.server)
      .put('/api/heartbeats/triage-credits')
      .send({ useCredits: true });
    expect(yes.status).toBe(200);
    expect(yes.body).toEqual({ useCredits: true });
    expect(choice).toBe(true);
    await request(target.server).put('/api/heartbeats/triage-credits').send({ useCredits: true });
    await request(target.server).put('/api/heartbeats/triage-credits').send({ useCredits: false });
    expect(choice).toBe(false);
    expect(records).toEqual([
      [null, true],
      [true, false],
    ]);
  });

  it('refuses an agent, and a person who does not own this DorkOS, changing nothing', async () => {
    refusal.value = 'not-a-person';
    const agent = await request(target.server)
      .put('/api/heartbeats/triage-credits')
      .send({ useCredits: true });
    expect(agent.status).toBe(403);
    expect(agent.body.code).toBe('person_only');
    refusal.value = 'not-the-owner';
    const other = await request(target.server)
      .put('/api/heartbeats/triage-credits')
      .send({ useCredits: true });
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('owner_only');
    expect(choice).toBeNull();
    expect(records).toEqual([]);
  });

  it('refuses a body that is not an answer', async () => {
    const res = await request(target.server)
      .put('/api/heartbeats/triage-credits')
      .send({ useCredits: 'yes' });
    expect(res.status).toBe(400);
    expect(choice).toBeNull();
  });
});
