/** @vitest-environment node */
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { afterEach, describe, expect, it } from 'vitest';
import { setRemoteCommunitySubscriptionProbe, testControlRouter } from '../test-control.js';

const app = express();
app.use('/api/test', testControlRouter);
const server = listeningServer(app);

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
