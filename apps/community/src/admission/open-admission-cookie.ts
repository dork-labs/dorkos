import type { CommunityConfig } from '../config.js';
import { readCookie, verifyValue } from '../security.js';

/** The cookie that lets one single sign-on sign-up create an account for an open space. */
export const OPEN_ADMISSION_COOKIE = 'community_open_admission';
/** How long that cookie lasts: one sign-in round trip. */
export const OPEN_ADMISSION_MS = 600_000;

/** Whether this host admits anyone through open admission: the switch is on and it has single sign-on. */
export function openAdmissionAvailable(config: CommunityConfig): boolean {
  return config.openAdmission && config.oidc !== null;
}

/** What the cookie says, before it is signed: a prefix no other signed cookie value carries. */
export function openAdmissionValue(communityId: string, expiresAt: Date): string {
  return `open-admission:${communityId}.${expiresAt.getTime()}`;
}

/**
 * The community an open-admission cookie names, if it is signed by this server and unexpired.
 * It proves only that this browser asked to join that community a moment ago; the sign-up gate
 * and the join route still check the community is open.
 */
export function readOpenAdmission(
  cookieHeader: string | null,
  config: CommunityConfig,
  now = Date.now()
): string | null {
  // The prefix's colon reaches the browser percent-encoded.
  const raw = readCookie(cookieHeader, OPEN_ADMISSION_COOKIE);
  let decoded: string | undefined;
  try {
    decoded = raw === undefined ? undefined : decodeURIComponent(raw);
  } catch {
    return null;
  }
  const value = verifyValue(decoded, config.authSecret);
  const match = value?.match(/^open-admission:([0-9a-f-]{36})\.([0-9]{1,15})$/);
  if (!match || Number(match[2]) <= now) return null;
  return match[1];
}
