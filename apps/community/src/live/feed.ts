/**
 * One shared read of each new channel entry, for every live stream on that channel.
 *
 * Without this, each open stream read every new entry and its attachments for itself: 20,000
 * streams on one channel turned one post into 40,000 queries. A {@link ChannelFeed} reads the
 * entries an `entry` notice announces ONCE, keeps the most recent ones, and wakes the channel's
 * streams to take them from memory. A stream that is further behind than the feed remembers
 * reads for itself, as before.
 *
 * Postgres delivers notices in the order their transactions committed, and the hub handles them
 * in that order. So once the feed has handled the notice for entry `s`, every notice from a
 * change committed before `s` (a revocation included) has already been handled too. Entries up to
 * {@link FeedRead.noticedThrough} are therefore safe to send on a stream's cached access, as long
 * as nothing has asked that stream to recheck since. Anything the feed found without a notice (its
 * fallback re-read, or the re-read after a reconnect) is past `noticedThrough`, and a stream must
 * check its access fresh after the read before it sends it.
 */

/** A strictly increasing counter, so "checked after it was read" never depends on a clock tie. */
let ticks = 0;

/** The next tick of the shared counter; see {@link FeedItem.readAt}. */
export function nextTick(): number {
  ticks += 1;
  return ticks;
}

/** One entry the feed read, shared by every stream on its channel. */
export interface FeedItem<T> {
  readonly seq: number;
  readonly value: T;
  /** The {@link nextTick} taken after the read that returned it. */
  readonly readAt: number;
}

/**
 * Read a channel's entries after `afterSeq`, in sequence order, at most `limit`. `upToSeq` bounds
 * the read to what notices announced; null reads whatever is committed.
 */
export type FeedReader<T> = (
  communityId: string,
  channelId: string,
  afterSeq: number,
  upToSeq: number | null,
  limit: number
) => Promise<Array<{ seq: number; value: T }>>;

/** What a stream at one position finds in its channel's feed. */
export interface FeedRead<T> {
  /**
   * False when the feed cannot say what comes after the position (the stream is behind what it
   * remembers, or it has not started): the stream reads for itself.
   */
  covered: boolean;
  /** The entries after the position, oldest first. */
  items: FeedItem<T>[];
  /** Entries up to this sequence were announced by a notice the hub has handled. */
  noticedThrough: number;
}

/** The feed's settings. */
export interface ChannelFeedsOptions<T> {
  read: FeedReader<T>;
  /** Wake every stream on the channel: the feed has something new. */
  wake: (communityId: string, channelId: string) => void;
  /**
   * Whether the channel still has a stream here. A feed whose channel has none left closes at its
   * next fallback re-read, should it ever miss being told.
   */
  hasStreams: (communityId: string, channelId: string) => boolean;
  /** How often a feed re-reads without a notice, in case one was lost. */
  fallbackMs: number;
  /** Where read failures are reported. */
  log?: (message: string, detail: string) => void;
}

/** Entries one read takes at most. */
const READ_BATCH = 200;
/**
 * How long a feed keeps an entry, for streams that are behind. One further behind reads for
 * itself, and when thousands do at once they queue every post behind their reads: kept for only
 * a few seconds, a busy moment that put streams that far behind never recovered. Across every
 * feed this keeps about a minute of the server's posts, so memory follows the post rate.
 */
const KEEP_MS = 60_000;
/** The least time between two wakes of one channel's streams; see `wakeSoon`. */
const WAKE_GAP_MS = 100;
/** The first pause before a failed read is tried again. */
const RETRY_FIRST_MS = 250;
/** At most this many per feed: a full minute of about 68 posts a second in one channel. */
const KEEP_ITEMS = 4_096;

