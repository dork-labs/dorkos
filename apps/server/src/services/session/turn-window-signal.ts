/**
 * Which turn windows are open right now — the signal the stall watchdog's
 * inactivity clock follows (spec `persistent-session-runtime` §4.3, task 3.7).
 *
 * ## Why the watchdog needs to be told
 *
 * `withStallGuard` bounds SILENCE inside a turn, and resume-per-message made
 * that bound free to take: the generator it wrapped was born with the turn and
 * died with it, so "the stream is quiet" and "the turn is quiet" were the same
 * sentence. A pump pulls them apart — one process, many turns, and long
 * legitimate quiet in between. A guard left spanning the pump would read a WARM
 * session's healthy idleness as a stalled turn and interrupt a process nobody
 * was waiting on. Silence with NO window open is the idle timer's business
 * (`session-pump-registry.ts`), and that bound is both the right mechanism and
 * the shorter one anyway: five minutes against ten.
 *
 * So the guard stops owning its own lifetime and takes it from here: armed
 * while a turn window is open, disarmed while none is.
 *
 * ## Open windows are COUNTED, never flagged
 *
 * More than one window can be open at once, and this is the detail a boolean
 * gets wrong. `SessionTurnWindows` opens a synthetic `origin: 'runtime'` window
 * for a `result` nobody dispatched, and closes it, while the dispatched window
 * it did not answer stays open (`session-turn-windows.ts`, the correlation
 * table). A flag would be cleared by that close and the dispatched turn would
 * run unguarded for the rest of its life. A count is only cleared when the last
 * window closes, which is exactly when there is no turn left to guard.
 *
 * Windows are keyed by IDENTITY, so a close for a window this signal never saw
 * open cannot decrement anything. That keeps the count from going negative and
 * disarming the guard on a live turn.
 *
 * ## A close can arrive BEFORE its own open, and it is tolerated here
 *
 * `SessionTurnWindows` registers a window before awaiting `pump.dispatch` but
 * announces it only after that dispatch is ACCEPTED, and the pump's read loop
 * runs during the await — so a `result` landing in that gap closes the window
 * before the dispatch that opened it returns, and the observers fire close then
 * open for one and the same window. Reproduced against the real windower.
 *
 * Merely ignoring the unseen close is not enough: the open behind it would then
 * be taken at face value, the count would sit at one for good, and the guard
 * would stay armed on a process with no turn running — the exact failure this
 * signal exists to prevent, re-entered through the other door. So an unseen
 * close leaves a TOMBSTONE, and the matching open is cancelled by it instead of
 * counting. One-shot and keyed by identity: it cancels that window's open and
 * nothing else, so a window opened later on its own merits is unaffected.
 *
 * **The windower's ordering is deliberate and must not be "fixed" instead.**
 * Announcing before acceptance is what the P3.3 review forbade: `onWindowOpen`
 * is where a window is projected, and the `turn_start` it mints RETIRES the
 * person's durable queue rows. Announce first and a REFUSED dispatch retires a
 * row for a turn that never ran — the message is lost, with an empty turn on
 * the stream where it should have been. Announce-after-acceptance is the rule;
 * tolerating the inversion belongs to the observer, which is here.
 *
 * Tombstones are bounded ({@link MAX_CANCELLED_WINDOWS}, oldest evicted first)
 * for the same reason the windower bounds its held buffer: a tombstone can only
 * ever be claimed by ONE future open, and window records are freshly minted per
 * dispatch, so one that is never claimed would sit here for the life of the warm
 * process. The bound is safe because the inversion is claimed within a single
 * `dispatch` call, and the windower serializes dispatches — at most one
 * tombstone is ever genuinely outstanding, against a cap of thirty-two. Past the
 * cap the oldest is simply forgotten, which restores the old behavior for a
 * cancellation nobody claimed and can never affect a live one.
 *
 * ## Runtime windows arm it too
 *
 * A window nobody dispatched is still a turn on the durable stream: it mints a
 * `turn_start`, it pins the projector to `streaming`, and if it goes dark it is
 * stuck in exactly the way the watchdog exists to end. Its origin changes who
 * asked for the turn, not whether a dark one has to be closed — so this signal
 * does not distinguish them, and the counting rule above is what keeps a
 * short-lived runtime window from disarming somebody else's turn.
 *
 * @module services/session/turn-window-signal
 */

