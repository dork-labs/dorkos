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
 * open changes nothing. That is the honest answer to a duplicate or foreign
 * close, and it keeps the count from going negative and disarming the guard on
 * a live turn.
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
 * The set of turn windows open on one session, as an arm/disarm signal.
 *
 * Wire {@link TurnWindowSignal.opened} to `SessionTurnWindows`' `onWindowOpen`
 * and {@link TurnWindowSignal.closed} to its `onWindowClose`, then hand the
 * signal to `withStallGuard` as `windows`. Both are bound methods, so they can
 * be passed straight across as callbacks.
 */
export class TurnWindowSignal {
  private readonly open = new Set<object>();
  private readonly watchers = new Set<TurnWindowWatcher>();

  /**
   * A turn window opened. Idempotent per window.
   *
   * @param window - The window that opened, used only for its identity
   */
  readonly opened = (window: object): void => {
    const wasOpen = this.open.size > 0;
    this.open.add(window);
    if (!wasOpen && this.open.size > 0) this.announce(true);
  };

  /**
   * A turn window closed and its stream has ended. A window this signal never
   * saw open is ignored rather than counted.
   *
   * @param window - The window that closed, used only for its identity
   */
  readonly closed = (window: object): void => {
    if (!this.open.delete(window)) return;
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

  /** Tell every watcher, over a copy so one that unsubscribes cannot skip another. */
  private announce(open: boolean): void {
    for (const watcher of [...this.watchers]) watcher(open);
  }
}