/** One channel's feed. */
export class ChannelFeed<T> {
  /** Every entry in (base, head] is in `items`, or none was ever written there. -1: unknown. */
  private base = -1;
  private head = -1;
  private noticed = 0;
  private items: Array<FeedItem<T> & { keptAt: number }> = [];
  /** Changes whenever what the feed holds is thrown away, so a read already under way is too. */
  private generation = 0;
  private reading = false;
  private pollWanted = false;
  /** Kept entries may have changed (a removal): hidden until they are read again. */
  private stale = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = RETRY_FIRST_MS;
  private lastWake = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    readonly communityId: string,
    readonly channelId: string,
    private readonly options: ChannelFeedsOptions<T>,
    private readonly retire: () => void
  ) {
    this.schedulePoll();
  }

  /**
   * Changes whenever the feed throws away what it holds: a removal or redaction in the channel, a
   * channel change, a reconnect. A stream holding entries it read itself drops them when it moves.
   */
  get version(): number {
    return this.generation;
  }

  /** What comes after `position`, at most `max` entries. */
  after(position: number, max: number): FeedRead<T> {
    const noticedThrough = this.noticed;
    if (this.head < 0 || position < this.base) return { covered: false, items: [], noticedThrough };
    // Streams wait for the fresh copies rather than each reading the changed entries itself.
    if (this.stale) return { covered: true, items: [], noticedThrough };
    let low = 0;
    let high = this.items.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.items[middle].seq <= position) low = middle + 1;
      else high = middle;
    }
    return { covered: true, items: this.items.slice(low, low + max), noticedThrough };
  }

  /**
   * A stream knows the channel's history through `seq` (its snapshot, or its own read). A feed
   * that does not know where it stands starts there, and reads once whatever came after it: an
   * entry may have committed after the stream read its history and before the feed was there to
   * hear its notice.
   */
  seed(seq: number): void {
    if (this.closed || this.head >= 0) return;
    this.base = seq;
    this.head = seq;
    this.pollWanted = true;
    this.pump();
  }

  /** A notice announced entry `seq`. */
  noticedEntry(seq: number): void {
    if (seq > this.noticed) this.noticed = seq;
    if (this.head < 0) {
      // Nothing to read from yet: the streams read for themselves and seed the feed.
      this.options.wake(this.communityId, this.channelId);
      return;
    }
    this.pump();
  }

  /**
   * An entry's text or files changed (a removal, a redaction, an erasure). Hide every kept entry
   * and read them all again, once, for every stream: a stream that is behind then sends the
   * changed text. A read under way is thrown away, since it may hold the old text.
   */
  dropKept(): void {
    this.generation += 1;
    if (this.head < 0) return;
    this.stale = true;
    this.pump();
  }

  /**
   * The channel's history may have been reset, or notices were lost: forget everything, including
   * where the feed stands. Streams read for themselves until one seeds it again.
   */
  reset(): void {
    this.generation += 1;
    this.stale = false;
    this.base = -1;
    this.head = -1;
    this.noticed = 0;
    this.items = [];
  }

  /** The listener reconnected: notices may be lost. Read kept entries and new ones again now. */
  reread(): void {
    this.dropKept();
    this.pollWanted = true;
    this.pump();
  }

  /** The channel has no streams left. */
  close(): void {
    this.closed = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.pollTimer = null;
    this.retryTimer = null;
    this.wakeTimer = null;
    this.items = [];
  }

  private schedulePoll(): void {
    if (this.closed) return;
    // Jittered, like a stream's own fallback, so feeds that opened together spread their reads.
    const wait = Math.round(this.options.fallbackMs * (0.8 + Math.random() * 0.4));
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (!this.options.hasStreams(this.communityId, this.channelId)) {
        this.retire();
        return;
      }
      this.pollWanted = true;
      this.pump();
      this.schedulePoll();
    }, wait);
    this.pollTimer.unref();
  }

  /** Read until the feed has everything notices announced (and, after a poll, everything). */
  private pump(): void {
    if (this.reading || this.closed || this.retryTimer) return;
    this.reading = true;
    void this.drain().finally(() => {
      this.reading = false;
      // Seeded, or told of more, between the last loop and here: read again.
      if (this.closed || this.head < 0) return;
      if (this.stale || this.pollWanted || this.head < this.noticed) this.pump();
    });
  }

  private async drain(): Promise<void> {
    while (!this.closed && this.head >= 0) {
      if (this.stale) {
        if (!(await this.refresh())) return;
        continue;
      }
      const poll = this.pollWanted;
      if (!poll && this.head >= this.noticed) return;
      this.pollWanted = false;
      const generation = this.generation;
      const from = this.head;
      const upTo = poll ? null : this.noticed;
      const rows = await this.tryRead(from, upTo, READ_BATCH);
      if (!rows) {
        if (poll) this.pollWanted = true;
        return;
      }
      // Something was thrown away while this read ran: its rows may be stale. Read again.
      if (this.closed || generation !== this.generation || from !== this.head) {
        if (poll) this.pollWanted = true;
        continue;
      }
      const readAt = nextTick();
      const now = Date.now();
      for (const row of rows) this.items.push({ ...row, readAt, keptAt: now });
      const last = rows.at(-1)?.seq ?? from;
      // Short of the batch, the read saw every committed entry up to its bound: entries commit
      // in sequence order under the channel's row lock, so none can appear below it later.
      this.head = rows.length === READ_BATCH || upTo === null ? Math.max(last, from) : upTo;
      if (rows.length === READ_BATCH && poll) this.pollWanted = true;
      this.trim(now);
      if (rows.length) this.wakeSoon();
    }
  }

  /**
   * Wake the channel's streams now, or, if they were woken less than {@link WAKE_GAP_MS} ago,
   * once that gap has passed. The first message after a quiet spell goes out at once; in a busy
   * channel each stream then sends what arrived in the gap in one write rather than one write per
   * message, which is most of what a delivery costs.
   */
  private wakeSoon(): void {
    if (this.wakeTimer || this.closed) return;
    const wait = this.lastWake + WAKE_GAP_MS - Date.now();
    const wake = () => {
      this.wakeTimer = null;
      this.lastWake = Date.now();
      this.options.wake(this.communityId, this.channelId);
    };
    if (wait <= 0) {
      wake();
      return;
    }
    this.wakeTimer = setTimeout(wake, wait);
    this.wakeTimer.unref();
  }

  /** Read every kept entry again after a removal. False when the read failed. */
  private async refresh(): Promise<boolean> {
    const generation = this.generation;
    const base = this.base;
    const head = this.head;
    const kept = this.items;
    const rows = kept.length ? await this.tryRead(base, head, kept.length) : [];
    if (!rows) return false;
    if (this.closed || generation !== this.generation || base !== this.base || head !== this.head)
      return true;
    const keptAt = new Map(kept.map((item) => [item.seq, item.keptAt]));
    const readAt = nextTick();
    const now = Date.now();
    this.items = rows.map((row) => ({ ...row, readAt, keptAt: keptAt.get(row.seq) ?? now }));
    this.stale = false;
    this.wakeSoon();
    return true;
  }

  /**
   * One read, or null when it failed. A failed read keeps the feed where it stands and tries again
   * after a pause that grows to the fallback interval: its streams wait rather than all reading
   * for themselves at once, against a database that is already struggling.
   */
  private async tryRead(
    after: number,
    upTo: number | null,
    limit: number
  ): Promise<Array<{ seq: number; value: T }> | null> {
    try {
      const rows = await this.options.read(this.communityId, this.channelId, after, upTo, limit);
      this.retryMs = RETRY_FIRST_MS;
      return rows;
    } catch (error) {
      this.options.log?.(
        'Community live updates could not read new messages',
        error instanceof Error ? error.message : String(error)
      );
      const wait = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, Math.max(RETRY_FIRST_MS, this.options.fallbackMs));
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.pump();
      }, wait);
      this.retryTimer.unref();
      return null;
    }
  }

  private trim(now: number): void {
    let drop = Math.max(0, this.items.length - KEEP_ITEMS);
    while (drop < this.items.length && now - this.items[drop].keptAt > KEEP_MS) drop += 1;
    if (!drop) return;
    this.base = this.items[drop - 1].seq;
    this.items = this.items.slice(drop);
  }
}

