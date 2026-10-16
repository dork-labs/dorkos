import type { Context } from 'hono';
import type { Pool } from 'pg';
import type { CommunityAuth } from '../auth.js';
import type { CommunityConfig } from '../config.js';
import type { Member, Principal } from '../data.js';
import { ApiError } from '../http.js';
import { signUserContentLink, type UserContentClaim, type UserContentKind } from './links.js';

/**
 * Sign a download link for the browser sign-in making this request (DOR-2957). Only a browser
 * sign-in gets one: a bearer caller reads the bytes on the space's own address instead.
 *
 * @param c - The request, whose cookie names the sign-in the link is tied to.
 * @param target - What the link opens, for which member; the caller has checked their access.
 * @returns The link and when it stops opening.
 */
export async function signLinkForSession(
  c: Context,
  { auth, config, now }: { auth: CommunityAuth; config: CommunityConfig; now: Date },
  target: { kind: UserContentKind; id: string; member: Pick<Member, 'id' | 'community_id'> }
): Promise<{ url: string; expiresAt: Date }> {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  return signUserContentLink(
    config,
    {
      kind: target.kind,
      id: target.id,
      communityId: target.member.community_id,
      memberId: target.member.id,
      sessionId: session.session.id,
    },
    now
  );
}

/**
 * The person a link was made for, if they are still a member of its space, still signed in with
 * the sign-in that made it, and the space still lets its members read. Asked again before every
 * chunk a link streams, as a cookie would be.
 *
 * @returns The member, or a refusal thrown as an {@link ApiError}.
 */
export async function memberOfLink(pool: Pool, claim: UserContentClaim): Promise<Member> {
  const result = await pool.query<Member>(
    `SELECT m.id,m.user_id,m.display_name,m.role,m.community_id
     FROM members m
     JOIN communities c ON c.id=m.community_id
     JOIN session s ON s."userId"=m.user_id
     WHERE m.id=$1 AND m.community_id=$2 AND m.active AND m.kind='person'
       AND s.id=$3 AND s."expiresAt">now()
       AND c.lifecycle IN ('active','archived','held') AND c.takedown_id IS NULL`,
    [claim.memberId, claim.communityId, claim.sessionId]
  );
  const member = result.rows[0];
  if (!member) throw new ApiError(403, 'FORBIDDEN', 'This download link no longer opens.');
  return member;
}

/** The reader a file link streams to, as {@link memberOfLink} finds them. */
export async function principalOfLink(pool: Pool, claim: UserContentClaim): Promise<Principal> {
  const member = await memberOfLink(pool, claim);
  return {
    kind: 'human',
    id: member.id,
    ownerMemberId: member.id,
    display_name: member.display_name,
    community_id: member.community_id,
  };
}
