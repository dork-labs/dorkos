/** Why an invitation or admission is refused: closed admission, and the reasons a person may see. */
import type { Pool, PoolClient } from 'pg';
import { ApiError } from '../../http.js';

/** The one refusal a person sees for any invitation that cannot be used. */
export function invalidInvitation(): ApiError {
  return new ApiError(403, 'FORBIDDEN', 'This invitation cannot be used. Ask for a new link.');
}

/** A closed community admits no one new; existing members are unaffected. */
class AdmissionClosed extends ApiError {
  constructor() {
    super(409, 'STATE_CONFLICT', 'This space is closed to new members.');
  }
}

/**
 * Refuse new admission while the owner has closed the community. The write paths call this
 * after `lockActiveCommunity` has taken the community row in share mode in the same
 * transaction; that lock is what serializes them with the settings update that closes
 * admission (it takes the row for update, then revokes every invitation), so an invitation or
 * admission either commits first and is revoked by the close, or reads `closed` here. With
 * `lock` the read also takes that share lock itself, so it stays correct for any caller; the
 * read-only preview reads without it.
 */
export async function assertAdmissionOpen(
  client: PoolClient | Pool,
  communityId: string,
  lock: boolean
): Promise<void> {
  const result = await client.query<{ admission_policy: string }>(
    `SELECT admission_policy FROM communities WHERE id=$1${lock ? ' FOR SHARE' : ''}`,
    [communityId]
  );
  if (result.rows[0]?.admission_policy === 'closed') throw new AdmissionClosed();
}

/**
 * Keep the closed, full, and held reasons visible, so a person learns before signing up that
 * they cannot join yet; hide every other invitation failure. Each is reached only after the
 * link's signature checks out.
 */
export function invitationRefusal(error: ApiError): ApiError {
  return error instanceof AdmissionClosed ||
    error.code === 'MEMBER_LIMIT_REACHED' ||
    error.code === 'COMMUNITY_HELD'
    ? error
    : invalidInvitation();
}
