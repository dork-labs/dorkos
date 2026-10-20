import { describe, expect, it } from 'vitest';

import { HUB_LONG_BEAT_MS, HUB_SHORT_BEAT_MS, nextHubBeatMs } from '../hub-assignment-runner.js';

describe('how long a hub waits before reading its assignment again', () => {
  it('takes Cloud`s wait while pooled, or the short beat when Cloud sets none', () => {
    expect(nextHubBeatMs({ kind: 'pooled', pollAfterSeconds: 7 })).toBe(7_000);
    expect(nextHubBeatMs({ kind: 'pooled', pollAfterSeconds: null })).toBe(HUB_SHORT_BEAT_MS);
  });

  it('reads rarely once it serves, and soon after a failure', () => {
    expect(nextHubBeatMs({ kind: 'serving', assignmentId: 'a' })).toBe(HUB_LONG_BEAT_MS);
    expect(nextHubBeatMs({ kind: 'unchanged', reason: 'failed' })).toBe(HUB_SHORT_BEAT_MS);
  });

  it('stops for good once it refuses or its assignment ends', () => {
    expect(nextHubBeatMs({ kind: 'refused' })).toBeNull();
    expect(nextHubBeatMs({ kind: 'ended' })).toBeNull();
  });
});
