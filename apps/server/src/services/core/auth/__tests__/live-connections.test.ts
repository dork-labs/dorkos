/**
 * The registry of what each sign-in holds open (F4 part 2, DOR-2969).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SESSION_COOKIE_CACHE_SECONDS } from '../index.js';
import {
  closeForSession,
  endSession,
  ENDED_SESSION_MEMORY_MS,
  inRestartWindow,
  MAX_LIVE_PER_SESSION,
  noteSessionEnded,
  registerLiveConnection,
  resetLiveConnectionsForTests,
  sessionRecentlyEnded,
  sweepLiveConnections,
} from '../sessions/live-connections.js';

afterEach(() => resetLiveConnectionsForTests());

describe('live connections', () => {
  it('closes everything one session holds, and nothing of another', () => {
    const a1 = vi.fn();
    const a2 = vi.fn();
    const b = vi.fn();
    registerLiveConnection('s-a', 'u', a1);
    registerLiveConnection('s-a', 'u', a2);
    registerLiveConnection('s-b', 'u', b);
    expect(closeForSession('s-a')).toBe(2);
    expect(a1).toHaveBeenCalledOnce();
    expect(a2).toHaveBeenCalledOnce();
    expect(b).not.toHaveBeenCalled();
    // Closed once: a second close finds nothing.
    expect(closeForSession('s-a')).toBe(0);
    expect(a1).toHaveBeenCalledOnce();
  });

  it('forgets what ended by itself', () => {
    const close = vi.fn();
    const unregister = registerLiveConnection('s', 'u', close);
    unregister();
    unregister();
    expect(closeForSession('s')).toBe(0);
    expect(close).not.toHaveBeenCalled();
  });

  it('never throws out of a close, and still closes the rest', () => {
    const after = vi.fn();
    registerLiveConnection('s', 'u', () => {
      throw new Error('boom');
    });
    registerLiveConnection('s', 'u', after);
    expect(() => closeForSession('s')).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
  });

  it('closes the oldest past the per-session bound', () => {
    const oldest = vi.fn();
    registerLiveConnection('s', 'u', oldest);
    for (let i = 1; i < MAX_LIVE_PER_SESSION; i++) registerLiveConnection('s', 'u', () => {});
    expect(oldest).not.toHaveBeenCalled();
    registerLiveConnection('s', 'u', () => {});
    expect(oldest).toHaveBeenCalledOnce();
    expect(closeForSession('s')).toBe(MAX_LIVE_PER_SESSION);
  });

  it('never closes a terminal for room: the oldest stream goes', () => {
    const terminal = vi.fn();
    const oldestStream = vi.fn();
    registerLiveConnection('s', 'u', terminal, 'terminal');
    registerLiveConnection('s', 'u', oldestStream);
    for (let i = 2; i < MAX_LIVE_PER_SESSION; i++) registerLiveConnection('s', 'u', () => {});
    registerLiveConnection('s', 'u', () => {});
    expect(terminal).not.toHaveBeenCalled();
    expect(oldestStream).toHaveBeenCalledOnce();
  });

  it('with only terminals held, closes the new stream, and lets terminals past the bound', () => {
    const terminals = Array.from({ length: MAX_LIVE_PER_SESSION }, () => vi.fn());
    for (const close of terminals) registerLiveConnection('s', 'u', close, 'terminal');
    const stream = vi.fn();
    registerLiveConnection('s', 'u', stream);
    expect(stream).toHaveBeenCalledOnce();
    const extra = vi.fn();
    registerLiveConnection('s', 'u', extra, 'terminal');
    for (const close of [...terminals, extra]) expect(close).not.toHaveBeenCalled();
    expect(closeForSession('s')).toBe(MAX_LIVE_PER_SESSION + 1);
  });

  it('distrusts cached sign-ins until the cookie cache could have expired since start', () => {
    expect(inRestartWindow(1_000, 1_000)).toBe(true);
    expect(inRestartWindow(1_000 + ENDED_SESSION_MEMORY_MS - 1, 1_000)).toBe(true);
    expect(inRestartWindow(1_000 + ENDED_SESSION_MEMORY_MS, 1_000)).toBe(false);
  });

  it('remembers an ended session for as long as a cached cookie could vouch for it', () => {
    expect(ENDED_SESSION_MEMORY_MS).toBe(SESSION_COOKIE_CACHE_SECONDS * 1000);
    noteSessionEnded('s', 1_000);
    expect(sessionRecentlyEnded('s', 1_000 + ENDED_SESSION_MEMORY_MS - 1)).toBe(true);
    expect(sessionRecentlyEnded('s', 1_000 + ENDED_SESSION_MEMORY_MS)).toBe(false);
    expect(sessionRecentlyEnded('other', 1_000)).toBe(false);
  });

  it('ends a session: closes it and remembers it', () => {
    const close = vi.fn();
    registerLiveConnection('s', 'u', close);
    endSession('s');
    expect(close).toHaveBeenCalledOnce();
    expect(sessionRecentlyEnded('s')).toBe(true);
  });

  it('sweeps sessions the store no longer has, and only those', async () => {
    const gone = vi.fn();
    const kept = vi.fn();
    registerLiveConnection('gone', 'u', gone);
    registerLiveConnection('kept', 'u', kept);
    const liveIds = vi.fn(async () => new Set(['kept']));
    expect(await sweepLiveConnections(liveIds)).toBe(1);
    expect(liveIds).toHaveBeenCalledWith(['gone', 'kept']);
    expect(gone).toHaveBeenCalledOnce();
    expect(kept).not.toHaveBeenCalled();
    expect(sessionRecentlyEnded('gone')).toBe(true);
  });

  it('closes nothing when the store cannot answer, or nothing is open', async () => {
    const close = vi.fn();
    const liveIds = vi.fn(async () => new Set<string>());
    expect(await sweepLiveConnections(liveIds)).toBe(0);
    expect(liveIds).not.toHaveBeenCalled();
    registerLiveConnection('s', 'u', close);
    expect(
      await sweepLiveConnections(async () => {
        throw new Error('database locked');
      })
    ).toBe(0);
    expect(close).not.toHaveBeenCalled();
  });
});
