/**
 * The room's promises to a person while an agent works on their message
 * (DOR-2823): the 👀 receipt that shows somebody has it, and the busy launch
 * the room tries again instead of dropping.
 *
 * Both live in memory, like the claims they describe. A restart could leave a
 * receipt standing, so the room clears agents' recent 👀 at boot
 * (`ReactionStore.clearRecentAgentReactions`), which it can do because agents
 * may no longer put 👀 on anything themselves. A restart drops a waiting
 * retry, and the agent's next turn in that room still reads the message.
 *
 * @module server/services/rooms/receipts/turn-receipts
 */
import { ROOM_RECEIPT_EMOJI, type RoomEntry } from '@dorkos/shared/room-schemas';
import { outsideAuditScope } from '../../audit/audit-context.js';
import { logger } from '../../../lib/logger.js';
import { agentKey } from '../room-claims.js';
import type { ReactionStore } from '../reactions/reaction-store.js';

/**
 * How long the room waits before trying a busy agent again, attempt by attempt.
 * Roughly two hours in all, then it says so and stops.
 */
export const BUSY_RETRY_DELAYS_MS: readonly number[] = [
  15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_200_000, 1_800_000, 1_800_000,
];

/**
 * Clear the receipts a restart left standing: nothing they described is still
 * running. A day back is enough, since no room turn outlives the late-reply
 * ceiling. Run once at boot.
 *
 * @param reactions - The room reaction store.
 */
export function clearStaleReceipts(
  reactions: Pick<ReactionStore, 'clearRecentAgentReactions'>
): void {
  const stale = reactions.clearRecentAgentReactions(ROOM_RECEIPT_EMOJI, 24 * 60 * 60_000);
  if (stale.length > 0) {
    logger.info('[rooms] cleared receipts a restart left standing', { count: stale.length });
  }
}

/** What {@link TurnReceipts} reads and writes through. */
export interface TurnReceiptsDeps {
  /**
   * Put the 👀 receipt on a message for an agent, or take it off. Absent in a
   * harness without reactions, which then shows no receipts at all.
   */
  markReceipt?(roomId: string, entryId: string, authorId: string, on: boolean): void;
  /** The newest message an agent's turns have read in a room, or -1. */
  lastReadSeq(roomId: string, authorId: string): number;
}

/** A busy retry that was scheduled: which attempt, and how long until it runs. */
export interface ScheduledRetry {
  /** 1 for the first retry. */
  attempt: number;
  inMs: number;
}

/** The key a busy retry is tracked under: one message, for one agent. */
function retryKey(roomId: string, authorId: string, entryId: string): string {
  return `${roomId}\u0000${authorId}\u0000${entryId}`;
}

/** Runs a receipt write, logging rather than throwing: a receipt is a courtesy. */
function tryMark(write: () => void, roomId: string, entryId: string, on: boolean): void {
  try {
    write();
  } catch (err) {
    logger.warn(
      `[rooms] could not ${on ? 'put the receipt on' : 'take the receipt off'} a message`,
      {
        roomId,
        entryId,
        error: err instanceof Error ? err.message : String(err),
      }
    );
  }
}

/** The 👀 receipts standing in every room, and the busy launches waiting. */
export class TurnReceipts {
  /** Attempts made so far for each busy launch, by {@link retryKey}. */
  private readonly attempts = new Map<string, number>();
  /** The timer of each busy launch still waiting, so Stop can cancel it. */
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** The receipts standing for each `(room, agent)` key: entry id to its `seq`. */
  private readonly standing = new Map<
    string,
    { roomId: string; authorId: string; entries: Map<string, number> }
  >();

  constructor(private readonly deps: TurnReceiptsDeps) {}

  /**
   * Put the 👀 receipt on a person's message for one picked agent.
   *
   * @param roomId - The room.
   * @param entry - The person's message.
   * @param authorId - The agent picked to answer it.
   */
  mark(roomId: string, entry: RoomEntry, authorId: string): void {
    const write = this.deps.markReceipt;
    if (!write) return;
    const key = agentKey(roomId, authorId);
    const standing = this.standing.get(key) ?? { roomId, authorId, entries: new Map() };
    standing.entries.set(entry.id, entry.seq);
    this.standing.set(key, standing);
    tryMark(() => write(roomId, entry.id, authorId, true), roomId, entry.id, true);
  }

