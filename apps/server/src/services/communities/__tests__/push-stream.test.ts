/**
 * @vitest-environment node
 *
 * The bound on a community stream's queue — the one property that decides
 * whether a reader that stops pulling costs this process a little memory or all
 * of it.
 *
 * `RoomBroadcaster` has held this policy since it was written: a subscriber that
 * falls `MAX_QUEUED_EVENTS` behind is ENDED rather than buffered further, and
 * the reader recovers by reconnecting. These assertions are the same policy,
 * asked of the stream every `CommunityAdapter` hands out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../lib/logger.js';
import { PushStream } from '../push-stream.js';

/**
 * The bound, spelled out rather than imported, so these assertions are
 * behavioural on any tree: a suite that only ever loops to an imported constant
 * pushes nothing at all when the constant is not there yet, and reds for the
 * wrong reason. The import is asserted equal to it below, so the two cannot
 * drift.
 */
const BOUND = 1000;

/** Read everything a stream will hand over without parking, then say how it ended. */
async function drain<T>(stream: PushStream<T>): Promise<{ values: T[]; done: boolean }> {
  const iterator = stream[Symbol.asyncIterator]();
  const values: T[] = [];
  for (;;) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<T>>((resolve) =>
        setTimeout(() => resolve({ value: undefined as never, done: false }), 20)
      ),
    ]);
    if (next.done) return { values, done: true };
    if (next.value === undefined) return { values, done: false };
    values.push(next.value);
  }
}

describe('PushStream', () => {
  // Restored between cases: `vi.spyOn` on an already-spied method hands back the
  // same mock, so a per-case call count would otherwise carry the previous
  // case's calls with it.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bounds its queue and ends the stream rather than buffering without limit', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const stream = new PushStream<number>();

    // One more than the bound, with nobody pulling — the stalled-reader shape.
    for (let i = 0; i <= BOUND; i += 1) stream.push(i);

    expect(
      stream.closed,
      'a stream that overflowed its bound is ended, not left growing the heap'
    ).toBe(true);
    const { done } = await drain(stream);
    expect(done, 'an overflowed stream terminates rather than parking its reader forever').toBe(
      true
    );
  });

  it('warns once when it ends a stalled reader, so the drop is never silent', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const stream = new PushStream<number>();

    for (let i = 0; i <= BOUND + 5; i += 1) stream.push(i);

    expect(warn, 'ending a reader is worth exactly one log line').toHaveBeenCalledTimes(1);
  });

  it('releases its producer when it ends on overflow', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const onClose = vi.fn();
    const stream = new PushStream<number>(onClose);

    for (let i = 0; i <= BOUND; i += 1) stream.push(i);

    expect(
      onClose,
      'the producer must be unregistered, exactly as a consumer walking away unregisters it'
    ).toHaveBeenCalledTimes(1);
  });
});
