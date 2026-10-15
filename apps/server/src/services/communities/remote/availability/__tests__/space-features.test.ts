import { describe, expect, it, vi } from 'vitest';
import { PinnedHttpError } from '../../pinned-origin.js';
import {
  SPACE_FEATURES_RETRY_MS,
  SPACE_FEATURES_TTL_MS,
  SpaceFeatures,
} from '../space-features.js';

function clock() {
  let now = 1_000_000;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('SpaceFeatures', () => {
  it('reads a space that has the feature once, and keeps the answer for the TTL', async () => {
    const time = clock();
    const read = vi.fn(async () => ({ features: { agentAvailability: true } }));
    const features = new SpaceFeatures(read, time.now);
    await expect(features.has('agentAvailability')).resolves.toBe(true);
    await expect(features.has('agentAvailability')).resolves.toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    time.advance(SPACE_FEATURES_TTL_MS);
    await features.has('agentAvailability');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('reads an old space (404) as none, quietly, and asks again only after the TTL', async () => {
    const time = clock();
    const read = vi.fn(async () => {
      throw new PinnedHttpError(404);
    });
    const features = new SpaceFeatures(read, time.now);
    await expect(features.has('agentAvailability')).resolves.toBe(false);
    time.advance(SPACE_FEATURES_TTL_MS - 1);
    await expect(features.has('agentAvailability')).resolves.toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads a failure as none and asks again sooner', async () => {
    const time = clock();
    const read = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValue({ features: { agentAvailability: true } });
    const features = new SpaceFeatures(read, time.now);
    await expect(features.has('agentAvailability')).resolves.toBe(false);
    time.advance(SPACE_FEATURES_RETRY_MS);
    await expect(features.has('agentAvailability')).resolves.toBe(true);
  });

  it('reads a feature the space does not name, or names false, as off', async () => {
    const features = new SpaceFeatures(async () => ({ features: { somethingLater: true } }));
    await expect(features.has('agentAvailability')).resolves.toBe(false);
    const off = new SpaceFeatures(async () => ({ features: { agentAvailability: false } }));
    await expect(off.has('agentAvailability')).resolves.toBe(false);
  });

  it('asks again after forget, and shares one read between callers', async () => {
    const read = vi.fn(async () => ({ features: { agentAvailability: true } }));
    const features = new SpaceFeatures(read);
    await Promise.all([features.has('agentAvailability'), features.has('agentAvailability')]);
    expect(read).toHaveBeenCalledTimes(1);
    features.forget();
    await features.has('agentAvailability');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
