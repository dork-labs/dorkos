/**
 * Two ceilings on what automatic replies can cost, counted without asking who
 * is calling.
 *
 * ## Why this exists next to a guard that already bounds cascades
 *
 * The cascade guard (`cascade-guard.ts`) is the precise instrument: it bounds
 * ONE conversation, and it does that by reading who wrote the triggering entry —
 * a human resets the count, an agent does not.
 *
 * That discriminator is caller-asserted identity, and in the DEFAULT posture it
 * is unforgeable by nobody. `resolveCaller` treats a request with no
 * `X-DorkOS-Agent` header as the local human, and `sessionGate` is a
 * pass-through while `auth.enabled` is false, so a program on this machine
 * becomes the operator by *omitting* a header. That is the documented DOR-505
 * residual — `lib/caller-authority.ts` names the same move — and it is not
 * closable from inside this domain: with login off there is genuinely nothing
 * left to tell a local program from the person at the keyboard.
 *
 * So the room path carries bounds that do not depend on the answer to "who is
 * this". They count **every automatic turn**, whoever appeared to ask for it.
 *
 * ## Two ceilings, because one of them is not a ceiling
 *
 * | Cap | Bounds |
 * | ---------- | ------------------------------------ |
 * | per room   | what any ONE room can cost           |
 * | global     | what the whole install can cost      |
 *
 * The per-room cap alone is not a spend bound, and it is worth being exact
 * about why rather than discovering it again. **Rooms are free.** A caller that
 * can create rooms multiplies its budget by creating them: measured through the
 * real mount, a cap of 2/room bought 16 turns across 8 channels. Threads are
 * cheaper still, since a thread inherits the parent's whole roster, so five
 * threads off one parent bought 12. Neither is a defect in the per-room cap —
 * it does exactly what it says — it is the difference between bounding a room
 * and bounding a wallet.
 *
 * The global cap is what makes "the ceiling on what this can cost you" true.
 * The per-room cap stays because it is what keeps one runaway room from eating
 * the whole global allowance and starving every other room.
 *
 * ## What it deliberately is not
 *
 * **In-memory: both windows reset when the server restarts.** For an accidental
 * loop that costs nothing — it runs in seconds and never sees a restart. For a
 * deliberate caller it is a real limit, and the honest statement is that it does
 * not bound one: `POST /api/admin/restart` sits behind the same pass-through
 * gate in this posture and is rate-limited to 3 per 5 minutes, so a caller
 * willing to use it can clear both windows roughly 36 times an hour.
 *
 * Closing that needs a durable counter, which means a write on the hot path of
 * every turn and a table to hold it. It is a deliberate follow-up, and the
 * reason is stronger than the cost: **a caller who can omit the header already
 * has a shell on this machine, and a shell can spend the model budget directly**
 * without going near a room. Hardening this counter against them hardens one
 * door in a building whose walls are elsewhere; DOR-505 (turning login on) is
 * the actual fix.
 *
 * What these caps completely bound is the case with no attacker in it: two
 * `always` agents talking each other in circles, which is a configuration a
 * reasonable person reaches on purpose and which costs real money for no work.
 * That is the common case and worth having on its own. See ADR 260726-170127.
 *
 * @module server/services/rooms/turn-budget
 */

/** One hour, the window both config fields are denominated in. */
const WINDOW_MS = 60 * 60_000;

/**
 * How many rooms to keep windows for before dropping the least recently
 * touched. A room's window is at most its cap in timestamps, so this bounds the
 * whole structure; without it, a long-lived server that visited many rooms
 * would hold a growing map of empty arrays.
 *
 * Eviction can only ever be generous — an evicted room reads as unspent — which
 * is why the global window is NOT keyed by room and never evicted. That is the
 * one that has to be exact.
 */
const TRACKED_ROOMS = 256;

/** Which ceiling refused a turn. */
export type BudgetRefusalScope = 'room' | 'global';

/**
 * Outcome of asking for one automatic turn.
 *
 * Deliberately does NOT carry a headroom number. The obvious candidate — "turns
 * still available" — is zero at exactly the moment anything would want to read
 * it, because that is what a refusal means, so it would be a field that is
 * either uninteresting or constant. What a reader of the notice actually needs
 * is WHICH cap refused, since the two send them to different settings.
 */
export interface BudgetDecision {
  allowed: boolean;
  /** Set only when `allowed` is false: which cap said no. */
  scope?: BudgetRefusalScope;
}

/** The two live caps, read per call so a change in Settings takes effect at once. */
export interface TurnBudgetLimits {
  /** Automatic turns any ONE room may run per window. */
  perRoom: () => number;
  /** Automatic turns the whole install may run per window, across every room. */
  global: () => number;
}

/**
 * A rolling count of automatic turns, per room and in total.
 *
 * Insertion-ordered `Map`, so the least recently touched room is always the
 * first key — which is what makes the eviction above one `keys().next()`.
 */
export class RoomTurnBudget {
  private readonly limits: TurnBudgetLimits;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly perRoom = new Map<string, number[]>();
  private globalRuns: number[] = [];

  /**
   * @param opts.limits - The two live caps.
   * @param opts.now - Clock, injectable so a test can move a window without sleeping.
   * @param opts.windowMs - Window length; defaults to one hour.
   */
  constructor(opts: { limits: TurnBudgetLimits; now?: () => number; windowMs?: number }) {
    this.limits = opts.limits;
    this.now = opts.now ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? WINDOW_MS;
  }

  /**
   * Claim one automatic turn for a room.
   *
   * Reserves on success, so two turns starting in the same tick cannot both
   * spend the last unit. The global cap is checked FIRST: when the install is
   * out of budget the answer is the same for every room, and reporting the room
   * as the reason would send someone to the wrong setting.
   *
   * @param roomId - The room about to run a turn.
   */
  tryReserve(roomId: string): BudgetDecision {
    const at = this.now();
    const floor = at - this.windowMs;
    this.globalRuns = this.globalRuns.filter((t) => t > floor);
    const room = (this.perRoom.get(roomId) ?? []).filter((t) => t > floor);

    if (this.globalRuns.length >= this.limits.global()) {
      this.store(roomId, room);
      return { allowed: false, scope: 'global' };
    }
    if (room.length >= this.limits.perRoom()) {
      this.store(roomId, room);
      return { allowed: false, scope: 'room' };
    }

    room.push(at);
    this.globalRuns.push(at);
    this.store(roomId, room);
    return { allowed: true };
  }

  /** Write a room's pruned window back, re-inserting it as most recently used. */
  private store(roomId: string, window: number[]): void {
    this.perRoom.delete(roomId);
    this.perRoom.set(roomId, window);
    if (this.perRoom.size > TRACKED_ROOMS) {
      const oldest = this.perRoom.keys().next().value;
      if (oldest !== undefined) this.perRoom.delete(oldest);
    }
  }
}
