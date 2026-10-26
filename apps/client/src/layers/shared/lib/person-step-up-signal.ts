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
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Ask the person to confirm it is them, or join the ask already up.
 *
 * @returns `true` once they confirmed, `false` when they cancelled.
 */
export function requestPersonStepUp(): Promise<boolean> {
  return new Promise((resolve) => {
    if (waiting) {
      waiting.push(resolve);
      return;
    }
    waiting = [resolve];
    notify();
  });
}

/**
 * Close the ask and tell everyone waiting how it ended.
 *
 * @param confirmed - Whether the person confirmed it was them.
 */
export function finishPersonStepUp(confirmed: boolean): void {
  const resolvers = waiting;
  if (!resolvers) return;
  waiting = null;
  notify();
  resolvers.forEach((resolve) => resolve(confirmed));
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
