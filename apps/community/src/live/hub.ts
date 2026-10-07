import { LiveListener, type LiveListenerState } from './listener.js';
import type { LiveNotice, LiveNoticeTarget } from './notices.js';

/**
 * A wake-up flag one loop waits on. A signal that arrives while nobody waits is kept, so the next
 * wait returns at once: a loop that clears the flag, reads, then waits can never miss a change
 * made during its read.
 */
export class LiveSignal {
  private pending = false;
  private wake: (() => void) | null = null;

  /** Whether the flag is raised and nobody has taken it yet. */
  get raised(): boolean {
    return this.pending;
  }

  /** Raise the flag, waking the waiter if there is one. */
  raise(): void {
    this.pending = true;
    this.wake?.();
  }

  /**
   * Wait until the flag is raised or `ms` passes. True when raised; either way the flag is clear
   * afterwards.
   */
  wait(ms: number): Promise<boolean> {
    if (this.pending) {
      this.pending = false;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve(false);
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        this.pending = false;
        resolve(true);
      };
    });
  }
}

/** Who and what one open stream depends on, by id. */
export interface LiveStreamKeys {
  communityId: string;
  channelId: string;
  /** The stream's member: the person, or the agent's owner. */
  memberId: string;
  /** The agent, for an agent's stream. */
  agentId?: string;
  /** The signed-in account, for a stream opened with a session cookie. */
  userId?: string;
}

/** One open stream's place in the hub. */
export interface LiveStream {
  readonly keys: LiveStreamKeys;
  /** Raised when the channel may have something new to send. */
  readonly entries: LiveSignal;
  /** Raised when the stream's access may have changed and must be checked again. */
  readonly access: LiveSignal;
  /** Leave the hub. Safe to call more than once. */
  release(): void;
}

/** Which limit refused a stream. */
export type LiveStreamLimitScope = 'host' | 'community' | 'member';

/** Why a new stream was refused. */
export class LiveStreamLimit extends Error {
  constructor(
    /**
     * `host`: this process is at its stream cap. `community`: this space is at its quota.
     * `member`: this person, or this one agent, already holds as many streams as one may.
     */
    readonly scope: LiveStreamLimitScope
  ) {
    super(`Live stream limit reached (${scope})`);
  }
}

/** The hub's settings. */
export interface LiveHubOptions {
  /** The direct Postgres address the listener uses. */
  listenUrl: string;
  /** Streams this process holds at once. */
  maxStreams: number;
  /** Streams one community may hold at once on this process. */
  maxStreamsPerCommunity: number;
  /** Streams one person, or one agent, may hold at once on this process. */
  maxStreamsPerMember: number;
  /** How long a quiet stream goes before it re-reads anyway, in case a notice was lost. */
  fallbackMs: number;
  /** Where listener trouble is reported. */
  log?: (message: string, detail: string) => void;
  /** How long the startup self-test waits for its notice. Tests shorten it. */
  selfTestMs?: number;
  /** How often the listener probes its connection, and how long a probe may take. */
  probe?: { everyMs: number; timeoutMs: number };
}

/**
 * One notice can name thousands of streams (a takedown names a whole community). Their access
 * rechecks are released this many at a time, one batch per {@link ACCESS_BATCH_GAP_MS}, so they
 * queue for the pool in step instead of all at once: 20,000 streams take about a second.
 */
const ACCESS_BATCH = 200;
const ACCESS_BATCH_GAP_MS = 10;

/** The notice-to-delivery lag buckets, in seconds. */
export const LIVE_LAG_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30] as const;
const MINUTE_MS = 60_000;

/** Counts events in the last minute, in one-second buckets. */
class MinuteCounter {
  private readonly buckets = new Array<number>(60).fill(0);
  private readonly stamps = new Array<number>(60).fill(0);

  add(now = Date.now()): void {
    const second = Math.floor(now / 1000);
    const slot = second % 60;
    if (this.stamps[slot] !== second) {
      this.stamps[slot] = second;
      this.buckets[slot] = 0;
    }
    this.buckets[slot] += 1;
  }

  total(now = Date.now()): number {
    const oldest = Math.floor((now - MINUTE_MS) / 1000);
    let sum = 0;
    for (let slot = 0; slot < 60; slot += 1)
      if (this.stamps[slot] > oldest) sum += this.buckets[slot];
    return sum;
  }
}

