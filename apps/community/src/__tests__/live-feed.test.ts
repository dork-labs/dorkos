import { afterEach, describe, expect, it } from 'vitest';
import { ChannelFeeds, type FeedReader } from '../live/feed.js';
import { LiveHub, LiveSignal } from '../live/hub.js';
import { CachedStreamAccess } from '../routes/community/event-stream-access.js';

const C = 'community';
const CH = 'channel';

/** A channel's committed entries, and a reader over them that a test can hold. */
function channel() {
  const committed: Array<{ seq: number; text: string }> = [];
  const reads: Array<{ after: number; upTo: number | null }> = [];
  let gate: Promise<void> | null = null;
  const read: FeedReader<string> = async (_c, _ch, after, upTo, limit) => {
    reads.push({ after, upTo });
    const rows = committed
      .filter((row) => row.seq > after && (upTo === null || row.seq <= upTo))
      .slice(0, limit)
      .map((row) => ({ seq: row.seq, value: row.text }));
    if (gate) await gate;
    return rows;
  };
  return {
    committed,
    reads,
    read,
    commit(text: string) {
      committed.push({ seq: committed.length + 1, text });
      return committed.length;
    },
    /** Hold every read until the returned function is called. */
    hold() {
      let release!: () => void;
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    },
  };
}

