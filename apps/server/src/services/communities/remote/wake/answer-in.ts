/**
 * The channels where any person's new post wakes this install's agents without a mention, and
 * the budget that keeps a flood from buying unlimited turns there (spec `official-community-space`
 * D11). Answered synchronously for the live stream bridge, like the wake setting beside it.
 *
 * Nothing here gives a turn any power. A post this lets through is dispatched exactly like a
 * mention from the same author: a space author is always from off this machine, so the turn runs
 * at the stranger ceiling and a new conversation is seeded with no operator level.
 *
 * @module services/communities/remote/wake/answer-in
 */
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { logger } from '../../../../lib/logger.js';
import type { RemoteConnectionStore } from '../connection-store.js';
import type { AnswerInStore } from './answer-in-store.js';

/** How many answer-in wakes one author, and one channel, may start in one window. */
export interface AnswerInLimits {
  /** The window, in milliseconds. */
  windowMs: number;
  /** Wakes one author may start across one connection's channels in a window. */
  perAuthor: number;
  /** Wakes one channel may start in a window, whoever posts. */
  perChannel: number;
}

/**
 * The shipped budget: three wakes per person and twenty per channel every ten minutes. A post
 * past either is kept as history and wakes nobody; a mention still works the ordinary way.
 */
export const ANSWER_IN_LIMITS: AnswerInLimits = {
  windowMs: 10 * 60_000,
  perAuthor: 3,
  perChannel: 20,
};

/**
 * Sliding-window counts of answer-in wakes, in memory. A restart starts the counts again, which
 * costs at most one window's worth of turns.
 */
export class AnswerInBudget {
  private readonly byAuthor = new Map<string, number[]>();
  private readonly byChannel = new Map<string, number[]>();
  private lastSweep = 0;

  /**
   * Start with nothing spent.
   *
   * @param limits - The budget to hold wakes to.
   * @param now - The clock, injectable for tests.
   */
  constructor(
    private readonly limits: AnswerInLimits = ANSWER_IN_LIMITS,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Spend one wake for this author in this channel, or refuse when either is spent. A refused
   * post spends nothing, so a flood cannot use up the window for the next one.
   *
   * @param connection - The owner-qualified connection key.
   * @param channel - The normalised channel name.
   * @param authorMemberId - The post's author, by member id in the space.
   */
  take(connection: string, channel: string, authorMemberId: string): boolean {
    const at = this.now();
    this.sweep(at);
    const authorKey = `${connection}\0${authorMemberId}`;
    const channelKey = `${connection}\0${channel}`;
    const byAuthor = this.recent(this.byAuthor, authorKey, at);
    const byChannel = this.recent(this.byChannel, channelKey, at);
    if (byAuthor.length >= this.limits.perAuthor || byChannel.length >= this.limits.perChannel) {
      return false;
    }
    this.byAuthor.set(authorKey, [...byAuthor, at]);
    this.byChannel.set(channelKey, [...byChannel, at]);
    return true;
  }

  private recent(counts: Map<string, number[]>, key: string, at: number): number[] {
    return (counts.get(key) ?? []).filter((time) => at - time < this.limits.windowMs);
  }

  /** Drop counts nobody has touched for a window, so memory stays bounded by recent wakes. */
  private sweep(at: number): void {
    if (at - this.lastSweep < this.limits.windowMs) return;
    this.lastSweep = at;
    for (const counts of [this.byAuthor, this.byChannel]) {
      for (const [key, times] of counts) {
        const kept = times.filter((time) => at - time < this.limits.windowMs);
        if (kept.length) counts.set(key, kept);
        else counts.delete(key);
      }
    }
  }
}

/**
 * A channel's name as the list stores it: no leading `#`, no surrounding space, lower case.
 *
 * @param name - The channel's name in the space.
 */
export function answerInChannelName(name: string): string {
  return name.trim().replace(/^#/, '').toLowerCase();
}

/** The in-memory answer over {@link AnswerInStore}, with its budget. */
export class RemoteAnswerIn {
  private channels: ReadonlyMap<string, ReadonlySet<string>> = new Map();
  /** The newest read started, and the newest one whose answer is in {@link channels}. */
  private started = 0;
  private applied = 0;

  /**
   * Build the answer and follow every committed connection change. Until the first read lands
   * it answers nowhere: a missed wake costs a mention, a wrong one hands a stranger a turn.
   *
   * @param store - Where the lists are kept.
   * @param connections - The connection store whose changes are followed.
   * @param budget - The budget every answer-in wake is held to.
   */
  constructor(
    private readonly store: AnswerInStore,
    connections: RemoteConnectionStore,
    private readonly budget: AnswerInBudget = new AnswerInBudget()
  ) {
    connections.onChange(() => {
      void this.reload();
    });
  }

  /** Read every connection's list into memory; a failed read keeps the last good answer. */
  async reload(): Promise<void> {
    const generation = ++this.started;
    try {
      const all = await this.store.all();
      if (generation <= this.applied) return;
      this.applied = generation;
      this.channels = new Map(
        all.map((entry) => [key(entry.ref, entry.ownerKey), new Set(entry.channels)])
      );
    } catch (error) {
      logger.warn('[RemoteAnswerIn] Could not read where agents answer in spaces', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The channels one connection answers in.
   *
   * @param ref - The local connection ref.
   * @param ownerKey - The local owner the connection belongs to.
   */
  get(ref: CommunityRef, ownerKey: string): Promise<string[]> {
    return this.store.get(ref, ownerKey);
  }

  /**
   * Replace one connection's channels and apply them before returning, newer than every read
   * already in flight, so a live post a moment later is judged by the new list.
   *
   * @param ref - The local connection ref.
   * @param ownerKey - The local owner the connection belongs to.
   * @param channels - Channel names, already normalised by `CommunityAnswerInSchema`.
   */
  async set(ref: CommunityRef, ownerKey: string, channels: readonly string[]): Promise<void> {
    await this.store.set(ref, ownerKey, channels);
    this.applied = ++this.started;
    const next = new Map(this.channels);
    if (channels.length) next.set(key(ref, ownerKey), new Set(channels));
    else next.delete(key(ref, ownerKey));
    this.channels = next;
  }

  /**
   * Whether this owner's agents answer every person's post in this channel.
   *
   * @param ref - The local connection ref.
   * @param ownerKey - The local owner the connection belongs to.
   * @param channelName - The channel's name in the space.
   */
  covers(ref: CommunityRef, ownerKey: string, channelName: string): boolean {
    return this.channels.get(key(ref, ownerKey))?.has(answerInChannelName(channelName)) ?? false;
  }

  /**
   * Spend one wake from the budget for this author in this channel, or refuse.
   *
   * @param ref - The local connection ref.
   * @param ownerKey - The local owner the connection belongs to.
   * @param channelName - The channel's name in the space.
   * @param authorMemberId - The post's author, by member id in the space.
   */
  take(ref: CommunityRef, ownerKey: string, channelName: string, authorMemberId: string): boolean {
    return this.budget.take(key(ref, ownerKey), answerInChannelName(channelName), authorMemberId);
  }
}

function key(ref: CommunityRef, ownerKey: string): string {
  return `${ownerKey}\0${ref}`;
}