/**
 * The in-process fan-out for live channel streams.
 *
 * One {@link LiveListener} receives every notice; the hub wakes only the streams a notice names,
 * by channel, community, member, agent or account. Each stream reads for itself once woken, so a
 * quiet stream costs nothing between notices but its fallback re-read. Nothing crosses processes:
 * a Community runs on one machine.
 *
 * The listener connects when the first stream opens and disconnects when the last one closes,
 * unless {@link start} pinned it open. The server pins it at boot, after its self-test, so
 * readiness reports a listener that is really there.
 */
export class LiveHub {
  private readonly listener: LiveListener;
  private readonly streams = new Set<LiveStream>();
  private readonly byChannel = new Map<string, Set<LiveStream>>();
  private readonly byCommunity = new Map<string, Set<LiveStream>>();
  private readonly byMember = new Map<string, Set<LiveStream>>();
  private readonly byAgent = new Map<string, Set<LiveStream>>();
  private readonly byUser = new Map<string, Set<LiveStream>>();
  /** Each stream's holder: the agent for an agent's stream, otherwise the person. */
  private readonly byHolder = new Map<string, Set<LiveStream>>();
  private pinned = false;
  private readonly posts = new MinuteCounter();
  private readonly joins = new MinuteCounter();
  private readonly lagCounts = new Array<number>(LIVE_LAG_BUCKETS.length).fill(0);
  private lagCount = 0;
  private lagSum = 0;
  private refused: Record<LiveStreamLimitScope, number> = { host: 0, community: 0, member: 0 };

  constructor(readonly options: LiveHubOptions) {
    this.listener = new LiveListener({
      url: options.listenUrl,
      onNotice: (notice) => this.dispatch(notice),
      onReconnect: () => this.wakeAll(),
      log: options.log,
      probe: options.probe,
    });
  }

  /**
   * Hold the listener open for the life of the process and prove notices arrive. Throws when
   * the self-test fails, which is a startup error: live updates would otherwise be silently slow.
   */
  async start(sender: LiveNoticeTarget): Promise<void> {
    this.pinned = true;
    await this.listener.selfTest(sender, this.options.selfTestMs);
  }

  /** Close the listener for good. Open streams fall back to their periodic re-read. */
  async stop(): Promise<void> {
    this.pinned = false;
    await this.listener.close();
  }

  /** The listener's state. `idle` only when nothing has asked it to listen. */
  get listenerState(): LiveListenerState {
    return this.listener.state;
  }

  /** One database round trip on the listen connection; see {@link LiveListener.ping}. */
  ping(timeoutMs?: number): Promise<boolean> {
    return this.listener.ping(timeoutMs);
  }

  /** Whether readiness depends on the listener: true once {@link start} pinned it. */
  get listenerRequired(): boolean {
    return this.pinned;
  }

  /**
   * Take a place for a new stream, or throw {@link LiveStreamLimit} when this process, this
   * community, or this person or agent is full.
   *
   * The first time anything listens, this waits for the listener, so a read that follows cannot
   * miss a notice. After that it never waits on a connect: a listener that is down is already
   * retrying, and its reconnect wakes every stream, this one included, to re-read once.
   */
  async open(keys: LiveStreamKeys): Promise<LiveStream> {
    const refuse = (scope: LiveStreamLimitScope) => {
      this.refused[scope] += 1;
      return new LiveStreamLimit(scope);
    };
    if (this.streams.size >= this.options.maxStreams) throw refuse('host');
    if ((this.byCommunity.get(keys.communityId)?.size ?? 0) >= this.options.maxStreamsPerCommunity)
      throw refuse('community');
    if ((this.byHolder.get(holderOf(keys))?.size ?? 0) >= this.options.maxStreamsPerMember)
      throw refuse('member');
    let released = false;
    const stream: LiveStream = {
      keys,
      entries: new LiveSignal(),
      access: new LiveSignal(),
      release: () => {
        if (released) return;
        released = true;
        this.remove(stream);
      },
    };
    this.streams.add(stream);
    for (const [index, key] of this.indexesOf(keys)) add(index, key, stream);
    if (this.listener.state !== 'listening') {
      const opening = this.listener.open().catch(() => {
        // Logged by the listener, which keeps retrying. The stream still works on its fallback.
      });
      if (!this.listener.hasListened) await opening;
    }
    return stream;
  }

