/**
 * One writer at a time per room repo — the queue every server-side write to a
 * room's own git repository goes through (spec `project-rooms` §3.6).
 *
 * The DOR-500 invariant says every tree has exactly one writer. For an agent's
 * worktree that writer is the agent, and its own turn machinery already
 * serializes it. For `repo/` — the integration tree — the writer is the SERVER,
 * and "the server" is a process serving many requests at once. Two merges
 * landing together would run `git merge` in one checkout twice, which is the
 * contention the invariant exists to forbid.
 *
 * ## It is a queue rather than a refusal, and the wait is bounded
 *
 * A second merge WAITS (spec §3.6 rule 4): two agents finishing at the same
 * moment is the ordinary case, not an error, and telling the second one "try
 * again" would make the room's throughput depend on how well a model guesses a
 * backoff. What it does not do is wait forever — `config.rooms.repo
 * .mergeQueueWaitMs` bounds the wait, and past it the caller is refused with a
 * message it can act on. Two bounds, not one: the FIFO is also capped
 * ({@link MAX_QUEUE_DEPTH}), so a room whose merges have wedged refuses
 * immediately instead of accumulating callers that will all time out anyway.
 *
 * ## Enabling a repo queues here too, and that is not tidiness
 *
 * `RoomRepoService.enable` reads the sidecar, decides the room has no repo, and
 * then creates one — a check-then-act with an `await` in the middle. Two
 * concurrent enables of one room both saw "no repo", both ran `git init`, and
 * the second re-initialised the repository the first had just seeded: a
 * `ROOM.md` commit destroyed by a call that answered `201`. Serializing enable
 * on the SAME key as merge closes it, and closes the enable-versus-merge race
 * with it (a merge cannot run against a repo halfway through being created).
 *
 * The key is the room id, so two rooms never wait on each other.
 *
 * @module server/services/rooms/repo/room-repo-mutex
 */

/**
 * How many callers may stand in one room's queue before the next is refused.
 *
 * Eight, and the number is about what a QUEUE that long would mean rather than
 * about memory. A room's merges are its member agents finishing work; a ninth
 * caller waiting means either a room with more agents than any room has, or —
 * far more likely — merges that have stopped completing. Refusing at the door
 * is a better answer than admitting a caller that will spend the whole wait cap
 * and be refused anyway, because the refusal arrives while the agent still has
 * a turn to do something about it.
 */
export const MAX_QUEUE_DEPTH = 8;

/** One caller standing in a room's queue. */
interface Waiter {
  /** Hand the lane over to this caller. */
  admit: () => void;
  /** The wait cap, cleared the moment the caller is admitted. */
  timer: ReturnType<typeof setTimeout>;
}

/** One room's lane: who holds it, and who is waiting for it. */
interface Lane {
  /** Whether somebody is running right now. */
  held: boolean;
  /** The callers waiting, in arrival order. */
  queue: Waiter[];
}

/** What a caller wants from {@link RoomRepoMutex.run}. */
export interface RoomRepoQueueOptions {
  /**
   * How long this caller may wait for its turn, in milliseconds.
   *
   * It bounds the WAIT and never the work: a merge already running is not
   * interrupted because somebody behind it ran out of patience.
   */
  waitMs: number;
  /**
   * The refusal to throw when the wait is spent.
   *
   * A factory rather than a value so each caller words its own refusal — a
   * merge says `MERGE_IN_FLIGHT`, an enable says the room is busy being set up
   * — and so the error is built at the moment it is thrown, with a stack that
   * points at the wait rather than at the call that set it up.
   */
  busy: () => Error;
  /**
   * The refusal to throw when the queue was already full on arrival.
   *
   * **Its own sentence, because it is its own fact.** This caller never waited:
   * it was turned away at the door, instantly. Reusing the timeout's wording
   * told an agent "the wait ran out" about a call that returned in under a
   * millisecond, which is the kind of small lie that costs somebody an
   * afternoon — and the domain's own rule is that two different things a person
   * can act on differently get two different messages. The CODE is deliberately
   * the same on both paths: "somebody else is merging, come back" is one thing
   * to do about it.
   *
   * Optional, and it falls back to {@link RoomRepoQueueOptions.busy}: a caller
   * that has nothing more specific to say should not be forced to invent it.
   */
  queueFull?: () => Error;
}

