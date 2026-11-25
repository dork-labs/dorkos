import { afterEach, describe, expect, it, vi } from 'vitest';
import { ViewerControlQueue } from '../control-queue.js';
afterEach(() => vi.useRealTimers());
describe('bounded per-page logical control queue', () => {
  it('bounds backlog, serializes work and releases rejected slots', async () => {
    const queue = new ViewerControlQueue();
    let release!: () => void;
    const held = queue.submit(
      () =>
        new Promise<void>((r) => {
          release = r;
        })
    );
    await Promise.resolve();
    const effect = vi.fn(async () => undefined);
    const pending = Array.from({ length: 63 }, () => queue.submit(effect));
    expect(() => queue.submit(effect)).toThrow('viewer_busy');
    expect(effect).not.toHaveBeenCalled();
    release();
    await held;
    await Promise.all(pending);
    expect(effect).toHaveBeenCalledTimes(63);
    await expect(
      queue.submit(async () => {
        throw Error('failed');
      })
    ).rejects.toThrow('failed');
    await expect(queue.submit(effect)).resolves.toBeUndefined();
  });
  it('expires queued inputs without dispatch and refills the rate bucket by elapsed time', async () => {
    vi.useFakeTimers();
    const queue = new ViewerControlQueue();
    let release!: () => void;
    const held = queue.submit(
      () =>
        new Promise<void>((r) => {
          release = r;
        })
    );
    await Promise.resolve();
    const effect = vi.fn(async () => undefined);
    const expired = expect(queue.submit(effect)).rejects.toThrow('viewer_stale');
    await vi.advanceTimersByTimeAsync(2001);
    release();
    await held;
    await expired;
    expect(effect).not.toHaveBeenCalled();
    for (let n = 0; n < 120; n++) await queue.submit(effect);
    expect(() => queue.submit(effect)).toThrow('viewer_busy');
    await vi.advanceTimersByTimeAsync(1000);
    await queue.submit(effect);
    expect(effect).toHaveBeenCalledTimes(121);
  });
});