  private indexesOf(keys: LiveStreamKeys): Array<[Map<string, Set<LiveStream>>, string]> {
    const indexes: Array<[Map<string, Set<LiveStream>>, string]> = [
      [this.byChannel, keys.channelId],
      [this.byCommunity, keys.communityId],
      [this.byMember, keys.memberId],
      [this.byHolder, holderOf(keys)],
    ];
    if (keys.agentId) indexes.push([this.byAgent, keys.agentId]);
    if (keys.userId) indexes.push([this.byUser, keys.userId]);
    return indexes;
  }

  private remove(stream: LiveStream): void {
    if (!this.streams.delete(stream)) return;
    for (const [index, key] of this.indexesOf(stream.keys)) drop(index, key, stream);
    if (this.streams.size === 0 && !this.pinned) void this.listener.close();
  }

  /** Wake the streams one notice names. */
  dispatch(notice: LiveNotice): void {
    switch (notice.k) {
      case 'entry':
        this.posts.add();
        for (const stream of this.inCommunity(this.byChannel.get(notice.ch), notice.c))
          stream.entries.raise();
        return;
      case 'channel':
        this.recheck(this.inCommunity(this.byChannel.get(notice.ch), notice.c));
        return;
      case 'community':
        this.recheck(this.byCommunity.get(notice.c) ?? []);
        return;
      case 'member':
        this.recheck(this.inCommunity(this.byMember.get(notice.m), notice.c));
        return;
      case 'agent':
        this.recheck(this.inCommunity(this.byAgent.get(notice.a), notice.c));
        return;
      case 'user':
        this.recheck(this.byUser.get(notice.u) ?? []);
        return;
      case 'join':
        this.joins.add();
        return;
      case 'probe':
        return;
    }
  }

  private *inCommunity(streams: Set<LiveStream> | undefined, communityId: string) {
    for (const stream of streams ?? []) if (stream.keys.communityId === communityId) yield stream;
  }

  /** Raise access on `streams`, the first batch now and the rest spread out; see ACCESS_BATCH. */
  private recheck(streams: Iterable<LiveStream>): void {
    inBatches([...streams], (stream) => stream.access.raise());
  }

  /**
   * Make every stream re-read its channel and recheck its access once, as after a reconnect.
   * Both are released in batches: a reconnect touches every stream on the server at once.
   */
  wakeAll(): void {
    inBatches([...this.streams], (stream) => {
      stream.entries.raise();
      stream.access.raise();
    });
  }

  /** Record how long one live entry took from being written to being sent. */
  observeLag(seconds: number): void {
    const lag = Math.max(0, seconds);
    this.lagCount += 1;
    this.lagSum += lag;
    LIVE_LAG_BUCKETS.forEach((bound, index) => {
      if (lag <= bound) this.lagCounts[index] += 1;
    });
  }

  /** The figures `/metrics` reports. */
  snapshot() {
    const perCommunity = [...this.byCommunity].map(([communityId, streams]) => ({
      communityId,
      streams: streams.size,
    }));
    return {
      streams: this.streams.size,
      perCommunity,
      postsPerMinute: this.posts.total(),
      joinsPerMinute: this.joins.total(),
      refused: { ...this.refused },
      listenerUp: this.listener.state === 'listening',
      listenerState: this.listener.state,
      listenerReconnects: this.listener.reconnects,
      lag: {
        buckets: LIVE_LAG_BUCKETS.map((bound, index) => ({
          le: bound,
          count: this.lagCounts[index],
        })),
        count: this.lagCount,
        sum: this.lagSum,
      },
    };
  }
}

/** Run `raise` on each stream, the first batch now and the rest spread out; see ACCESS_BATCH. */
function inBatches(streams: LiveStream[], raise: (stream: LiveStream) => void): void {
  const release = (from: number) => {
    for (const stream of streams.slice(from, from + ACCESS_BATCH)) raise(stream);
    if (from + ACCESS_BATCH < streams.length)
      setTimeout(() => release(from + ACCESS_BATCH), ACCESS_BATCH_GAP_MS).unref();
  };
  release(0);
}

function holderOf(keys: LiveStreamKeys): string {
  return keys.agentId ?? keys.memberId;
}

function add<K>(index: Map<K, Set<LiveStream>>, key: K, stream: LiveStream): void {
  let set = index.get(key);
  if (!set) index.set(key, (set = new Set()));
  set.add(stream);
}

function drop<K>(index: Map<K, Set<LiveStream>>, key: K, stream: LiveStream): void {
  const set = index.get(key);
  if (!set) return;
  set.delete(stream);
  if (!set.size) index.delete(key);
}