/** Told when the last window closes (`false`) or the first opens (`true`). */
export type TurnWindowWatcher = (open: boolean) => void;

/**
 * How many close-before-open cancellations are remembered at once.
 *
 * Thirty-two against a genuine worst case of one: the windower serializes
 * dispatches, so only the window currently being dispatched can have its close
 * beat its open, and that open follows within the same call. The cap exists so
 * a pathological producer cannot grow the set without limit, not because the
 * real one ever approaches it.
 */
export const MAX_CANCELLED_WINDOWS = 32;

/**
 * The set of turn windows open on one session, as an arm/disarm signal.
 *
 * Wire {@link TurnWindowSignal.opened} to `SessionTurnWindows`' `onWindowOpen`
 * and {@link TurnWindowSignal.closed} to its `onWindowClose`, then hand the
 * signal to `withStallGuard` as `windows`. Both are bound methods, so they can
 * be passed straight across as callbacks.
 *
 * **Nothing constructs one yet (task 3.10).** The persistent pump was expected
 * to be the first caller and is not: it runs one turn per `StreamEvent` stream,
 * so `withStallGuard` already has the turn lifetime it needs and handing it
 * this signal would only disarm the clock during a launch. The genuine first
 * caller is P4's `deliverIntoTurn`, where a steer's events arrive on a stream
 * that outlives the turn that opened it — which is when "which windows are open
 * right now" stops being answerable from the stream alone.
 */
export class TurnWindowSignal {
  private readonly open = new Set<object>();
  private readonly watchers = new Set<TurnWindowWatcher>();
  /** Windows already closed when their open arrives. Insertion-ordered, for FIFO eviction. */
  private readonly cancelled = new Set<object>();

  /**
   * A turn window opened. Idempotent per window, and cancelled outright when
   * this window's close was announced first — that turn is already over.
   *
   * @param window - The window that opened, used only for its identity
   */
  readonly opened = (window: object): void => {
    if (this.cancelled.delete(window)) return;
    const wasOpen = this.open.size > 0;
    this.open.add(window);
    if (!wasOpen) this.announce(true);
  };

  /**
   * A turn window closed and its stream has ended. A window this signal never
   * saw open leaves a one-shot cancellation instead of counting down, so the
   * open still on its way cannot leave the count stuck at one forever.
   *
   * @param window - The window that closed, used only for its identity
   */
  readonly closed = (window: object): void => {
    if (!this.open.delete(window)) {
      this.cancel(window);
      return;
    }
    if (this.open.size === 0) this.announce(false);
  };

  /** True while at least one turn window is open — while there is a turn to guard. */
  get isOpen(): boolean {
    return this.open.size > 0;
  }

  /**
   * How many watchers are subscribed. A finished guard that never unsubscribed
   * would be retained here for the life of the warm process, so this is the
   * leak the tests watch.
   *
   * @internal
   */
  get watcherCount(): number {
    return this.watchers.size;
  }

  /**
   * Follow the edges of this signal. The watcher hears the FIRST open and the
   * LAST close, never the windows in between, because those are the only two
   * moments an arm/disarm decision changes.
   *
   * A watcher must not throw: it is called from the pump's synchronous read
   * loop, by way of the windower's observers.
   *
   * @param watcher - Called with `true` on arm and `false` on disarm
   * @returns Unsubscribe; call it when the watcher goes away
   */
  watch(watcher: TurnWindowWatcher): () => void {
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  /**
   * Remember that this window is already over, evicting the oldest
   * cancellation when the bound is reached. A `Set` iterates in insertion
   * order, so its first entry is the oldest.
   */
  private cancel(window: object): void {
    if (this.cancelled.size >= MAX_CANCELLED_WINDOWS) {
      const oldest = this.cancelled.values().next().value;
      if (oldest !== undefined) this.cancelled.delete(oldest);
    }
    this.cancelled.add(window);
  }

  /** Tell every watcher, over a copy so one that unsubscribes cannot skip another. */
  private announce(open: boolean): void {
    for (const watcher of [...this.watchers]) watcher(open);
  }
}
