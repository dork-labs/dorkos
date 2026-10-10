import { afterEach, describe, expect, it } from 'vitest';
import { COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT_PHRASE } from '../config.js';
import { expectStatus, startTenancyHarness, type TenancyHarness } from './tenancy-test-harness.js';

let harness: TenancyHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/**
 * Purpose: `apps/community/load` seeds its throwaway community through this endpoint, never
 * through invites or Better Auth sign-up (too slow at the thousands of principals a load run
 * needs). This proves the endpoint is unreachable without the test runtime, and that what it
 * seeds really authenticates a stream and a post the way `apps/community/load` depends on.
 */
describe('POST /api/test/load-fixture', () => {
  it('is not there when the test runtime is off', async () => {
    harness = await startTenancyHarness('loadfixtureoff');
    const response = await harness.call('/api/test/load-fixture', {
      body: { readerCount: 1, writerCount: 1 },
    });
    expect(response.status).toBe(404);
  });

  it('seeds a community whose reader and writer credentials work', async () => {
    harness = await startTenancyHarness('loadfixtureon', {
      env: {
        COMMUNITY_TEST_RUNTIME: 'true',
        COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT: COMMUNITY_TEST_RUNTIME_ACKNOWLEDGEMENT_PHRASE,
      },
    });
    const seeded = await expectStatus(
      await harness.call('/api/test/load-fixture', {
        body: {
          communityName: 'Load fixture test',
          channelName: 'load',
          readerCount: 3,
          writerCount: 2,
        },
      }),
      201,
      'seed load fixture'
    );
    const body = (await seeded.json()) as {
      communityId: string;
      channelId: string;
      readers: Array<{ agentId: string; token: string }>;
      writers: Array<{ agentId: string; token: string }>;
      metricsKey: string;
    };
    expect(body.readers).toHaveLength(3);
    expect(body.writers).toHaveLength(2);
    const agentIds = new Set([...body.readers, ...body.writers].map((p) => p.agentId));
    expect(agentIds.size).toBe(5);

    const base = `/api/v1/communities/${body.communityId}`;

    // A writer's token posts for real.
    const posted = await expectStatus(
      await harness.call(`${base}/channels/${body.channelId}/entries`, {
        bearer: body.writers[0].token,
        body: { text: 'hello from the load fixture', idempotencyKey: 'load-fixture-1' },
      }),
      201,
      'writer posts'
    );
    expect((await posted.json()).entry.text).toBe('hello from the load fixture');

    // A reader's token opens the live stream; the test only needs the credential and channel
    // membership to be real, so it cancels the body the moment the headers land.
    const streamResponse = await harness.call(`${base}/channels/${body.channelId}/events`, {
      bearer: body.readers[0].token,
      headers: { accept: 'text/event-stream' },
    });
    expect(streamResponse.status).toBe(200);
    await streamResponse.body?.cancel();

    // The metrics key the fixture minted reads /metrics.
    const metrics = await expectStatus(
      await harness.call('/metrics', { bearer: body.metricsKey }),
      200,
      'metrics'
    );
    expect(await metrics.text()).toContain('community_live_streams');
  });
});
