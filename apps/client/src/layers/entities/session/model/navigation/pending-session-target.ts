/**
 * The agent a click is on its way to, while the app finds out which chat to open.
 *
 * Clicking an agent this window has not opened yet has to ask the server which
 * chat to land on, and until the answer comes back nothing on screen moved: the
 * click looked dead (DOR-2891). This holds the directory being switched to, so
 * the row that was clicked can show it took the click straight away.
 *
 * One target at a time, because only the latest click matters: a second click
 * replaces the first, and the first one's clear then does nothing.
 *
 * @module entities/session/model/navigation/pending-session-target
 */
import { create } from 'zustand';

interface PendingSessionTargetState {
  /** The directory being switched to, or null when nothing is pending. */
  target: string | null;
  /** Which mark set the current target, so a stale clear cannot erase a newer one. */
  token: number;
}

const usePendingStore = create<PendingSessionTargetState>(() => ({ target: null, token: 0 }));

/**
 * How long a click may light its row while the lookup is out. A lookup that
 * never answers would otherwise keep the clicked row lit, and the chat that is
 * actually open dark, until some other navigation happened.
 */
export const PENDING_TARGET_MAX_MS = 10_000;

/**
 * Mark `target` as the place a click is heading.
 *
 * @param target - The agent directory being switched to.
 * @returns A clear function. It removes the mark only while this call's mark is
 *   still the current one, so it is safe to call late or twice. The mark also
 *   clears itself after {@link PENDING_TARGET_MAX_MS}.
 */
export function markPendingSessionTarget(target: string): () => void {
  const token = usePendingStore.getState().token + 1;
  usePendingStore.setState({ target, token });
  const clear = () => {
    if (usePendingStore.getState().token === token) usePendingStore.setState({ target: null });
  };
  setTimeout(clear, PENDING_TARGET_MAX_MS);
  return clear;
}

/**
 * Drop whatever is pending, whichever click set it. Called when any navigation
 * starts: from then on the router's location says what is open.
 */
export function clearPendingSessionTarget(): void {
  if (usePendingStore.getState().target !== null) usePendingStore.setState({ target: null });
}

/** The directory a click is heading to right now, or null. */
export function usePendingSessionTarget(): string | null {
  return usePendingStore((state) => state.target);
}

/**
 * Read the pending target outside React.
 *
 * @internal Exported for tests.
 */
export function getPendingSessionTarget(): string | null {
  return usePendingStore.getState().target;
}
