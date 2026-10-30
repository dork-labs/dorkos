/**
 * The owner's one password step-up at this computer, as an app-wide signal
 * (DOR-3330).
 *
 * `fetchJSON` asks for it when a person-only action answers
 * `401 person_session_required`, waits, and retries once the person has
 * confirmed it is them. The `features/auth` host shows the dialog and
 * answers. Every request that hits the same refusal while the dialog is up
 * waits on that one dialog, so the person is asked once.
 *
 * Plain module state with a `useSyncExternalStore`-compatible pair, like
 * `./auth-signal`, so the base layer stays free of React.
 *
 * @module shared/lib/person-step-up-signal
 */

type Listener = () => void;

/** Everyone waiting on the dialog that is up, or `null` when none is. */
let waiting: Array<(confirmed: boolean) => void> | null = null;
/** Whether the ask that is up may be cancelled: only if every asker allows it. */
let dismissible = true;
/** What had focus when the ask opened, to give it back when it closes. */
let openedFrom: HTMLElement | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/** How an ask is shown. */
export interface PersonStepUpOptions {
  /**
   * Whether the person may cancel it, leaving the action undone. True before
   * a person-only action; false before the first chat, where there is
   * nothing to go back to.
   */
  dismissible?: boolean;
}

/**
 * Ask the person to confirm it is them, or join the ask already up.
 *
 * @param options - See {@link PersonStepUpOptions}.
 * @returns `true` once they confirmed, `false` when they cancelled.
 */
export function requestPersonStepUp(options: PersonStepUpOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const mayCancel = options.dismissible ?? true;
    if (waiting) {
      waiting.push(resolve);
      if (!mayCancel && dismissible) {
        dismissible = false;
        notify();
      }
      return;
    }
    waiting = [resolve];
    dismissible = mayCancel;
    openedFrom =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    notify();
  });
}

/**
 * Close the ask, tell everyone waiting how it ended, and give focus back to
 * whatever had it when the ask opened.
 *
 * @param confirmed - Whether the person confirmed it was them.
 */
export function finishPersonStepUp(confirmed: boolean): void {
  const resolvers = waiting;
  if (!resolvers) return;
  waiting = null;
  const back = openedFrom;
  openedFrom = null;
  notify();
  resolvers.forEach((resolve) => resolve(confirmed));
  if (back?.isConnected) queueMicrotask(() => back.focus());
}

/** Whether the ask that is up may be cancelled. */
export function getPersonStepUpDismissible(): boolean {
  return dismissible;
}

/** Whether the ask is up. */
export function getPersonStepUpOpen(): boolean {
  return waiting !== null;
}

/** Subscribe to the ask opening and closing; returns an unsubscribe function. */
export function subscribePersonStepUp(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
