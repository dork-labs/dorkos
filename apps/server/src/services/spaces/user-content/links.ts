import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { CommunityConfig } from '../config.js';
import { equalSecret } from '../security.js';

/**
 * Signed download links (DOR-2957). A browser downloads a file or an export from a link this
 * server signed, on the user-content address when one is set: no cookie rides there, so the link
 * itself names what it opens, for whom, from which sign-in, until when. Bearer callers (the DorkOS
 * app, agents) never use one; they read the bytes on the space's own address, as before.
 */

/** What a link opens. */
export type UserContentKind = 'attachment' | 'export';

/** How long a link may be started: a file at once, an export long enough to resume. */
export const USER_CONTENT_LINK_TTL_MS: Record<UserContentKind, number> = {
  attachment: 5 * 60_000,
  export: 60 * 60_000,
};

/** Everything a link carries. */
export interface UserContentClaim {
  kind: UserContentKind;
  /** The attachment or export id. */
  id: string;
  /** The space it belongs to. */
  communityId: string;
  /** The person it was made for. */
  memberId: string;
  /** The sign-in it was made from: signing out ends the link. */
  sessionId: string;
  /** When it stops opening, in milliseconds since the epoch. */
  expiresAt: number;
}

const ClaimSchema = z.strictObject({
  k: z.enum(['attachment', 'export']),
  i: z.string().min(1).max(128),
  s: z.string().min(1).max(128),
  m: z.string().min(1).max(128),
  t: z.string().min(1).max(256),
  x: z.number().int().positive(),
});

/** The link answer a browser reads before it starts a download. */
export const UserContentLinkResponseSchema = z.strictObject({
  url: z.url(),
  expiresAt: z.iso.datetime(),
});

/** The keyed signature of a link's body; the prefix keeps this use of the secret apart. */
function signature(body: string, secret: string): string {
  return createHmac('sha256', secret).update(`user-content:${body}`).digest('base64url');
}

/**
 * Sign a link for one claim.
 *
 * @param config - Where the link points and the secret it is signed with.
 * @returns The absolute link and the claim's expiry.
 */
export function signUserContentLink(
  config: Pick<CommunityConfig, 'authSecret' | 'publicUrl' | 'userContentUrl'>,
  claim: Omit<UserContentClaim, 'expiresAt'>,
  now: Date
): { url: string; expiresAt: Date } {
  const expiresAt = new Date(now.getTime() + USER_CONTENT_LINK_TTL_MS[claim.kind]);
  const body = Buffer.from(
    JSON.stringify({
      k: claim.kind,
      i: claim.id,
      s: claim.communityId,
      m: claim.memberId,
      t: claim.sessionId,
      x: expiresAt.getTime(),
    })
  ).toString('base64url');
  const base = config.userContentUrl ?? config.publicUrl;
  return { url: `${base}/u/${body}.${signature(body, config.authSecret)}`, expiresAt };
}

/** Why a link does not open. */
export type UserContentRefusal = 'invalid' | 'expired';

/**
 * Read a link's claim, if this server signed it and it has not expired.
 *
 * @returns The claim, or why it does not open.
 */
export function readUserContentLink(
  config: Pick<CommunityConfig, 'authSecret'>,
  token: string,
  now: Date
): UserContentClaim | UserContentRefusal {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return 'invalid';
  const body = token.slice(0, dot);
  if (!equalSecret(signature(body, config.authSecret), token.slice(dot + 1))) return 'invalid';
  let parsed;
  try {
    parsed = ClaimSchema.safeParse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
  } catch {
    return 'invalid';
  }
  if (!parsed.success) return 'invalid';
  const { k, i, s, m, t, x } = parsed.data;
  if (x <= now.getTime()) return 'expired';
  return { kind: k, id: i, communityId: s, memberId: m, sessionId: t, expiresAt: x };
}
