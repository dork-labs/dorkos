/**
 * @vitest-environment node
 *
 * Waking a linked computer asks Cloud for exactly one viewer-open command.
 */
import { describe, expect, it, vi } from 'vitest';
import { ViewerOpenResponseSchema } from '@dork-labs/cloud-api';

import { hubRelayWake, type HubRelayWakeClient } from '../hub-relay-wake.js';

describe('hubRelayWake', () => {
  it('wakes nobody on a hub with no Cloud key', () => {
    expect(hubRelayWake(null)).toBeNull();
  });

  it("asks Cloud to open a viewer on that computer's instance, and nothing else", async () => {
    const post = vi.fn<HubRelayWakeClient['post']>(async () => ({
      commandId: 'cmd-1',
      queuedAt: '2026-10-17T00:00:00.000Z',
    }));
    const wake = hubRelayWake({ post })!;
    await wake('inst/1');
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      '/v1/instances/inst%2F1/viewer-open',
      ViewerOpenResponseSchema,
      {
        body: {},
        signal: expect.any(AbortSignal),
      }
    );
  });

  it('passes a refusal on, so the waker can log it', async () => {
    const wake = hubRelayWake({
      post: async () => {
        throw new Error('not_found');
      },
    })!;
    await expect(wake('inst-2')).rejects.toThrow('not_found');
  });
});
