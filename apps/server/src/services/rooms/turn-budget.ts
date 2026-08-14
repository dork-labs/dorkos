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
 * `X-DorkOS-Agent` header as the owner's own human author, and `sessionGate` is a
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
 * real mount, a cap of 2/room bought 16 turns across 8 channels. That is not a
 * defect in the per-room cap — it does exactly what it says — it is the
 * difference between bounding a room and bounding a wallet.
 *
 * **Threads used to be the cheaper lever and are not any more.** While a thread
 * was a child room it came with a window of its own, and five threads off one
 * parent bought 12 turns against a cap of 2. Under ADR 260728-022013 a thread
 * reply is an entry in its channel, so one window now covers a channel and
 * everything threaded inside it. `rooms-cascade.test.ts` runs that same script
 * — five distinct roots, one reply into each — and measures 2.
 *
 * The global cap is what makes "the ceiling on what this can cost you" true.
 * The per-room cap stays because it is what keeps one runaway room from eating
 * the whole global allowance and starving every other room.
 *
 * ## Durable, so an hour means an hour (DOR-1205)
 *
 * Both windows are written to `room_turn_spend` and read back at construction,
 * so a restart inside a busy hour resumes the ceilings it left rather than
 * handing every room a fresh allowance. That closes what this module used to
 * document as a deliberate residual: `POST /api/admin/restart` sits behind the
 * same pass-through gate in the default posture and is rate-limited to 3 per 5
 * minutes, so a caller willing to use it could clear both windows roughly 36
 * times an hour. It cannot any more.
 *
 * The old note said the durable counter was not worth "a write on the hot path
 * of every turn". It costs one INSERT and one indexed DELETE per turn ACTUALLY
 * RUN, against a table holding at most the last hour of spends — beside a turn
 * that is about to spend seconds of model time. Nothing is written on a refusal
 * and nothing is read after boot: {@link RoomTurnBudget.tryReserve} and
 * {@link RoomTurnBudget.remaining} both decide from the in-memory windows, so
 * the dispatch path runs no query at all.
 *
 * **Durability is not the reason to trust the ceiling, though, and the honest
 * statement about a deliberate caller has not changed**: a caller who can omit
 * the `X-DorkOS-Agent` header already has a shell on this machine, and a shell
 * can spend the model budget directly without going near a room. DOR-505
 * (turning login on) is still the actual fix for that one.
 *
 * What these caps completely bound is the case with no attacker in it: two
 * `always` agents talking each other in circles, which is a configuration a
 * reasonable person reaches on purpose and which costs real money for no work.
 * That is the common case, it is exactly the case that survives a restart —
 * misconfigured agents are still misconfigured after one — and it is worth
 * having on its own. See ADR 260726-170127.
 *
 * ## What it deliberately is not
 *
 * **Not a spend log.** Rows older than the window are deleted as new ones land;
 * nothing here can answer "how much did this room cost last Tuesday". This is a
 * counter, and the activity log is where history lives.
 *
 * @module server/services/rooms/turn-budget
 */
import { roomTurnSpend, and, gt, lte, type Db } from '@dorkos/db';
import { logger } from '../../lib/logger.js';

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
 * A rolling count of automatic turns, per room and in total, held in memory and
 * written down.
 *
 * Insertion-ordered `Map`, so the least recently touched room is always the
 * first key — which is what makes the eviction above one `keys().next()`.
 *
 * **The in-memory windows are the whole decision; the table is how they are
 * recovered.** Every read of a window is a read of these two fields, and the
 * database is touched exactly twice in a process's life per turn spent: once at
 * construction, to load the hour that was already running, and once per
 * reservation, to record it. A budget whose database is unavailable therefore
 * still bounds this process — it just cannot hand what it counted to the next
 * one, which is what the whole install did before DOR-1205.
 */
export class RoomTurnBudget {
  private readonly limits: TurnBudgetLimits;
  private readonly db: Db;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly perRoom = new Map<string, number[]>();
  private globalRuns: number[] = [];

  /**
   * Load the window this install is already inside, then bound what is left of
   * it.
   *
   * @param opts.limits - The two live caps.
   * @param opts.db - Where the spent window is written, so it survives a restart.
   * @param opts.now - Clock, injectable so a test can move a window without sleeping.
   * @param opts.windowMs - Window length; defaults to one hour.
   */
  constructor(opts: { limits: TurnBudgetLimits; db: Db; now?: () => number; windowMs?: number }) {
    this.limits = opts.limits;
    this.db = opts.db;
    this.now = opts.now ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? WINDOW_MS;
    this.hydrate();
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
    this.record(roomId, at, floor);
    return { allowed: true };
  }

