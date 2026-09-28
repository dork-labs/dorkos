/**
 * "Continue here anyway", remembered for one limit episode (decision Q11).
 *
 * A moved session's composer stays closed until the person chooses to write
 * there anyway, and that choice lasts for THIS episode only: it is keyed by the
 * session and the limit's `since`, so a new limit (a new `since`) asks again.
 * In memory, never saved to the server; the banner and the composer both read
 * it, so the one choice opens the one box.
 *
 * @module features/continue-on-account/model/continue-here-store
 */
import { create } from 'zustand';

interface ContinueHereState {
  /** Episode keys (`<sessionId>\u0000<since>`) the person chose to continue here. */
  episodes: ReadonlySet<string>;
  /** Remember the choice for one episode. */
  choose: (key: string) => void;
}

const useContinueHereStore = create<ContinueHereState>((set) => ({
  episodes: new Set(),
  choose: (key) =>
    set((state) =>
      state.episodes.has(key) ? state : { episodes: new Set([...state.episodes, key]) }
    ),
}));

/** The key one limit episode of one session is remembered under. */
function episodeKey(sessionId: string, since: string): string {
  return `${sessionId}\u0000${since}`;
}

/**
 * Whether the person chose "Continue here anyway" for this session's current
 * limit episode, and the way to choose it.
 *
 * @param sessionId - The session.
 * @param since - When the current limit was hit, or `null` with no limit.
 */
export function useContinuedHere(
  sessionId: string,
  since: string | null
): { continuedHere: boolean; continueHere: () => void } {
  const key = since === null ? null : episodeKey(sessionId, since);
  const continuedHere = useContinueHereStore((state) => key !== null && state.episodes.has(key));
  const choose = useContinueHereStore((state) => state.choose);
  return {
    continuedHere,
    continueHere: () => {
      if (key !== null) choose(key);
    },
  };
}