const made: Array<ChannelFeeds<string>> = [];
function feeds(read: FeedReader<string>) {
  let wakes = 0;
  const set = new ChannelFeeds<string>({
    read,
    wake: () => {
      wakes += 1;
    },
    hasStreams: () => true,
    fallbackMs: 300_000,
  });
  made.push(set);
  return { set, wakes: () => wakes };
}
afterEach(() => {
  for (const set of made.splice(0)) set.channelClosed(C, CH);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ChannelFeeds', () => {
  it('reads what notices announced once, however many arrive while it reads', async () => {
    const db = channel();
    const { set, wakes } = feeds(db.read);
    set.channelOpened(C, CH);
    const feed = set.feed(C, CH);
    feed.seed(0);
    await settle();
    db.reads.length = 0;
    const release = db.hold();
    set.entry(C, CH, db.commit('one'));
    set.entry(C, CH, db.commit('two'));
    set.entry(C, CH, db.commit('three'));
    release();
    await settle();
    await settle();
    // The first read was under way when two and three were announced: one more read takes both.
    expect(db.reads).toEqual([
      { after: 0, upTo: 1 },
      { after: 1, upTo: 3 },
    ]);
    expect(feed.after(0, 10).items.map((item) => item.value)).toEqual(['one', 'two', 'three']);
    expect(wakes()).toBeGreaterThan(0);
  });

  it('never reads past the last announced entry, except on its fallback re-read', async () => {
    // Purpose: fails if a feed reads an entry whose notice it has not handled: a revocation that
    // committed just before it might not have marked its streams yet.
    const db = channel();
    const { set } = feeds(db.read);
    set.channelOpened(C, CH);
    const feed = set.feed(C, CH);
    feed.seed(0);
    await settle();
    db.commit('announced');
    db.commit('not yet');
    set.entry(C, CH, 1);
    await settle();
    const found = feed.after(0, 10);
    expect(found.items.map((item) => item.value)).toEqual(['announced']);
    expect(found.noticedThrough).toBe(1);
  });

  it('reads once at its start what committed before it could hear a notice', async () => {
    const db = channel();
    db.commit('before the feed');
    const { set } = feeds(db.read);
    set.channelOpened(C, CH);
    const feed = set.feed(C, CH);
    feed.seed(0);
    await settle();
    const found = feed.after(0, 10);
    expect(found.items.map((item) => item.value)).toEqual(['before the feed']);
    // Found without a notice: a stream must check its access after this read before sending it.
    expect(found.noticedThrough).toBe(0);
  });

  it('throws away a read that a removal overtook, and reads the changed entry again', async () => {
    // Purpose: fails if a feed keeps text a removal replaced while its read was under way.
    const db = channel();
    const { set } = feeds(db.read);
    set.channelOpened(C, CH);
    const feed = set.feed(C, CH);
    feed.seed(0);
    await settle();
    const release = db.hold();
    set.entry(C, CH, db.commit('original'));
    await settle();
    db.committed[0].text = 'removed';
    set.content(C, CH);
    release();
    await settle();
    await settle();
    expect(feed.after(0, 10).items.map((item) => item.value)).toEqual(['removed']);
  });

  it('reads its kept entries again once on a removal, while streams wait', async () => {
    // Purpose: fails if a removal sends every stream that is behind to the database for itself
    // (20,000 reads for one removal), or lets any of them send the text it replaced.
    const db = channel();
    const { set } = feeds(db.read);
    set.channelOpened(C, CH);
    const feed = set.feed(C, CH);
    feed.seed(0);
    await settle();
    set.entry(C, CH, db.commit('one'));
    set.entry(C, CH, db.commit('two'));
    await settle();
    await settle();
    expect(feed.after(0, 10).items.map((item) => item.value)).toEqual(['one', 'two']);
    db.reads.length = 0;
    const release = db.hold();
    db.committed[0].text = 'removed';
    set.content(C);
    // Covered, so nobody reads for itself, but nothing to send until the fresh copies are in.
    expect(feed.after(0, 10)).toMatchObject({ covered: true, items: [] });
    release();
    await settle();
    await settle();
    expect(feed.after(0, 10).items.map((item) => item.value)).toEqual(['removed', 'two']);
    expect(db.reads).toEqual([{ after: 0, upTo: 2 }]);
  });

  it('starts over when the channel changes, until a stream seeds it again', async () => {
    const db = channel();
    const { set } = feeds(db.read);
    set.channelOpened(C, CH);
    const feed = set.feed(C, CH);
    feed.seed(0);
    await settle();
    set.entry(C, CH, db.commit('one'));
    await settle();
    set.channel(C, CH);
    expect(feed.after(1, 10).covered).toBe(false);
    feed.seed(1);
    set.entry(C, CH, db.commit('two'));
    await settle();
    expect(feed.after(1, 10).items.map((item) => item.value)).toEqual(['two']);
  });

  it('re-reads everything once after a reconnect, as found without a notice', async () => {
    const db = channel();
    const { set } = feeds(db.read);
    set.channelOpened(C, CH);
    const feed = set.feed(C, CH);
    feed.seed(0);
    await settle();
    db.commit('missed while down');
    set.reconnect();
    await settle();
    const found = feed.after(0, 10);
    expect(found.items.map((item) => item.value)).toEqual(['missed while down']);
    expect(found.noticedThrough).toBe(0);
  });

  it('keeps its place and tries again when a read fails, without waking every stream', async () => {
    // Purpose: fails if one failed read sends every stream on the channel to the database at
    // once, just when it is struggling.
    const db = channel();
    let failures = 1;
    const { set, wakes } = feeds(async (...args) => {
      if (failures-- > 0) throw new Error('database down');
      return db.read(...args);
    });
    set.channelOpened(C, CH);
    const feed = set.feed(C, CH);
    set.entry(C, CH, db.commit('after the failure'));
    feed.seed(0);
    await settle();
    expect(feed.after(0, 10)).toMatchObject({ covered: true, items: [] });
    const woken = wakes();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(feed.after(0, 10).items.map((item) => item.value)).toEqual(['after the failure']);
    expect(wakes()).toBe(woken + 1);
  });

  it('wakes a busy channel at most once per 100 ms, the first message at once', async () => {
    // Purpose: fails if every message wakes every stream for a write of its own: in a busy
    // channel that is one socket write per stream per message, most of a delivery's cost.
    const db = channel();
    const { set, wakes } = feeds(db.read);
    set.channelOpened(C, CH);
    const feed = set.feed(C, CH);
    feed.seed(0);
    await settle();
    const before = wakes();
    set.entry(C, CH, db.commit('first'));
    await settle();
    expect(wakes()).toBe(before + 1);
    set.entry(C, CH, db.commit('second'));
    set.entry(C, CH, db.commit('third'));
    await settle();
    await settle();
    expect(wakes()).toBe(before + 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(wakes()).toBe(before + 2);
    expect(feed.after(1, 10).items.map((item) => item.value)).toEqual(['second', 'third']);
  });

  it('closes with its channel', () => {
    const db = channel();
    const { set } = feeds(db.read);
    set.channelOpened(C, CH);
    expect(set.find(C, CH)).toBeDefined();
    set.channelClosed(C, CH);
    expect(set.find(C, CH)).toBeUndefined();
    expect(set.size).toBe(0);
  });
});

describe('CachedStreamAccess', () => {
  function cached(maxAgeMs = 60_000) {
    const access = new LiveSignal();
    let checks = 0;
    let answer: 'removed' | null = null;
    let expiresAt: number | undefined;
    const cache = new CachedStreamAccess({ access }, maxAgeMs, async () => {
      checks += 1;
      return { reason: answer, expiresAt };
    });
    return {
      access,
      cache,
      checks: () => checks,
      revoke() {
        answer = 'removed';
      },
      expireAt(at: number) {
        expiresAt = at;
      },
    };
  }

  it('trusts a passing check until something marks the stream', async () => {
    const { access, cache, checks } = cached();
    expect(cache.allows()).toBe(false);
    expect(await cache.check()).toBeNull();
    expect(cache.allows()).toBe(true);
    access.mark();
    expect(cache.allows()).toBe(false);
    expect(checks()).toBe(1);
  });

  it('does not trust a check that began before a mark', async () => {
    const { access, cache, revoke } = cached();
    const before = cache.check();
    access.mark();
    revoke();
    expect(await before).toBeNull();
    expect(cache.allows()).toBe(false);
    expect(await cache.check()).toBe('removed');
  });

  it('trusts a check no longer than its age limit', async () => {
    const { cache } = cached(1);
    await cache.check();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cache.allows()).toBe(false);
  });

  it('trusts nothing once the sign-in session runs out', async () => {
    // Purpose: fails if a session that simply expires keeps streaming for the whole trust
    // interval: it announces nothing, so only its own end time can stop the trust.
    const { cache, expireAt } = cached();
    expireAt(Date.now() + 5);
    await cache.check();
    expect(cache.allows()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cache.allows()).toBe(false);
  });

  it('needs a check that began after a read without a notice', async () => {
    const { cache, checks } = cached();
    await cache.check();
    const { nextTick } = await import('../live/feed.js');
    const readAt = nextTick();
    expect(cache.allows(readAt)).toBe(false);
    await cache.check(readAt);
    expect(cache.allows(readAt)).toBe(true);
    expect(checks()).toBe(2);
  });

  it('shares one check between the two loops that ask at once', async () => {
    const { cache, checks } = cached();
    await Promise.all([cache.check(), cache.check()]);
    expect(checks()).toBe(1);
  });
});

describe('LiveHub marking', () => {
  it('marks every named stream at once, though it wakes them in batches', async () => {
    // Purpose: fails if a stream past the first wake batch can send an entry on access a notice
    // already called into question, in the moment before its batch is woken.
    const hub = new LiveHub({
      listenUrl: 'postgres://nobody@127.0.0.1:1/none',
      maxStreams: 1_000,
      maxStreamsPerCommunity: 1_000,
      maxStreamsPerMember: 1_000,
      fallbackMs: 15_000,
      log: () => undefined,
    });
    try {
      const streams = await Promise.all(
        Array.from({ length: 500 }, (_, n) =>
          hub.open({ communityId: 'big', channelId: 'room', memberId: `m${n}` })
        )
      );
      const before = streams.map((stream) => stream.access.raises);
      hub.dispatch({ k: 'community', c: 'big' });
      expect(streams.filter((stream) => stream.access.raised)).toHaveLength(200);
      expect(streams.every((stream, n) => stream.access.raises > before[n])).toBe(true);
    } finally {
      await hub.stop();
    }
  });
});
