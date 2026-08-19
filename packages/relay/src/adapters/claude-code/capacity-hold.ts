/**
 * The waiting line in front of a runtime that is already running all it can.
 *
 * ## Why this exists
 *
 * The adapter runs at most `maxConcurrent` turns at once. Messages for the SAME
 * session were already held — `RuntimeAdapter.enqueueForSession` serializes them
 * — but a message for a DIFFERENT session that arrived while every slot was
 * taken was refused, and the person who wrote it (a bridged Telegram or Slack
 * chat, one hop upstream) was asked to send it again.
 *
 * That is the same mistake the room dispatcher made at its own second ceiling,
 * and ADR `260818-234541` settled it there: **a busy agent's message is held,
 * not refused.** This is that decision applied to the adapter's ceiling. The
 * message keeps its place, the next slot to free runs it, and nobody is asked
 * to type anything twice.
 *
 * ## The promise this can keep, and the one it cannot
 *
 * A hold is a promise that a turn will run, so it may only be made where it can
 * be kept. Three properties are what make it keepable here:
 *
 * 1. **The release seam is total.** `ClaudeCodeAdapter.deliver` releases its
 *    slot in a `finally`, so a turn that answers, throws, times out or is
 *    stopped all reach {@link CapacityHold.release} — the same "every terminal
 *    reaches one function" property the room hold relies on.
 * 2. **The wait is bounded by a ceiling that already exists.** A held delivery
 *    waits at most `holdCeilingMs`, which the adapter sets to its own turn
 *    timeout: no new setting, and the bound is exactly the ceiling on the turn
 *    that is in the way.
 * 3. **Nobody is blocked by the wait.** Only deliveries the publish pipeline has
 *    already detached may wait (see `mayWait`); an awaited delivery would spend
 *    its caller's timeout sitting in this line.
 *
 * What it cannot keep is a restart: the line is process memory and dies with the
 * process. {@link CapacityHold.drain} is what makes an orderly stop honest —
 * every waiter settles `stopped`, which becomes a line in the chat rather than
 * silence.
 *
 * @module relay/adapters/claude-code/capacity-hold
 */

/**
 * How long a hold must last before it is worth telling anyone about.
 *
 * Ten seconds, borrowed from the room lane's own floor
 * (`LANE_TIMER_FLOOR_MS`, `specs/room-hold-when-busy` §5.2): "a hold that clears
 * in eight seconds is not a story". Almost every hold here clears in under a
 * second, and a chat message announcing one would be noise the person has to
 * read — `meta/agent-etiquette.md` names over-participation, not silence, as the
 * failure mode people complain about.
 */
export const HOLD_ANNOUNCE_AFTER_MS = 10_000;

/**
 * How many deliveries may wait per running slot.
 *
 * A memory guard, not a politeness one: `holdCeilingMs` is what actually ends a
 * hold, and a line this long can only ever expire if slots stop freeing
 * altogether. It exists so a runtime that wedges cannot grow the line without
 * limit.
 */
export const WAITING_PER_SLOT = 10;

/** How a request for a session slot ended. */
export type SlotOutcome =
  /** A slot was taken. The caller MUST call {@link CapacityHold.release}. */
  | 'acquired'
  /** Every slot was busy and the waiting line was full. Nothing was taken. */
  | 'line_full'
  /** The delivery waited out `holdCeilingMs` and no slot came. */
  | 'held_too_long'
  /** The adapter stopped while this delivery was waiting. */
  | 'stopped';

/** How a caller asks for a slot. */
export interface SlotRequest {
  /**
   * Whether this delivery may wait for a slot instead of being refused.
   *
   * `false` for anything the publish pipeline AWAITS: waiting there spends the
   * caller's own timeout and reports a timeout where the truth was capacity.
   */
  readonly mayWait: boolean;
  /**
   * Called once, from inside the wait, when the hold has lasted longer than
   * {@link HOLD_ANNOUNCE_AFTER_MS} — the caller's chance to say so where the
   * person is waiting. Never called for a hold that clears quickly, and never
   * called more than once.
   */
  readonly onHeld?: () => void;
}

