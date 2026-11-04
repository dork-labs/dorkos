/**
 * How each room hand-off stands, by the id its sender was given (DOR-3778).
 *
 * `post_to_room` from a chat that is not the agent's seat answers `handedOff: true` and nothing
 * more. A seat can then wait up to an hour, and an answer sent back can be refused, so the sender
 * could not tell a slow hand-off from a lost one. This is what the sender can always read.
 *
 * Process memory, like the hand-offs themselves: a restart drops both, which is why an id nobody
 * here knows reads as `unknown` and says a restart is one way to get there. An agent reads only its
 * own, and somebody else's id reads the same as one that never existed, so an id cannot be probed.
 *
 * @module server/services/rooms/handoff/handoff-outcomes
 */

/** Settled outcomes kept, oldest dropped first. A waiting hand-off is never dropped. */
const SETTLED_MEMORY = 500;

/** Why a hand-off has not ended yet. */
export type HandoffWaiting = 'queued' | 'seat_busy' | 'running';

/** How a hand-off stands, as its sender reads it. */
export type HandoffStatus =
  | { status: 'pending'; waiting: HandoffWaiting; reason: string; waitEndsAt?: string }
  | { status: 'posted'; entryId: string }
  | { status: 'declined'; reason: string }
  | { status: 'unknown'; reason: string };

/** What a waiting hand-off is doing, in a line its sender can act on. */
const WAITING_REASON: Record<HandoffWaiting, string> = {
  queued: 'Another hand-off to this room chat runs first.',
  seat_busy: 'The room chat is mid-turn, or holds background work a restart would end.',
  running: 'The room chat has it and is taking its turn.',
};

const UNKNOWN: HandoffStatus = {
  status: 'unknown',
  reason:
    'No hand-off of yours has that id. A server restart drops waiting hand-offs, so if you ' +
    'were given this id, post it again.',
};

/** Every hand-off's standing, for one room service. */
export class HandoffOutcomes {
  private readonly records = new Map<string, { authorId: string; status: HandoffStatus }>();

  /**
   * Record that a hand-off exists, or that what it waits on changed.
   *
   * @param id - The hand-off's id.
   * @param authorId - The agent whose hand-off it is.
   * @param waiting - What it waits on now.
   * @param waitEndsAt - Epoch ms it stops trying, once known.
   */
  noteWaiting(id: string, authorId: string, waiting: HandoffWaiting, waitEndsAt?: number): void {
    this.records.set(id, {
      authorId,
      status: {
        status: 'pending',
        waiting,
        reason: WAITING_REASON[waiting],
        ...(waitEndsAt !== undefined ? { waitEndsAt: new Date(waitEndsAt).toISOString() } : {}),
      },
    });
  }

  /**
   * Record how a hand-off ended.
   *
   * @param id - The hand-off's id.
   * @param authorId - The agent whose hand-off it is.
   * @param status - How it ended.
   */
  settle(
    id: string,
    authorId: string,
    status: Extract<HandoffStatus, { status: 'posted' | 'declined' }>
  ): void {
    this.records.delete(id);
    this.records.set(id, { authorId, status });
    this.dropOldestSettled();
  }

  /**
   * How a hand-off stands, for the agent asking.
   *
   * @param id - The id the sender was given.
   * @param authorId - The agent asking.
   */
  read(id: string, authorId: string): HandoffStatus {
    const record = this.records.get(id);
    return record?.authorId === authorId ? record.status : UNKNOWN;
  }

  /** Keep the settled records bounded. Map order is oldest first, and waiting ones stay. */
  private dropOldestSettled(): void {
    let settled = 0;
    for (const record of this.records.values()) {
      if (record.status.status !== 'pending') settled += 1;
    }
    for (const [id, record] of this.records) {
      if (settled <= SETTLED_MEMORY) return;
      if (record.status.status === 'pending') continue;
      this.records.delete(id);
      settled -= 1;
    }
  }
}
