import { SESSIONS } from '../../../../config/constants.js';

const countdownMs = SESSIONS.INTERACTION_TIMEOUT_MS;

/**
 * Timing for a pending tool approval. A person sees the same countdown in
 * either case. An attended request then parks until the terminal deadline.
 * An unattended request expires when its countdown ends.
 */
export const PENDING_APPROVAL_TIMING = {
  attended: { countdownMs, expiresAfterMs: SESSIONS.INTERACTION_PARK_CEILING_MS },
  unattended: { countdownMs, expiresAfterMs: countdownMs },
} as const;

export type PendingApprovalProfile = keyof typeof PENDING_APPROVAL_TIMING;

/**
 * Arm one pending record's expiry and return its cancellation function.
 *
 * @param profile - The request's attendance profile.
 * @param onExpiry - The adapter's action when the record's deadline arrives.
 * @returns A function that disarms this record's timer.
 */
export function armPendingApprovalExpiry(
  profile: PendingApprovalProfile,
  onExpiry: () => void
): () => void {
  const timer = setTimeout(onExpiry, PENDING_APPROVAL_TIMING[profile].expiresAfterMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}
