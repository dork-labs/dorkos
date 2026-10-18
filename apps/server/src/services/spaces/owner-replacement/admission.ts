import type { Pool } from 'pg';
import { hashSecret, readCookie, verifyValue } from '../security.js';

/**
 * The cookie a claim preflight sets: the claim token, signed, for 30 minutes. It lets the named
 * person sign up and then take ownership, and does nothing else.
 */
export const OWNER_REPLACEMENT_COOKIE = 'community_owner_replacement';

/** How long the claim cookie lasts, in seconds. */
export const OWNER_REPLACEMENT_COOKIE_SECONDS = 30 * 60;

/** The account a live claim may create: anyone, or only the one the request named. */
export interface OwnerReplacementAdmission {
  /** The issuer and subject the request named, or null when it named nobody. */
  claimant: { issuer: string; subject: string } | null;
}

/**
 * The claim token in a request's owner-replacement cookie, or null when there is none or its
 * signature does not match.
 */
export function ownerReplacementCookieToken(
  cookieHeader: string | null,
  authSecret: string
): string | null {
  return verifyValue(readCookie(cookieHeader, OWNER_REPLACEMENT_COOKIE), authSecret);
}

/**
 * Whether a browser's owner-replacement cookie admits a new account now: its request must be
 * `claimable`, before its claim window ends, in an `active`, `archived`, or `held` community. A
 * request still in its waiting period, or one that ended, admits nobody. The cookie creates an
 * account and never a membership; the claim transaction checks everything again.
 *
 * @param now - The clock the claim window is judged by; tests inject it.
 * @returns What the request allows, or null when the cookie admits nobody.
 */
export async function ownerReplacementAdmission(
  pool: Pick<Pool, 'query'>,
  cookieHeader: string | null,
  authSecret: string,
  now: Date
): Promise<OwnerReplacementAdmission | null> {
  const token = ownerReplacementCookieToken(cookieHeader, authSecret);
  if (!token) return null;
  // Belt and braces. A token hash lives only on an open request, and of those only a claimable
  // one has a claim_expires_at (owner_replacements_claim_token and _claim_window), so the state
  // filter adds nothing today. Suspending, deleting or taking a community down ends its request
  // and clears the token, so the lifecycle filter adds nothing either. Both guard against drift.
  const found = await pool.query<{ issuer: string | null; subject: string | null }>(
    `SELECT r.claimant_oidc_issuer AS issuer,r.claimant_oidc_subject AS subject
     FROM owner_replacements r JOIN communities c ON c.id=r.community_id
     WHERE r.claim_token_hash=$1 AND r.state='claimable' AND r.claim_expires_at>$2
       AND c.lifecycle IN ('active','archived','held')`,
    [hashSecret(token), now]
  );
  const row = found.rows[0];
  if (!row) return null;
  return {
    claimant: row.issuer && row.subject ? { issuer: row.issuer, subject: row.subject } : null,
  };
}
