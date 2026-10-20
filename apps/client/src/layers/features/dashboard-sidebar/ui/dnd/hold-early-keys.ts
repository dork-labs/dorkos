/**
 * The keys a reader presses in the instant after a keyboard drag lifts, kept
 * for dnd-kit until it is listening.
 *
 * @module features/dashboard-sidebar/ui/dnd/hold-early-keys
 */

/**
 * Hold every keydown until dnd-kit's keyboard sensor is listening, then hand
 * them to it in the order they were pressed.
 *
 * **Why this exists.** `KeyboardSensor` adds its own `keydown` listener in a
 * `setTimeout` after the lift, so the Space that picked the row up is not read
 * as the Space that puts it down. The gap is one task, but the lift also
 * renders the whole panel, and while that runs the browser serves waiting
 * input before waiting timers. So a key pressed right after the lift — an
 * Escape to change your mind, the first arrow — arrived before anything was
 * listening and was simply lost. With an Escape lost the row stayed in the
 * air; with the arrows lost it never moved. Measured in a browser: a timer
 * queued at the lift fired 20 to 40ms later, and an Escape pressed inside that
 * window left the drag running.
 *
 * Held keys are stopped where they land and replayed on the element they were
 * aimed at once the sensor's timer has run — a timer queued inside a timer
 * runs after every timer queued before it, which is what puts the replay
 * behind the sensor's own.
 *
 * @param target - The document the drag is in.
 */
export function holdEarlyKeys(target: Document): void {
  const view = target.defaultView;
  if (view === null) return;
  const held: KeyboardEvent[] = [];
  const hold = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    held.push(event);
  };
  view.addEventListener('keydown', hold, true);

  /** Hand the held keys over one task at a time, the way a person presses them. */
  const replay = () => {
    const event = held.shift();
    if (event === undefined) return;
    const aimedAt = event.target instanceof view.Node ? event.target : target;
    aimedAt.dispatchEvent(
      new view.KeyboardEvent('keydown', {
        key: event.key,
        code: event.code,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    );
    // Its own task each: a key the sensor acts on renders the panel, and the
    // next key has to be measured against where that left the row, not against
    // where every held key found it.
    if (held.length > 0) view.setTimeout(replay);
  };

  view.setTimeout(() => {
    view.setTimeout(() => {
      // Off before the replay, so the replayed keys go straight through.
      view.removeEventListener('keydown', hold, true);
      replay();
    });
  });
}
