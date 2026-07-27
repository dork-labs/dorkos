/**
 * A ceiling on what one room can cost, counted without asking who is calling.
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
 * So the room path carries a second bound that does not depend on the answer to
 * "who is this". It counts **every automatic turn the room runs**, whoever
 * appeared to ask for it, and stops at the number. A caller who defeats the
 * cascade guard by claiming to be human still hits this.
 *
 * Depth-and-ancestry is what keeps a healthy room from wasting calls. This is
 * what keeps a compromised one from emptying a wallet. Neither replaces the
 * other, and the reason they coexist is written here so the next reader does
 * not delete one as redundant.
 *
 * ## What it deliberately is not
 *
 * **In-memory, and it resets when the server restarts.** That is a real
 * limitation and it is the right trade: the loop this bounds runs in seconds,
 * so a window that survives a restart buys almost nothing, while a durable
 * counter would mean a table and a write on the hot path of every turn. The
 * durable half of the story is the cascade columns, which are on every entry.
 *
 * @module server/services/rooms/turn-budget
 */

/** One hour, the window the config field is denominated in. */
const WINDOW_MS = 60 * 60_000;

/**
 * How many rooms to keep windows for before dropping the least recently
 * touched. A room's window is at most `maxPerWindow` timestamps, so this bounds
 * the whole structure; without it, a long-lived server that visited many rooms
 * would hold a growing map of empty arrays.
 */
const TRACKED_ROOMS = 256;

/** Outcome of asking for one automatic turn. */
export interface BudgetDecision {
  allowed: boolean;
  /** Turns still available in the current window, after this decision. */
  remaining: number;
}

/**
 * A rolling per-room count of automatic turns.
 *
 * Insertion-ordered `Map`, so the least recently touched room is always the
 * first key — which is what makes the eviction above one `keys().next()`.
 */
export class RoomTurnBudget {
  private readonly maxPerWindow: () => number;
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly runs = new Map<string, number[]>();

  /**
   * @param opts.maxPerWindow - The live cap (`rooms.maxAutomaticTurnsPerHour`).
   *   Read per call, so raising it in Settings takes effect immediately.
   * @param opts.now - Clock, injectable so a test can move a window without sleeping.
   * @param opts.windowMs - Window length; defaults to one hour.
   */
  constructor(opts: { maxPerWindow: () => number; now?: () => number; windowMs?: number }) {
    this.maxPerWindow = opts.maxPerWindow;
    this.now = opts.now ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? WINDOW_MS;
  }

  /**
   * Claim one automatic turn for a room.
   *
   * Reserves on success, so two turns starting in the same tick cannot both
   * spend the last unit of budget.
   *
   * @param roomId - The room about to run a turn.
   */
  tryReserve(roomId: string): BudgetDecision {
    const max = this.maxPerWindow();
    const recent = this.recent(roomId);

    if (recent.length >= max) return { allowed: false, remaining: 0 };

    recent.push(this.now());
    this.store(roomId, recent);
    return { allowed: true, remaining: Math.max(0, max - recent.length) };
  }

  /**
   * Turns still available to a room in the current window, reserving nothing.
   *
   * @param roomId - The room.
   */
  remaining(roomId: string): number {
    return Math.max(0, this.maxPerWindow() - this.recent(roomId).length);
  }

  /** This room's timestamps inside the window, oldest first. */
  private recent(roomId: string): number[] {
    const floor = this.now() - this.windowMs;
    return (this.runs.get(roomId) ?? []).filter((at) => at > floor);
  }

  /** Write a room's pruned window back, re-inserting it as most recently used. */
  private store(roomId: string, window: number[]): void {
    this.runs.delete(roomId);
    this.runs.set(roomId, window);
    if (this.runs.size > TRACKED_ROOMS) {
      const oldest = this.runs.keys().next().value;
      if (oldest !== undefined) this.runs.delete(oldest);
    }
  }
}