/**
 * What the hub tells the stream fan-out. The hub knows which streams a notice names; the fan-out
 * reads what they need once and wakes them through {@link ChannelFeedsOptions.wake}.
 */
export interface LiveEntryFanout {
  /** A notice announced entry `seq` in a channel. */
  entry(communityId: string, channelId: string, seq: number): void;
  /** Entries' text or files changed, in one channel or (no channel) anywhere in the community. */
  content(communityId: string, channelId?: string): void;
  /** A channel was archived, reopened, deleted or had its history reset. */
  channel(communityId: string, channelId: string): void;
  /** The listener reconnected: any notice may have been lost. */
  reconnect(): void;
  /** A stream on the channel opened: from now on, every notice for it is heard. */
  channelOpened(communityId: string, channelId: string): void;
  /** The channel's last stream on this server closed. */
  channelClosed(communityId: string, channelId: string): void;
}

/** Every channel feed on this server, one per channel with an open stream. */
export class ChannelFeeds<T> implements LiveEntryFanout {
  private readonly feeds = new Map<string, ChannelFeed<T>>();

  constructor(private readonly options: ChannelFeedsOptions<T>) {}

  /** The feed for a channel with an open stream, made on first use. */
  feed(communityId: string, channelId: string): ChannelFeed<T> {
    const key = feedKey(communityId, channelId);
    let feed = this.feeds.get(key);
    if (!feed) {
      feed = new ChannelFeed(communityId, channelId, this.options, () =>
        this.channelClosed(communityId, channelId)
      );
      this.feeds.set(key, feed);
    }
    return feed;
  }

  /** The feed for a channel, if one exists. */
  find(communityId: string, channelId: string): ChannelFeed<T> | undefined {
    return this.feeds.get(feedKey(communityId, channelId));
  }

  entry(communityId: string, channelId: string, seq: number): void {
    const feed = this.find(communityId, channelId);
    if (feed) feed.noticedEntry(seq);
    // No feed means no stream has seeded one yet: the streams read for themselves.
    else this.options.wake(communityId, channelId);
  }

  content(communityId: string, channelId?: string): void {
    if (channelId) this.find(communityId, channelId)?.dropKept();
    else for (const feed of this.each(communityId)) feed.dropKept();
  }

  channel(communityId: string, channelId: string): void {
    this.find(communityId, channelId)?.reset();
  }

  reconnect(): void {
    for (const feed of this.each()) feed.reread();
  }

  channelOpened(communityId: string, channelId: string): void {
    this.feed(communityId, channelId);
  }

  channelClosed(communityId: string, channelId: string): void {
    const key = feedKey(communityId, channelId);
    const feed = this.feeds.get(key);
    if (!feed) return;
    feed.close();
    this.feeds.delete(key);
  }

  private *each(communityId?: string): Iterable<ChannelFeed<T>> {
    for (const feed of this.feeds.values())
      if (communityId === undefined || feed.communityId === communityId) yield feed;
  }

  /** How many feeds are open. */
  get size(): number {
    return this.feeds.size;
  }
}

function feedKey(communityId: string, channelId: string): string {
  return `${communityId}\u0000${channelId}`;
}