/**
 * A per-room serialized operation queue for a room repo's integration tree.
 *
 * One instance per install, shared by every writer. It holds no state beyond
 * the lanes that currently have somebody in them, and a lane is dropped as soon
 * as it empties — so a machine with ten thousand rooms and no merges in flight
 * carries nothing.
 */
export class RoomRepoMutex {
  /** Lanes with somebody in them, keyed by room id. */
  private readonly lanes = new Map<string, Lane>();

  /**
   * Run `task` with exclusive access to one room's repo, waiting if somebody
   * else has it.
   *
   * **The lane is taken synchronously**, before this method's first `await`, so
   * two calls made in one tick cannot both believe they have it. Hand-over is
   * the same: {@link RoomRepoMutex.release} admits the next waiter without ever
   * letting `held` fall to `false`, so a caller arriving mid-hand-over queues
   * behind the waiter it found rather than overtaking it.
   *
   * @param roomId - The room whose repo is being written.
   * @param options - The wait cap, and the refusal to throw past it.
   * @param task - The work to run while holding the lane.
   * @returns Whatever `task` returned.
   * @throws Whatever `options.busy()` builds, when the queue is full or the
   *   wait is spent — and whatever `task` itself throws, unchanged.
   */
  async run<T>(roomId: string, options: RoomRepoQueueOptions, task: () => Promise<T>): Promise<T> {
    const lane = this.lanes.get(roomId) ?? { held: false, queue: [] };
    this.lanes.set(roomId, lane);

    if (lane.held) {
      if (lane.queue.length >= MAX_QUEUE_DEPTH) {
        // Nobody was added, so a lane that is empty apart from its holder must
        // not be left behind by this refusal — the holder's own `release` will
        // drop it. This caller waited for nothing, so it is told so.
        throw (options.queueFull ?? options.busy)();
      }
      await this.waitForLane(lane, options);
    } else {
      lane.held = true;
    }

    try {
      return await task();
    } finally {
      this.release(roomId);
    }
  }

  /**
   * Stand in the lane's queue until it is handed over, or the wait is spent.
   *
   * @param lane - The room's lane.
   * @param options - The wait cap and the refusal.
   */
  private waitForLane(lane: Lane, options: RoomRepoQueueOptions): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = lane.queue.indexOf(waiter);
        // Leaving a timed-out waiter in the queue would hand the lane to
        // somebody who has already been refused, and the lane would then never
        // be released.
        if (at >= 0) lane.queue.splice(at, 1);
        reject(options.busy());
      }, options.waitMs);
      // A pending wait must not be the reason the process cannot exit: the
      // caller behind it is a request, and a request that never gets its turn
      // during a shutdown is refused by the shutdown, not by this timer.
      timer.unref?.();
      const waiter: Waiter = { admit: resolve, timer };
      lane.queue.push(waiter);
    });
  }

  /**
   * Hand the lane to the next caller, or close it.
   *
   * `held` is deliberately never set back to `true` on hand-over: it was never
   * set to `false`. The lane passes from one holder to the next without an
   * instant in between where an arriving caller could take it.
   *
   * @param roomId - The room whose lane is being released.
   */
  private release(roomId: string): void {
    const lane = this.lanes.get(roomId);
    if (!lane) return;
    const next = lane.queue.shift();
    if (!next) {
      this.lanes.delete(roomId);
      return;
    }
    clearTimeout(next.timer);
    next.admit();
  }
}
