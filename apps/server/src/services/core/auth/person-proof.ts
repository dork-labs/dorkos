/**
 * The person proof beside a session at this computer (DOR-3330).
 *
 * A browser sends a `localhost` cookie to every port on this computer, so a
 * page any program serves on another port, framed or linked in the app, would
 * carry the owner's session cookie to that program. At this computer the
 * session therefore stands for the person only beside a proof only the app's
 * own page holds: a keyed hash of the session's id, handed to the app by the
 * step-up and kept in its origin's storage, which no other port can read.
 *
 * It is derived, never stored: the same key Better Auth signs sessions with,
 * so it survives a restart, ends with its session, and a program that cannot
 * read the key off disk cannot make one (the DOR-505 limit, as for the
 * cookie itself).
 *
 * @module services/core/auth/person-proof
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { getAuth } from './index.js';

/** What the proof is a hash of, beside the session id, so it means nothing else. */
const PROOF_LABEL = 'dorkos-person-proof:v1:';

/** The session-signing key, or `null` before auth is initialized. */
async function proofKey(): Promise<string | null> {
  const auth = getAuth();
  if (!auth) return null;
  return (await auth.$context).secret;
}

/**
 * The person proof for one session, or `null` before auth is initialized.
 *
 * @param sessionId - The Better Auth session's id (never its token).
 */
export async function personProofFor(sessionId: string): Promise<string | null> {
  const key = await proofKey();
  if (!key) return null;
  return createHmac('sha256', key)
    .update(PROOF_LABEL + sessionId)
    .digest('base64url');
}

/**
 * Whether a request's proof is the one for its session.
 *
 * @param sessionId - The verified session's id.
 * @param presented - The proof header as sent, if any.
 */
export async function personProofMatches(
  sessionId: string,
  presented: string | string[] | undefined
): Promise<boolean> {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const expected = await personProofFor(sessionId);
  if (!expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
