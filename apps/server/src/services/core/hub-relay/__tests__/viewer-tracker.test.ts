/**
 * @vitest-environment node
 *
 * The hub's viewer count per computer, and the two wakes it rides on: every
 * change is told to the computer's live connection, a connection that proves
 * itself hears the current count at once, and a computer is woken at most
 * once per debounce window, whatever the wake does.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '../../../../lib/logger.js';
import { HubViewerTracker } from '../viewer-tracker.js';
import { ComputerWaker, HUB_RELAY_WAKE_DEBOUNCE_MS } from '../computer-waker.js';
import type { HubComputerConnection } from '../computer-connection.js';
import {
  onConnectionPromoted,
  promoteConnection,
  forgetConnection,
} from '../hub-relay-registry.js';

describe('HubViewerTracker', () => {
  it('tells the live connection each change, and counts a release once', () => {
    const connection = { setViewers: vi.fn() };
    const tracker = new HubViewerTracker({ lookup: (id) => (id === 'c1' ? connection : null) });
    const first = tracker.open('c1');
    const second = tracker.open('c1');
    expect(connection.setViewers.mock.calls).toEqual([[1], [2]]);
    first();
    first();
    expect(tracker.count('c1')).toBe(1);
    second();
    expect(connection.setViewers.mock.calls).toEqual([[1], [2], [1], [0]]);
    expect(tracker.count('c1')).toBe(0);
  });

  it('counts while a computer is not connected, and tells it once it connects', () => {
    const tracker = new HubViewerTracker({ lookup: () => null });
    tracker.open('c1');
    tracker.open('c2');
    const setViewers = vi.fn();
    tracker.connected({ computerId: 'c1', setViewers });
    expect(setViewers).toHaveBeenCalledWith(1);
  });

  it('is told by the registry when a connection becomes live', () => {
    const heard = vi.fn();
    const stop = onConnectionPromoted(heard);
    const connection = {
      computerId: 'c-promoted',
      connected: true,
      close: vi.fn(),
    } as unknown as HubComputerConnection;
    promoteConnection(connection);
    expect(heard).toHaveBeenCalledWith(connection);
    stop();
    forgetConnection(connection);
  });

  it('keeps promoting when a listener throws', () => {
    const stop = onConnectionPromoted(() => {
      throw new TypeError('boom');
    });
    const connection = {
      computerId: 'c-throws',
      connected: true,
      close: vi.fn(),
    } as unknown as HubComputerConnection;
    expect(() => promoteConnection(connection)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { error: 'TypeError' });
    stop();
    forgetConnection(connection);
  });
});

describe('ComputerWaker', () => {
  it('wakes nothing until a wake is set, and never throws', () => {
    const waker = new ComputerWaker({ wake: () => null });
    expect(waker.wake('c1')).toBe(false);
  });

  it('wakes each computer at most once per debounce window', () => {
    let now = 1_000;
    const wake = vi.fn(async () => undefined);
    const waker = new ComputerWaker({ wake: () => wake, now: () => now });
    expect(waker.wake('c1')).toBe(true);
    expect(waker.wake('c1')).toBe(false);
    expect(waker.wake('c2')).toBe(true);
    now += HUB_RELAY_WAKE_DEBOUNCE_MS - 1;
    expect(waker.wake('c1')).toBe(false);
    now += 1;
    expect(waker.wake('c1')).toBe(true);
    expect(wake.mock.calls).toEqual([['c1'], ['c2'], ['c1']]);
  });

  it('swallows a failed wake and logs only its name', async () => {
    const secret = 'token-abc';
    const waker = new ComputerWaker({
      wake: () => async () => {
        throw new RangeError(`refused ${secret}`);
      },
    });
    expect(waker.wake('c1')).toBe(true);
    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { error: 'RangeError' })
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(secret);
  });

  it('swallows a wake that throws before it returns a promise', () => {
    const waker = new ComputerWaker({
      wake: () => () => {
        throw new SyntaxError('sync');
      },
    });
    expect(() => waker.wake('c1')).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { error: 'SyntaxError' });
  });
});
