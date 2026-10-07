import { afterEach, describe, expect, it } from 'vitest';
import { LiveHub, LiveSignal, LiveStreamLimit, type LiveStream } from '../live/hub.js';
import { parseLiveNotice } from '../live/notices.js';
import { renderMetrics } from '../live/monitoring.js';

// Nothing listens here: these tests drive the hub's routing directly, as the listener would.
const UNREACHABLE = 'postgres://nobody@127.0.0.1:1/none';

const hubs: LiveHub[] = [];
function hub(limits: { maxStreams?: number; maxStreamsPerCommunity?: number } = {}) {
  const made = new LiveHub({
    listenUrl: UNREACHABLE,
    maxStreams: limits.maxStreams ?? 100,
    maxStreamsPerCommunity: limits.maxStreamsPerCommunity ?? 100,
    fallbackMs: 15_000,
    log: () => undefined,
  });
  hubs.push(made);
  return made;
}
afterEach(async () => {
  await Promise.all(hubs.splice(0).map((made) => made.stop()));
});

/** Whether a signal is raised now, without waiting. */
async function raised(signal: LiveSignal) {
  return signal.wait(0);
}

describe('LiveSignal', () => {
  it('keeps a raise that came while nobody waited, then clears it', async () => {
    // Purpose: fails if a notice that lands during a stream's read is lost until the fallback.
    const signal = new LiveSignal();
    signal.raise();
    expect(await signal.wait(10_000)).toBe(true);
    expect(await signal.wait(5)).toBe(false);
  });

  it('wakes a waiter at once rather than at its timeout', async () => {
    const signal = new LiveSignal();
    const started = Date.now();
    const waiting = signal.wait(10_000);
    signal.raise();
    expect(await waiting).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('LiveHub routing', () => {
  const A = 'community-a';
  const B = 'community-b';

  async function streams(made: LiveHub) {
    const person = await made.open({
      communityId: A,
      channelId: 'general',
      memberId: 'ann',
      userId: 'user-ann',
    });
    const sameChannel = await made.open({ communityId: A, channelId: 'general', memberId: 'bo' });
    const agent = await made.open({
      communityId: A,
      channelId: 'other',
      memberId: 'ann',
      agentId: 'ann-agent',
    });
    const elsewhere = await made.open({ communityId: B, channelId: 'general', memberId: 'cy' });
    return { person, sameChannel, agent, elsewhere };
  }

  async function woken(all: Record<string, LiveStream>, signal: 'entries' | 'access') {
    const names: string[] = [];
    for (const [name, stream] of Object.entries(all))
      if (await raised(stream[signal])) names.push(name);
    return names.sort();
  }

  it('wakes only the streams a notice names', async () => {
    // Purpose: fails if one notice wakes the whole host (the cost this replaces) or misses a
    // stream it names, including an agent's stream through its owner.
    const made = hub();
    const all = await streams(made);
    made.dispatch({ k: 'entry', c: A, ch: 'general' });
    expect(await woken(all, 'entries')).toEqual(['person', 'sameChannel']);
    expect(await woken(all, 'access')).toEqual([]);

    made.dispatch({ k: 'member', c: A, m: 'ann' });
    expect(await woken(all, 'access')).toEqual(['agent', 'person']);
    made.dispatch({ k: 'agent', c: A, a: 'ann-agent' });
    expect(await woken(all, 'access')).toEqual(['agent']);
    made.dispatch({ k: 'user', u: 'user-ann' });
    expect(await woken(all, 'access')).toEqual(['person']);
    made.dispatch({ k: 'channel', c: A, ch: 'general' });
    expect(await woken(all, 'access')).toEqual(['person', 'sameChannel']);
    made.dispatch({ k: 'community', c: B });
    expect(await woken(all, 'access')).toEqual(['elsewhere']);
    // A channel id is only meaningful inside its community.
    made.dispatch({ k: 'content', c: B, ch: 'general' });
    expect(await woken(all, 'entries')).toEqual(['elsewhere']);
  });

  it('wakes every stream once after a reconnect', async () => {
    const made = hub();
    const all = await streams(made);
    made.wakeAll();
    expect(await woken(all, 'entries')).toEqual(['agent', 'elsewhere', 'person', 'sameChannel']);
    expect(await woken(all, 'access')).toEqual(['agent', 'elsewhere', 'person', 'sameChannel']);
  });

  it('stops waking a released stream', async () => {
    const made = hub();
    const all = await streams(made);
    all.person.release();
    all.person.release();
    made.dispatch({ k: 'entry', c: A, ch: 'general' });
    expect(await woken(all, 'entries')).toEqual(['sameChannel']);
    expect(made.snapshot().streams).toBe(3);
  });
});

describe('LiveHub limits', () => {
  it("refuses past a community's quota without shutting out another community", async () => {
    // Purpose: fails if one community's spike can take every stream on the host.
    const made = hub({ maxStreams: 3, maxStreamsPerCommunity: 2 });
    const first = await made.open({ communityId: 'a', channelId: 'x', memberId: '1' });
    await made.open({ communityId: 'a', channelId: 'x', memberId: '2' });
    await expect(made.open({ communityId: 'a', channelId: 'x', memberId: '3' })).rejects.toEqual(
      new LiveStreamLimit('community')
    );
    await made.open({ communityId: 'b', channelId: 'y', memberId: '4' });
    await expect(made.open({ communityId: 'c', channelId: 'z', memberId: '5' })).rejects.toEqual(
      new LiveStreamLimit('host')
    );
    first.release();
    await made.open({ communityId: 'c', channelId: 'z', memberId: '5' });
    expect(made.snapshot().refused).toEqual({ host: 1, community: 1 });
  });
});

describe('live notices', () => {
  it('reads well-formed notices and ignores anything else', () => {
    expect(parseLiveNotice('{"k":"entry","c":"a","ch":"b"}')).toEqual({
      k: 'entry',
      c: 'a',
      ch: 'b',
    });
    for (const bad of [undefined, '', 'not json', '{"k":"entry","c":"a"}', '{"k":"nope"}'])
      expect(parseLiveNotice(bad), String(bad)).toBeNull();
  });
});

describe('metrics text', () => {
  it('reports streams, posts, joins, pool waits, listener health and lag', async () => {
    const made = hub();
    await made.open({ communityId: 'a"b', channelId: 'x', memberId: '1' });
    made.dispatch({ k: 'entry', c: 'a"b', ch: 'x' });
    made.dispatch({ k: 'content', c: 'a"b', ch: 'x' });
    made.dispatch({ k: 'join', c: 'a"b' });
    made.observeLag(0.2);
    const text = renderMetrics(made, { waitingCount: 3, totalCount: 7, idleCount: 2 } as never);
    expect(text).toContain('community_live_streams 1\n');
    expect(text).toContain('community_live_streams_by_community{community_id="a\\"b"} 1\n');
    // A removal wakes streams but is not a post.
    expect(text).toContain('community_posts_per_minute 1\n');
    expect(text).toContain('community_joins_per_minute 1\n');
    expect(text).toContain('community_db_pool_waiting 3\n');
    expect(text).toContain('community_live_listener_up 0\n');
    expect(text).toContain('community_live_delivery_lag_seconds_bucket{le="0.1"} 0\n');
    expect(text).toContain('community_live_delivery_lag_seconds_bucket{le="0.25"} 1\n');
    expect(text).toContain('community_live_delivery_lag_seconds_count 1\n');
    for (const line of text.trimEnd().split('\n'))
      expect(line, line).toMatch(/^(# (HELP|TYPE) \w+ .+|\w+(\{[^}]*\})? -?[\d.e+]+)$/);
  });
});
