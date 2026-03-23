/**
 * Thread participation tracking for the Slack adapter.
 *
 * Tracks which threads the bot has participated in so it can decide
 * whether to respond to follow-up messages. Uses an LRU eviction
 * strategy with TTL expiration to bound memory usage.
 *
 * @module relay/adapters/slack/thread-tracker
 */

const DEFAULT_MAX_SIZE = 1_000;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000; // 24 hours

/**
 * Tracks which Slack threads the bot is participating in.
 *
 * Instance-scoped (no module-level state) per the multiInstance adapter rule.
 * Uses a Map as an LRU cache — entries are deleted and re-inserted on access
 * to maintain insertion-order eviction. Stale entries are lazily removed on read.
 */
export class ThreadParticipationTracker {
  private readonly entries = new Map<string, number>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = DEFAULT_MAX_SIZE, ttlMs = DEFAULT_TTL_MS) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  /** Mark a thread as one the bot is participating in. Refreshes LRU position. */
  markParticipating(channelId: string, threadTs: string): void {
    const key = `${channelId}:${threadTs}`;
    this.entries.delete(key); // refresh LRU position
    if (this.entries.size >= this.maxSize) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey !== undefined) this.entries.delete(firstKey);
    }
    this.entries.set(key, Date.now());
  }

  /** Check whether the bot is participating in a thread. Returns false for expired entries. */
  isParticipating(channelId: string, threadTs: string): boolean {
    const key = `${channelId}:${threadTs}`;
    const timestamp = this.entries.get(key);
    if (timestamp === undefined) return false;
    if (Date.now() - timestamp > this.ttlMs) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  /** Remove all tracked entries. */
  clear(): void {
    this.entries.clear();
  }

  /** Number of currently tracked threads (may include expired entries not yet lazily pruned). */
  get size(): number {
    return this.entries.size;
  }
}
