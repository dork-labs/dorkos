import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserViewerRegistry } from '../viewer-registry.js';
import type { ViewerPage, ViewerFrame, ViewerPrincipal } from '../viewer-contract.js';
import {
  endSession,
  resetLiveConnectionsForTests,
} from '../../../core/auth/sessions/live-connections.js';

const person: ViewerPrincipal = {
  ownerId: 'owner',
  sessionId: 'owner-session',
  clientId: 'app-window',
};

function fixture() {
  const lifetime = new AbortController();
  let current = true;
  let publish: ((frame: ViewerFrame) => void) | undefined;
  const stop = vi.fn(async () => undefined);
  const page: ViewerPage = {
    binding: {
      sessionId: 'chat-a',
      profileId: 'profile-a',
      connectionId: 'connection-a',
      profileConnectionGeneration: 'connection-generation',
      leaseId: 'tab-a',
      tabId: 'tab-a',
    },
    close: vi.fn(async () => undefined),
    signal: lifetime.signal,
    assertLive: () => {
      if (!current) throw Error('changed');
    },
    identity: {
      chatId: 'chat-a',
      profileId: 'profile-a',
      connectionId: 'connection-a',
      tabId: 'tab-a',
    },
    assertCurrent: vi.fn(async () => {
      if (!current) throw Error('changed');
    }),
    start: vi.fn(async (receive) => {
      publish = receive;
      return stop;
    }),
  };
  const resolve = vi.fn(async () => page);
  const registry = new BrowserViewerRegistry(resolve);
  const frame = (
    sequence: number,
    bytes: Buffer = Buffer.from(`made-up-image-${sequence}`)
  ): ViewerFrame => ({
    sequence,
    generation: 1,
    width: 640,
    height: 480,
    bytes,
  });
  return {
    registry,
    resolve,
    page,
    stop,
    publish: (sequence: number, bytes?: Buffer) => publish?.(frame(sequence, bytes)),
    revoke: () => {
      current = false;
    },
    expire: () => lifetime.abort(),
  };
}

beforeEach(() => {
  resetLiveConnectionsForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  resetLiveConnectionsForTests();
});

