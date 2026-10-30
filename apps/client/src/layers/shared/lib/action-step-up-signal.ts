/**
 * "Confirm it's you" before one sensitive action, as an app-wide signal
 * (DOR-3234).
 *
 * A guarded route holds its action and answers `428 step_up_required` with a
 * held-action id. The window's `fetch` (`./person-aware-fetch`) asks for the
 * sheet with that id and waits; the `features/auth` host shows it and answers
 * with how it ended. Each held action gets its own sheet, one at a time, in
 * the order they were asked.
 *
 * Plain module state with a `useSyncExternalStore`-compatible pair, like
 * `./person-step-up-signal`, so the base layer stays free of React.
 *
 * @module shared/lib/action-step-up-signal
 */

type Listener = () => void;

/** How a sheet ended. */
export type ActionStepUpOutcome =
  /** The person confirmed, and the server ran the action: its own answer. */
  | { kind: 'confirmed'; status: number; result: unknown }
  /** Cancelled, refused or failed: nothing ran. */
  | { kind: 'not-confirmed' }
  /** It expired: ask for the action again, which holds it afresh. */
  | { kind: 'ask-again' };

interface Ask {
  heldActionId: string;
  resolve: (outcome: ActionStepUpOutcome) => void;
  /** What had focus when it opened, to give it back when it closes. */
  openedFrom: HTMLElement | null;
}

/** The asks waiting, the first one showing. */
const queue: Ask[] = [];
const listeners = new Set<Listener>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

/**
 * Ask the person to confirm one held action.
 *
 * @param heldActionId - The id the guarded route answered with.
 * @returns How the sheet ended.
 */
export function requestActionStepUp(heldActionId: string): Promise<ActionStepUpOutcome> {
  return new Promise((resolve) => {
    const openedFrom =
      typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    queue.push({ heldActionId, resolve, openedFrom });
    if (queue.length === 1) notify();
  });
}

/**
 * Close the sheet that is showing, say how it ended, and show the next one.
 *
 * @param outcome - How it ended.
 */
export function finishActionStepUp(outcome: ActionStepUpOutcome): void {
  const ask = queue.shift();
  if (!ask) return;
  notify();
  ask.resolve(outcome);
  if (queue.length === 0 && ask.openedFrom?.isConnected) {
    const back = ask.openedFrom;
    queueMicrotask(() => back.focus());
  }
}

/** The held action whose sheet is showing, or `null`. */
export function getActionStepUpShowing(): string | null {
  return queue[0]?.heldActionId ?? null;
}

/** Subscribe to the sheet opening, changing and closing; returns an unsubscribe function. */
export function subscribeActionStepUp(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