/** Construction options for {@link CapacityHold}. */
export interface CapacityHoldOptions {
  /** How many turns may run at once. */
  readonly maxConcurrent: number;
  /** The longest one delivery may wait for a slot. */
  readonly holdCeilingMs: number;
  /** Override the announce delay. Tests only; production uses the constant. */
  readonly announceAfterMs?: number;
}

/** One delivery parked in the line. */
interface Waiter {
  /** End this wait exactly once, whatever ends it. */
  readonly settle: (outcome: SlotOutcome) => void;
}

/**
 * A concurrency semaphore whose "full" answer is a wait rather than a refusal.
 *
 * Ordering is FIFO by arrival, which is the only order that cannot starve a
 * message: the oldest wait is always the next to run.
 */
export class CapacityHold {
  private readonly maxConcurrent: number;
  private readonly holdCeilingMs: number;
  private readonly announceAfterMs: number;
  private readonly maxWaiting: number;
  /** Slots currently taken. */
  private active = 0;
  /** Deliveries waiting for a slot, oldest first. */
  private readonly line: Waiter[] = [];

  /**
   * Create a waiting line for a fixed number of slots.
   *
   * @param options - Slot count, hold ceiling, and the test-only announce delay.
   */
  constructor(options: CapacityHoldOptions) {
    this.maxConcurrent = options.maxConcurrent;
    this.holdCeilingMs = options.holdCeilingMs;
    this.announceAfterMs = options.announceAfterMs ?? HOLD_ANNOUNCE_AFTER_MS;
    this.maxWaiting = options.maxConcurrent * WAITING_PER_SLOT;
  }

  /** Slots currently taken by a running turn. */
  get running(): number {
    return this.active;
  }

  /** Deliveries currently waiting for a slot. */
  get waiting(): number {
    return this.line.length;
  }

  /**
   * Take a slot, or wait for one, or say why neither happened.
   *
   * Resolves `'acquired'` only when a slot was taken; the caller owes exactly
   * one {@link release} for it. Every other outcome takes nothing.
   *
   * @param request - Whether this delivery may wait, and how to announce it.
   */
  async acquire(request: SlotRequest): Promise<SlotOutcome> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return 'acquired';
    }
    if (!request.mayWait || this.line.length >= this.maxWaiting) return 'line_full';

    return new Promise<SlotOutcome>((resolve) => {
      let settled = false;
      const waiter: Waiter = {
        settle: (outcome) => {
          // Once-only, because three things race to end a wait: a freed slot,
          // the ceiling timer, and a stop. Two of them settling would resolve a
          // promise twice — harmless — but would also leave the slot count and
          // the line disagreeing about who is running.
          if (settled) return;
          settled = true;
          clearTimeout(announce);
          clearTimeout(ceiling);
          const at = this.line.indexOf(waiter);
          if (at !== -1) this.line.splice(at, 1);
          resolve(outcome);
        },
      };
      const announce = setTimeout(() => request.onHeld?.(), this.announceAfterMs);
      const ceiling = setTimeout(() => waiter.settle('held_too_long'), this.holdCeilingMs);
      // A pending hold must never be the reason this process stays alive: the
      // message is unanswered either way, and an orderly stop drains the line.
      announce.unref?.();
      ceiling.unref?.();
      this.line.push(waiter);
    });
  }

  /**
   * Give a slot back and start the oldest delivery waiting for one.
   *
   * Must be called exactly once for every `'acquired'` — from a `finally`, so a
   * turn that threw releases the same as one that answered.
   */
  release(): void {
    if (this.active > 0) this.active--;
    while (this.active < this.maxConcurrent) {
      const next = this.line[0];
      if (!next) return;
      // Taken here rather than by the waiter, so the slot cannot be claimed by a
      // fresh `acquire()` in the gap before the parked delivery resumes.
      this.active++;
      next.settle('acquired');
    }
  }

  /**
   * End every wait because the adapter is stopping.
   *
   * The waiters settle `'stopped'`, which their callers report as a failed
   * delivery — so an orderly shutdown tells the chats that were waiting instead
   * of dropping them into silence.
   */
  drain(): void {
    for (const waiter of this.line.splice(0)) waiter.settle('stopped');
  }
}
