/** @vitest-environment node */
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestControlRoutes, setRemoteCommunitySubscriptionProbe } from '../test-control.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';

// The `/api` chain reads login and the host settings from here; none are set.
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: { get: vi.fn(), getDot: vi.fn() },
}));

const server = listeningServer(
  honoGroupListener({ path: '/api/test', routes: createTestControlRoutes() })
);

afterEach(() => setRemoteCommunitySubscriptionProbe(undefined));

describe('GET /api/test/community-subscription', () => {
  it('exposes only the boot-owned qualified replay barrier', async () => {
    setRemoteCommunitySubscriptionProbe((ref, roomId) =>
      ref === 'remote_owner_a' && roomId === 'room-a'
        ? {
            generation: 2,
            snapshotComplete: true,
            replayComplete: true,
            dispatchesSinceBoot: 0,
          }
        : null
    );

    const ready = await request(server)
      .get('/api/test/community-subscription')
      .query({ ref: 'remote_owner_a', roomId: 'room-a' });
    expect(ready.status).toBe(200);
    expect(ready.body).toEqual({
      generation: 2,
      snapshotComplete: true,
      replayComplete: true,
      dispatchesSinceBoot: 0,
    });

    expect(
      (
        await request(server)
          .get('/api/test/community-subscription')
          .query({ ref: 'remote_owner_a', roomId: 'other-room' })
      ).status
    ).toBe(404);
  });
});
