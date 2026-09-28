/**
 * How the session's composer reads while its account is out (spec
 * `claude-account-ui` §6.7, the banner table's Composer column).
 *
 * @module features/continue-on-account/model/use-limit-composer
 */
import { useSessionAccount } from '@/layers/features/status';
import { useNow } from '@/layers/shared/model';
import { limitComposerState, type LimitComposerState } from '../lib/limit-banner';
import { useContinuedHere } from './continue-here-store';

/**
 * Whether the session's composer may send, and the words it shows while it
 * waits: paused while the account is out and something is known to end the
 * wait, open once the reset is ready, closed after a move until the person
 * chose "Continue here anyway" for this episode, and open once the reset has
 * passed. Reads the same limit and the
 * same choice as the banner, so the two never disagree. Makes no request.
 *
 * @param sessionId - The session.
 */
export function useLimitComposer(sessionId: string): LimitComposerState {
  const { limit } = useSessionAccount(sessionId, { fetchUsage: false });
  const { continuedHere } = useContinuedHere(sessionId, limit?.since ?? null);
  // A minute clock, so the box opens once the reset passes even though the
  // server leaves the limit as it is until the next turn.
  const tick = useNow();
  return limitComposerState(limit, continuedHere, new Date(tick));
}

/**
 * Whether the session has a usage limit, so its out-of-usage banner shows.
 * The chat panel reads it to keep a limited turn to one notice, not two.
 * Makes no request.
 *
 * @param sessionId - The session.
 */
export function useSessionHasLimit(sessionId: string): boolean {
  return useSessionAccount(sessionId, { fetchUsage: false }).limit !== null;
}
