import { describe, it, expect, vi } from 'vitest';
import { OriginalDocPresenceLedger, createOriginalDocPresenceLedger } from '../presence.js';
import {
  PageEventSchema,
  CanvasChannelDownstreamEventTypeSchema,
} from '@dorkos/shared/canvas-channel-schemas';
import { randomUUID } from 'node:crypto';
describe('original per-mount presence ledger', () => {
  it('retains original private recognition when exported prototype methods are replaced', () => {
    const scope = createOriginalDocPresenceLedger();
    const publicPrepare = vi
      .spyOn(OriginalDocPresenceLedger.prototype, 'prepare')
      .mockImplementation(() => {
        throw undefined;
      });
    const publicFocus = vi
      .spyOn(OriginalDocPresenceLedger.prototype, 'requireFocus')
      .mockImplementation(() => {});
    const publicExpiry = vi
      .spyOn(OriginalDocPresenceLedger.prototype, 'requireExpiry')
      .mockImplementation(() => {});
    try {
      const actual = scope.prepare('doc', 'caller', { action: 'mount' }, 0);
      scope.commit(actual);
      const genuine = scope.prepare(
        'doc',
        'caller',
        { action: 'focus', viewerId: actual.viewerId, focused: true },
        1
      );
      scope.requireFocus(genuine, 'caller', 1);
      expect(() => scope.requireFocus(genuine, 'foreign', 1)).toThrow();
      expect(() => scope.requireExpiry(genuine)).toThrow();
      expect(() => scope.requireFocus({ ...genuine }, 'caller', 1)).toThrow();
      expect(publicPrepare).not.toHaveBeenCalled();
      expect(publicFocus).not.toHaveBeenCalled();
      expect(publicExpiry).not.toHaveBeenCalled();
    } finally {
      publicPrepare.mockRestore();
      publicFocus.mockRestore();
      publicExpiry.mockRestore();
      scope.stop();
    }
  });

  it('counts two mounts by one caller, keeps duplicate beats quiet and binds IDs to their document/caller', () => {
    const owner = new OriginalDocPresenceLedger();
    const first = owner.prepare('doc', 'caller', { action: 'mount' }, 0);
    owner.commit(first);
    const second = owner.prepare('doc', 'caller', { action: 'mount' }, 1);
    owner.commit(second);
    expect(first.views).toBe(1);
    expect(second.views).toBe(2);
    expect(second.viewerId).not.toBe(first.viewerId);
    for (let n = 0; n < 2; n++) {
      const beat = owner.prepare(
        'doc',
        'caller',
        { action: 'heartbeat', viewerId: first.viewerId },
        30_000
      );
      expect(beat).toMatchObject({ views: 2, countChanged: false, opened: false, closed: 0 });
      owner.commit(beat);
    }
    expect(() =>
      owner.prepare('other', 'caller', { action: 'heartbeat', viewerId: first.viewerId }, 30_000)
    ).toThrow();
    expect(() =>
      owner.prepare('doc', 'other', { action: 'unmount', viewerId: first.viewerId }, 30_000)
    ).toThrow();
    const leave = owner.prepare(
      'doc',
      'caller',
      { action: 'unmount', viewerId: second.viewerId },
      30_001
    );
    owner.commit(leave);
    expect(leave).toMatchObject({ views: 1, countChanged: true, closed: 1 });
    expect(() =>
      owner.prepare('doc', 'caller', { action: 'unmount', viewerId: second.viewerId }, 30_002)
    ).toThrow();
  });
  it('replays only the same caller-bound logical mount without a second view or TTL renewal', () => {
    const owner = new OriginalDocPresenceLedger();
    const mountId = randomUUID();
    const request = { action: 'mount' as const, mountId };
    const first = owner.prepare('doc', 'caller', request, 0);
    owner.commit(first);
    const retry = owner.prepare('doc', 'caller', request, 30_000);
    owner.commit(retry);
    expect(retry).toMatchObject({
      viewerId: first.viewerId,
      views: 1,
      opened: false,
      closed: 0,
      countChanged: false,
    });
    expect(owner.next()).toEqual({ documentId: 'doc', at: 75_000 });
    const foreign = owner.prepare('doc', 'other', request, 30_000);
    owner.commit(foreign);
    expect(foreign.viewerId).not.toBe(first.viewerId);
    expect(foreign.views).toBe(2);
    const expired = owner.prepare('doc', 'caller', request, 75_000);
    owner.commit(expired);
    expect(expired.viewerId).not.toBe(first.viewerId);
  });

  it('expires at exactly75seconds once, with no fabricated zero while a mount is alive', () => {
    const owner = new OriginalDocPresenceLedger();
    const plan = owner.prepare('doc', 'caller', { action: 'mount' }, 100);
    owner.commit(plan);
    expect(owner.expire('doc', 75_099)).toBeUndefined();
    expect(owner.next()).toEqual({ documentId: 'doc', at: 75_100 });
    const expiry = owner.expire('doc', 75_100);
    if (!expiry) throw new Error('Original due expiry missing');
    expect(expiry).toMatchObject({ views: 0, closed: 1, countChanged: true });
    owner.commit(expiry);
    expect(owner.expire('doc', 75_100)).toBeUndefined();
    expect(owner.next()).toBeUndefined();
    expect(() =>
      owner.prepare('doc', 'caller', { action: 'heartbeat', viewerId: plan.viewerId }, 75_100)
    ).toThrow();
  });
  it('does not publish uncommitted plans, rejects replaced plans and starts empty after restart', () => {
    const owner = new OriginalDocPresenceLedger();
    const failedSql = owner.prepare('doc', 'caller', { action: 'mount' }, 0);
    expect(owner.next()).toBeUndefined();
    const success = owner.prepare('doc', 'caller', { action: 'mount' }, 1);
    owner.commit(success);
    expect(success.views).toBe(1);
    expect(() => owner.commit(failedSql)).toThrow();
    const restarted = new OriginalDocPresenceLedger();
    expect(restarted.next()).toBeUndefined();
    expect(() =>
      restarted.prepare('doc', 'caller', { action: 'heartbeat', viewerId: success.viewerId }, 2)
    ).toThrow();
    const fresh = restarted.prepare('doc', 'caller', { action: 'mount' }, 2);
    restarted.commit(fresh);
    expect(fresh.views).toBe(1);
    owner.stop();
    expect(() => owner.commit(success)).toThrow();
    expect(() => owner.prepare('doc', 'caller', { action: 'mount' }, 3)).toThrow();
  });
  it('debounces actual mount focus flips without renewing the heartbeat or changing viewer counts', () => {
    const owner = new OriginalDocPresenceLedger();
    const mount = owner.prepare('doc', 'caller', { action: 'mount' }, 0);
    owner.commit(mount);
    const focus = (focused: boolean, now: number) =>
      owner.prepare('doc', 'caller', { action: 'focus', viewerId: mount.viewerId, focused }, now);
    const entered = focus(true, 100);
    expect(entered.focused).toBe(true);
    owner.commit(entered);
    for (const [focused, at] of [
      [false, 110],
      [true, 120],
      [false, 599],
    ] as const) {
      const burst = focus(focused, at);
      expect(burst.focused).toBeUndefined();
      expect(burst.countChanged).toBe(false);
      owner.commit(burst);
    }
    const left = focus(false, 600);
    expect(left.focused).toBe(false);
    owner.commit(left);
    expect(owner.next()).toEqual({ documentId: 'doc', at: 75000 });
    expect(() => focus(true, 75000)).toThrow();
  });

  it('keeps native host and viewer types unavailable to public page and agent emitters', () => {
    for (const type of ['host.opened', 'host.closed', 'host.focus', 'doc.viewers']) {
      expect(PageEventSchema.safeParse({ v: 1, id: randomUUID(), type, payload: {} }).success).toBe(
        false
      );
      expect(CanvasChannelDownstreamEventTypeSchema.safeParse(type).success).toBe(false);
    }
  });

  it('recognizes actual committed last unmount before a previously due timer examines the ledger', () => {
    const owner = new OriginalDocPresenceLedger();
    const mount = owner.prepare('doc', 'caller', { action: 'mount' }, 0);
    owner.commit(mount);
    const scheduled = owner.next();
    expect(scheduled).toEqual({ documentId: 'doc', at: 75_000 });
    const leave = owner.prepare(
      'doc',
      'caller',
      { action: 'unmount', viewerId: mount.viewerId },
      1
    );
    expect(owner.hasDocument('doc')).toBe(true);
    owner.commit(leave);
    expect(owner.hasDocument('doc')).toBe(false);
    expect(owner.expire('doc', 75_000)).toBeUndefined();
  });

  it('retains caller-retirement counts until the surviving original publisher commits', () => {
    const owner = new OriginalDocPresenceLedger();
    const a = owner.prepare('doc', 'a', { action: 'mount' }, 0);
    owner.commit(a);
    const b = owner.prepare('doc', 'b', { action: 'mount' }, 1);
    owner.commit(b);
    const retired = new Set(['a']);
    const failedSql = owner.expire('doc', 2, retired);
    expect(failedSql).toMatchObject({ views: 1, closed: 1, countChanged: true });
    expect(owner.hasCaller('doc', 'a')).toBe(true);
    const retry = owner.expire('doc', 2, retired);
    if (!retry) throw new Error('Original caller-retirement plan missing');
    owner.commit(retry);
    expect(() => failedSql && owner.commit(failedSql)).toThrow();
    expect(owner.hasCaller('doc', 'a')).toBe(false);
    expect(owner.hasCaller('doc', 'b')).toBe(true);
    expect(owner.expire('doc', 2, retired)).toBeUndefined();
  });

  it('retires only the positively identified caller, preserving a different live mount', () => {
    const owner = new OriginalDocPresenceLedger();
    const a = owner.prepare('doc', 'a', { action: 'mount' }, 0);
    owner.commit(a);
    const b = owner.prepare('doc', 'b', { action: 'mount' }, 1);
    owner.commit(b);
    owner.retire('doc', 'a');
    expect(() =>
      owner.prepare('doc', 'a', { action: 'heartbeat', viewerId: a.viewerId }, 2)
    ).toThrow();
    const beat = owner.prepare('doc', 'b', { action: 'heartbeat', viewerId: b.viewerId }, 2);
    expect(beat.views).toBe(1);
    owner.commit(beat);
    owner.retire('other');
    expect(owner.hasCaller('doc', 'b')).toBe(true);
    owner.retire('doc');
    expect(owner.next()).toBeUndefined();
  });
});