describe('person browser viewer custody', () => {
  it.each(['expire', 'revoke'] as const)(
    'fences a prepared frame after %s during awaited admission',
    async (end) => {
      const f = fixture();
      const a = await f.registry.subscribe(person, 'chat-a');
      f.publish(1);
      expect(await f.registry.frame(person, a.viewerId, a.nonce)).not.toBeNull();
      f[end]();
      expect(() => f.registry.assertLive(person, a.viewerId, a.nonce)).toThrow('viewer_denied');
      await f.registry.close();
    }
  );

  it('revokes only the ended owner session through the real sign-out lifecycle', async () => {
    const f = fixture();
    const a = await f.registry.subscribe(person, 'chat-a');
    const other = { ...person, sessionId: 'second-owner-session' };
    const b = await f.registry.subscribe(other, 'chat-a');
    expect(() => f.registry.assertLive(person, a.viewerId, a.nonce)).not.toThrow();
    endSession(person.sessionId);
    expect(() => f.registry.assertLive(person, a.viewerId, a.nonce)).toThrow('viewer_denied');
    f.publish(1);
    expect((await f.registry.frame(other, b.viewerId, b.nonce))?.sequence).toBe(1);
    await f.registry.close();
  });

  it('bounds each viewer to a two MiB burst and 512 KiB per second refill', async () => {
    const f = fixture();
    try {
      const a = await f.registry.subscribe(person, 'chat-a');
      f.publish(1, Buffer.alloc(2 * 1024 * 1024));
      const first = await f.registry.frame(person, a.viewerId, a.nonce);
      expect(first?.sequence).toBe(1);
      f.publish(2, Buffer.alloc(1));
      expect(await f.registry.frame(person, a.viewerId, a.nonce, first!.receipt)).toBeNull();
      await vi.advanceTimersByTimeAsync(1_000);
      f.publish(3, Buffer.alloc(512 * 1024));
      expect((await f.registry.frame(person, a.viewerId, a.nonce))?.sequence).toBe(3);
    } finally {
      await f.registry.close();
    }
  });

  it('charges fan-out bytes against the four MiB install budget', async () => {
    const f = fixture();
    try {
      const viewers = await Promise.all(
        Array.from({ length: 3 }, () => f.registry.subscribe(person, 'chat-a'))
      );
      f.publish(1, Buffer.alloc(2 * 1024 * 1024));
      for (const viewer of viewers.slice(0, 2))
        expect(await f.registry.frame(person, viewer.viewerId, viewer.nonce)).not.toBeNull();
      const third = viewers[2]!;
      expect(await f.registry.frame(person, third.viewerId, third.nonce)).toBeNull();
    } finally {
      await f.registry.close();
    }
  });

  it('revokes every viewer and wakes a pending poll immediately when its binding ends', async () => {
    const f = fixture();
    const a = await f.registry.subscribe(person, 'chat-a');
    const b = await f.registry.subscribe(person, 'chat-a');
    const waiting = f.registry.frame(person, a.viewerId, a.nonce);
    const result = expect(waiting).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    f.expire();
    await result;
    expect(() => f.registry.assertLive(person, b.viewerId, b.nonce)).toThrow('viewer_denied');
    expect(f.stop).toHaveBeenCalledTimes(1);
    await f.registry.close();
  });

  it('shares one page producer and keeps only the latest pending frame per viewer', async () => {
    const f = fixture();
    try {
      const a = await f.registry.subscribe(person, 'chat-a');
      const b = await f.registry.subscribe(person, 'chat-a');
      expect(f.page.start).toHaveBeenCalledTimes(1);
      f.publish(1);
      const first = await f.registry.frame(person, a.viewerId, a.nonce);
      expect(first?.sequence).toBe(1);
      f.publish(2);
      f.publish(3);
      await expect(f.registry.frame(person, a.viewerId, a.nonce)).rejects.toThrow();
      expect((await f.registry.frame(person, a.viewerId, a.nonce, first!.receipt))?.sequence).toBe(
        3
      );
      expect((await f.registry.frame(person, b.viewerId, b.nonce))?.sequence).toBe(3);
    } finally {
      await f.registry.close();
    }
  });

  it.each([
    { ...person, ownerId: 'other-owner' },
    { ...person, sessionId: 'other-session' },
    { ...person, clientId: 'other-window' },
  ])('refuses a subscription from a different app principal', async (stranger) => {
    const f = fixture();
    try {
      const a = await f.registry.subscribe(person, 'chat-a');
      f.publish(1);
      await expect(f.registry.frame(stranger, a.viewerId, a.nonce)).rejects.toThrow();
      expect((await f.registry.frame(person, a.viewerId, a.nonce))?.sequence).toBe(1);
    } finally {
      await f.registry.close();
    }
  });

  it('refuses wrong nonces and replayed paint receipts', async () => {
    const f = fixture();
    try {
      const a = await f.registry.subscribe(person, 'chat-a');
      f.publish(1);
      await expect(f.registry.frame(person, a.viewerId, 'wrong')).rejects.toThrow();
      const first = await f.registry.frame(person, a.viewerId, a.nonce);
      f.publish(2);
      await f.registry.frame(person, a.viewerId, a.nonce, first!.receipt);
      await expect(f.registry.frame(person, a.viewerId, a.nonce, first!.receipt)).rejects.toThrow();
    } finally {
      await f.registry.close();
    }
  });

  it('rechecks the bound page before delivering content', async () => {
    const f = fixture();
    try {
      const a = await f.registry.subscribe(person, 'chat-a');
      f.publish(1);
      f.revoke();
      await expect(f.registry.frame(person, a.viewerId, a.nonce)).rejects.toThrow();
      expect(f.stop).toHaveBeenCalledTimes(1);
    } finally {
      await f.registry.close();
    }
  });

  it('drops late frames after a revoked in-flight poll', async () => {
    const f = fixture();
    try {
      const a = await f.registry.subscribe(person, 'chat-a');
      const waiting = f.registry.frame(person, a.viewerId, a.nonce);
      await vi.advanceTimersByTimeAsync(1);
      f.revoke();
      f.publish(1);
      await expect(waiting).rejects.toThrow();
      expect(f.stop).toHaveBeenCalledTimes(1);
    } finally {
      await f.registry.close();
    }
  });

  it('stops the producer within five seconds without live viewers', async () => {
    const f = fixture();
    await f.registry.subscribe(person, 'chat-a');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.stop).toHaveBeenCalledTimes(1);
    await f.registry.close();
  });

  it('closing a viewer does not close its page or another viewer', async () => {
    const f = fixture();
    try {
      const a = await f.registry.subscribe(person, 'chat-a');
      const b = await f.registry.subscribe(person, 'chat-a');
      await f.registry.unsubscribe(person, a.viewerId, a.nonce);
      expect(f.stop).not.toHaveBeenCalled();
      f.publish(1);
      expect((await f.registry.frame(person, b.viewerId, b.nonce))?.sequence).toBe(1);
      await f.registry.unsubscribe(person, b.viewerId, b.nonce);
      expect(f.stop).toHaveBeenCalledTimes(1);
    } finally {
      await f.registry.close();
    }
  });

  it('bounds subscriptions per page and rejects new viewers after shutdown', async () => {
    const f = fixture();
    await f.registry.subscribe(person, 'chat-a');
    await f.registry.subscribe(person, 'chat-a');
    await f.registry.subscribe(person, 'chat-a');
    await expect(f.registry.subscribe(person, 'chat-a')).rejects.toThrow();
    expect(f.page.start).toHaveBeenCalledTimes(1);
    await f.registry.close();
    await expect(f.registry.subscribe(person, 'chat-a')).rejects.toThrow();
  });

  it('does not accept a resolver returning another chat’s page', async () => {
    const f = fixture();
    await expect(f.registry.subscribe(person, 'chat-b')).rejects.toThrow();
    expect(f.page.start).not.toHaveBeenCalled();
    await f.registry.close();
  });

  it('cancels a waiting poll when the viewer closes', async () => {
    const f = fixture();
    const a = await f.registry.subscribe(person, 'chat-a');
    const waiting = f.registry.frame(person, a.viewerId, a.nonce);
    const result = expect(waiting).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    await f.registry.unsubscribe(person, a.viewerId, a.nonce);
    await result;
    await f.registry.close();
  });

  it('returns liveness without inventing a frame on a static page', async () => {
    const f = fixture();
    const a = await f.registry.subscribe(person, 'chat-a');
    const waiting = f.registry.frame(person, a.viewerId, a.nonce);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await waiting).toBeNull();
    f.publish(1);
    expect((await f.registry.frame(person, a.viewerId, a.nonce))?.sequence).toBe(1);
    await f.registry.close();
  });
});
