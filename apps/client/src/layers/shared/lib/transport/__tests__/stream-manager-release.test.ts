import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { StreamManager, type DurableStreamConnection } from '../stream-manager';
import type { StreamConnectionOptions } from '../ws-connection';

/**
 * Releasing the active session stream.
 *
 * Two things are being pinned, and they pull against each other. The stream has
 * to be let go when the chat view goes away — it was leaking, held open for the
 * life of the tab by a hook with no cleanup and a `detachSession` nothing
 * called. But it must NOT be let go when React merely unmounts and re-mounts the
 * same view, which StrictMode and HMR both do, because that emits the
 * A→null→A transition the manager avoids everywhere else.
 */

/** A fake connection that records whether it was destroyed. */
class FakeConnection implements DurableStreamConnection {
  destroyed = false;
  connected = false;

  constructor(
    readonly url: string,
    readonly opts: StreamConnectionOptions
  ) {}

  connect(): void {
    this.connected = true;
  }
  disconnect(): void {}
  destroy(): void {
    this.destroyed = true;
  }
  enableVisibilityOptimization(): void {}
}

const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let created: FakeConnection[];
let manager: StreamManager;

beforeEach(() => {
  vi.useFakeTimers();
  created = [];
  manager = new StreamManager({
    createConnection: (url, opts) => {
      const conn = new FakeConnection(url, opts);
      created.push(conn);
      return conn;
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StreamManager.releaseSession', () => {
  it('detaches the session once the deferred release runs', () => {
    manager.attachSession(SESSION_A, '/work');
    expect(manager.getAttachedSessionId()).toBe(SESSION_A);

    manager.releaseSession();
    vi.runAllTimers();

    expect(manager.getAttachedSessionId()).toBeNull();
    expect(created[0]!.destroyed, 'the leaked connection is closed').toBe(true);
  });

  it('does NOT detach when the same session re-attaches first (StrictMode/HMR)', () => {
    manager.attachSession(SESSION_A, '/work');
    const first = created[0]!;

    // The unmount-then-remount React performs in StrictMode, in order.
    manager.releaseSession();
    manager.attachSession(SESSION_A, '/work');
    vi.runAllTimers();

    expect(manager.getAttachedSessionId()).toBe(SESSION_A);
    expect(first.destroyed, 'the healthy connection is kept, not rebuilt').toBe(false);
    expect(created, 'no second connection was opened').toHaveLength(1);
  });

  it('emits a single A→null transition, never A→null→A, across a remount', () => {
    // The observable form of the rule: what a subscriber SEES is the thing that
    // matters, and a flicker is what this defends against.
    const seen: (string | null)[] = [];
    manager.subscribeAttachedSessionChange((next) => seen.push(next));

    manager.attachSession(SESSION_A, '/work');
    manager.releaseSession();
    manager.attachSession(SESSION_A, '/work');
    vi.runAllTimers();

    expect(seen).toEqual([SESSION_A]);
  });

  it('still detaches when the remount targets a DIFFERENT session', () => {
    manager.attachSession(SESSION_A, '/work');
    manager.releaseSession();
    manager.attachSession(SESSION_B, '/work');
    vi.runAllTimers();

    expect(manager.getAttachedSessionId()).toBe(SESSION_B);
  });

  it('is idempotent — a second release before the tick schedules nothing new', () => {
    manager.attachSession(SESSION_A, '/work');

    manager.releaseSession();
    manager.releaseSession();
    manager.attachSession(SESSION_A, '/work');
    vi.runAllTimers();

    expect(manager.getAttachedSessionId(), 'one cancel clears one release').toBe(SESSION_A);
  });
});

describe('StreamManager.detachSession with a pinned session', () => {
  it('hands a shared connection to the pin instead of destroying it', () => {
    // The PIP is still on screen. Leaving chat must not kill it — the pinned
    // slot and the active slot SHARE one connection while the two coincide.
    manager.attachSession(SESSION_A, '/work');
    manager.pinSession(SESSION_A);
    const shared = created[0]!;

    manager.detachSession();

    expect(manager.getAttachedSessionId()).toBeNull();
    expect(manager.getPinnedSessionId(), 'the pin survives').toBe(SESSION_A);
    expect(shared.destroyed, 'the PIP keeps streaming on the same connection').toBe(false);
  });

  it('destroys the connection when nothing is pinned', () => {
    manager.attachSession(SESSION_A, '/work');

    manager.detachSession();

    expect(created[0]!.destroyed).toBe(true);
  });

  it('leaves an off-route pin alone', () => {
    manager.attachSession(SESSION_A, '/work');
    manager.pinSession(SESSION_B, '/other');
    const active = created[0]!;
    const pinned = created[1]!;

    manager.detachSession();

    expect(active.destroyed).toBe(true);
    expect(pinned.destroyed, 'the off-route pin owns its own connection').toBe(false);
    expect(manager.getPinnedSessionId()).toBe(SESSION_B);
  });
});