  /**
   * Take one message's receipt off for one agent. Its retry count stays: only
   * {@link forgetRetry} ends that, so a release racing a retry never resets it.
   *
   * @param roomId - The room.
   * @param authorId - The agent.
   * @param entryId - The message.
   */
  clear(roomId: string, authorId: string, entryId: string): void {
    const key = agentKey(roomId, authorId);
    const standing = this.standing.get(key);
    if (!standing?.entries.has(entryId)) return;
    standing.entries.delete(entryId);
    if (standing.entries.size === 0) this.standing.delete(key);
    const write = this.deps.markReceipt;
    if (write) tryMark(() => write(roomId, entryId, authorId, false), roomId, entryId, false);
  }

  /**
   * Take one agent's receipts off, up to and including `upToSeq`. A message the
   * room is still waiting on a busy agent for keeps its receipt, unless the
   * agent has read it since, which answers it and cancels the retry.
   *
   * @param key - The `(room, agent)` key.
   * @param upToSeq - The newest message whose receipt comes off.
   */
  clearUpTo(key: string, upToSeq: number): void {
    const standing = this.standing.get(key);
    if (!standing) return;
    for (const [entryId, seq] of standing.entries) {
      if (seq > upToSeq) continue;
      const pending = retryKey(standing.roomId, standing.authorId, entryId);
      const timer = this.timers.get(pending);
      if (timer !== undefined) {
        if (this.deps.lastReadSeq(standing.roomId, standing.authorId) < seq) continue;
        clearTimeout(timer);
        this.timers.delete(pending);
        this.attempts.delete(pending);
      }
      this.clear(standing.roomId, standing.authorId, entryId);
    }
  }

  /**
   * Schedule the next try of a launch the runtime refused as busy.
   *
   * @param roomId - The room.
   * @param authorId - The busy agent.
   * @param entryId - The message it would have answered.
   * @param run - Puts the launch back through the collector. A throw clears
   *   the receipt and is logged, never thrown from a bare timer.
   * @returns The attempt scheduled, or `null` once every retry is spent.
   */
  scheduleRetry(
    roomId: string,
    authorId: string,
    entryId: string,
    run: () => void
  ): ScheduledRetry | null {
    const key = retryKey(roomId, authorId, entryId);
    const made = this.attempts.get(key) ?? 0;
    const inMs = BUSY_RETRY_DELAYS_MS[made];
    if (inMs === undefined) return null;
    this.attempts.set(key, made + 1);
    // Outside the audit scope of the post that started this, like every other
    // timer in rooms.
    const timer = setTimeout(
      outsideAuditScope(() => {
        this.timers.delete(key);
        try {
          run();
        } catch (err) {
          this.forgetRetry(roomId, authorId, entryId);
          this.clear(roomId, authorId, entryId);
          logger.warn('[rooms] could not try a busy agent again', {
            roomId,
            authorId,
            entryId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
      inMs
    );
    timer.unref?.();
    this.timers.set(key, timer);
    return { attempt: made + 1, inMs };
  }

  /**
   * Whether the room has already tried this launch again at least once.
   *
   * @param roomId - The room.
   * @param authorId - The agent.
   * @param entryId - The message.
   */
  isRetrying(roomId: string, authorId: string, entryId: string): boolean {
    return this.attempts.has(retryKey(roomId, authorId, entryId));
  }

  /**
   * Forget a launch's retry count: it was answered, or the room gave up.
   *
   * @param roomId - The room.
   * @param authorId - The agent.
   * @param entryId - The message.
   */
  forgetRetry(roomId: string, authorId: string, entryId: string): void {
    this.attempts.delete(retryKey(roomId, authorId, entryId));
  }

  /**
   * Cancel every busy launch still waiting in a room, or for one agent in it,
   * and take their receipts off. Stop means stop, including later.
   *
   * @param roomId - The room.
   * @param authorId - One agent, or every agent when omitted.
   */
  cancelRetries(roomId: string, authorId?: string): void {
    const prefix = authorId === undefined ? `${roomId}\u0000` : `${roomId}\u0000${authorId}\u0000`;
    for (const [key, timer] of this.timers) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.timers.delete(key);
      this.attempts.delete(key);
      const [, agent, entryId] = key.split('\u0000');
      if (agent && entryId) this.clear(roomId, agent, entryId);
    }
  }
}