  /**
   * How many automatic turns are still available, without claiming one.
   *
   * {@link BudgetDecision} deliberately carries no headroom, because a refusal
   * always has zero of it. This answers the other question — an agent mid-turn
   * asking what is left, which is what `room_context.budget` reports so it can
   * spend deliberately (the room-participation spec §6.3, on the precedent
   * `relay_context.callBudgetRemaining` set).
   *
   * A pure read: it prunes its view of both windows to the current hour but
   * writes nothing back and reserves nothing, so calling it can never make a
   * turn unaffordable.
   *
   * @param roomId - The room being asked about.
   */
  remaining(roomId: string): { room: number; global: number } {
    const floor = this.now() - this.windowMs;
    const global = this.globalRuns.filter((t) => t > floor).length;
    const room = (this.perRoom.get(roomId) ?? []).filter((t) => t > floor).length;
    return {
      room: Math.max(0, this.limits.perRoom() - room),
      global: Math.max(0, this.limits.global() - global),
    };
  }

  /**
   * Load the hour that was already running when this process started.
   *
   * One indexed range read of `at > floor`, at construction and never again.
   * Rows arrive oldest-first so the per-room map is rebuilt in the same
   * least-recently-touched order {@link RoomTurnBudget.store} maintains, and the
   * same eviction applies — a machine that visited 600 rooms in an hour comes
   * back holding the 256 it touched last, which is the identical trade the live
   * map makes, in the identical direction (an evicted room reads as unspent).
   * The GLOBAL window is rebuilt in full, because that is the one that has to be
   * exact.
   *
   * **A spend stamped in the future is not a spend from this hour.** The window
   * is bounded at BOTH ends, because only the lower bound is self-healing: a
   * clock that jumps backwards (an NTP correction, a VM resumed from a snapshot)
   * leaves rows the prune's `at <= floor` will not delete and hydration's
   * `at > floor` would happily count, so a room's ceiling would stay spent until
   * wall clock caught up — and unlike the in-memory version, a restart would no
   * longer heal it. Ignoring them costs nothing: a row from the future ages into
   * the window on its own if the clock was right, and is pruned if it was not.
   *
   * **Fails open, loudly.** A budget that cannot read its own table starts empty
   * — which is exactly the pre-DOR-1205 behaviour, and the alternative is a
   * server that will not boot because a counter is unreadable.
   */
  private hydrate(): void {
    const at = this.now();
    const floor = at - this.windowMs;
    let rows: { roomId: string; at: number }[];
    try {
      rows = this.db
        .select({ roomId: roomTurnSpend.roomId, at: roomTurnSpend.at })
        .from(roomTurnSpend)
        .where(and(gt(roomTurnSpend.at, floor), lte(roomTurnSpend.at, at)))
        .orderBy(roomTurnSpend.at)
        .all();
    } catch (err) {
      logger.warn('[rooms] could not read the turn budget already spent this hour', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const row of rows) {
      this.globalRuns.push(row.at);
      const window = this.perRoom.get(row.roomId) ?? [];
      window.push(row.at);
      this.store(row.roomId, window);
    }
  }

  /**
   * Write one spent turn down, and drop what has aged out of the window.
   *
   * The whole durable cost of a turn: one INSERT and one indexed DELETE, on the
   * path of a turn that is about to spend seconds of model time. Pruning HERE
   * rather than on a timer is what keeps the table at most one hour of spends
   * without anything having to remember to sweep it.
   *
   * **A write that fails does not refuse the turn.** The reservation is already
   * made in memory and this process will honour it; all that is lost is handing
   * the count to the next process, which is what every process did before
   * DOR-1205. Refusing an agent's reply because a counter could not be persisted
   * would be a worse trade in both directions.
   *
   * @param roomId - The room that spent it.
   * @param at - When, epoch ms.
   * @param floor - The oldest instant still inside the window.
   */
  private record(roomId: string, at: number, floor: number): void {
    try {
      this.db.insert(roomTurnSpend).values({ roomId, at }).run();
      this.db.delete(roomTurnSpend).where(lte(roomTurnSpend.at, floor)).run();
    } catch (err) {
      logger.warn('[rooms] could not record a turn against the durable budget', {
        roomId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
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
