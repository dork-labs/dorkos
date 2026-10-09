import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitStreamLive } from '../messaging/bounded-abort.js';
import { STREAM_LIVE_TIMEOUT_MS } from '../runtime-constants.js';

// Ordinary timer ownership only; no runtime, SDK, native stream, or issuer.
describe('OpenCode stream liveness timer ownership', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('retires the losing timer when the original stream becomes live', async () => {
    let markLive: (() => void) | undefined;
    const live = new Promise<void>((resolve) => {
      markLive = resolve;
    });
    const waiting = awaitStreamLive(live, STREAM_LIVE_TIMEOUT_MS);
    expect(vi.getTimerCount()).toBe(1);
    const readMarkLive = (): (() => void) | undefined => markLive;
    const resolveLive = readMarkLive();
    expect(resolveLive).toBeTypeOf('function');
    if (typeof resolveLive !== 'function') throw new Error('Original live resolver is unavailable');
    resolveLive();
    await waiting;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a raw undefined refusal and retires its timer', async () => {
    const waiting = awaitStreamLive(Promise.reject(undefined), STREAM_LIVE_TIMEOUT_MS);
    await expect(waiting).rejects.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the original complete bound when the stream never becomes live', async () => {
    let finished = false;
    const waiting = awaitStreamLive(new Promise<void>(() => {}), STREAM_LIVE_TIMEOUT_MS).then(
      () => {
        finished = true;
      }
    );
    await vi.advanceTimersByTimeAsync(STREAM_LIVE_TIMEOUT_MS - 1);
    expect(finished).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(finished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
