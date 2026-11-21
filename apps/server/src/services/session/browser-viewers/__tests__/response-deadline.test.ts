import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boundViewerResponse } from '../response-deadline.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  const outgoing = Object.assign(new EventEmitter(), { destroy: vi.fn() });
  boundViewerResponse(outgoing as unknown as ServerResponse);
  return outgoing;
}

describe('viewer socket write lifetime', () => {
  it('closes a stalled frame response after five seconds', async () => {
    const outgoing = fixture();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(outgoing.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(outgoing.destroy).toHaveBeenCalledTimes(1);
    expect(outgoing.listenerCount('finish')).toBe(0);
    expect(outgoing.listenerCount('close')).toBe(0);
  });

  it.each(['finish', 'close'])('releases its timer and listeners on %s', async (event) => {
    const outgoing = fixture();
    outgoing.emit(event);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(outgoing.destroy).not.toHaveBeenCalled();
    expect(outgoing.listenerCount('finish')).toBe(0);
    expect(outgoing.listenerCount('close')).toBe(0);
  });
});
