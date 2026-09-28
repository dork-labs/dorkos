/**
 * The picker's three writes: carry the work over, stop an automatic move
 * before choosing, and wait for the reset instead.
 *
 * None of them retries: a refusal carries the server's own words, which the
 * picker shows as they are.
 *
 * @module features/continue-on-account/model/use-continue-session
 */
import { useMutation } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';

/** What {@link useContinueSession} posts. */
export interface ContinueTarget {
  /** The account's registry id. */
  account: string;
  /** The account's runtime, only for a row of another runtime. */
  runtime?: string;
}

/**
 * Carry a limited session over to another account (`POST
 * /api/sessions/:id/continue`). Resolves with the new session's id when the
 * server started one, or with no id when flow took the move over.
 *
 * @param sessionId - The limited session.
 */
export function useContinueSession(sessionId: string) {
  const transport = useTransport();
  return useMutation({
    mutationFn: (target: ContinueTarget) => transport.continueSession(sessionId, target),
    retry: false,
  });
}

/**
 * Stop an automatic move before the person chooses (`POST
 * /api/sessions/:id/continue/cancel`), so nothing moves the work to its own
 * target while the picker is open.
 *
 * @param sessionId - The limited session.
 */
export function useCancelAutoContinue(sessionId: string) {
  const transport = useTransport();
  return useMutation({
    mutationFn: () => transport.cancelAutoContinue(sessionId),
    retry: false,
  });
}

/**
 * Wait for the account to reset instead of moving (`POST
 * /api/sessions/:id/wait`), for a session that can only wait.
 *
 * @param sessionId - The limited session.
 */
export function useWaitForReset(sessionId: string) {
  const transport = useTransport();
  return useMutation({
    mutationFn: () => transport.waitForReset(sessionId, {}),
    retry: false,
  });
}
