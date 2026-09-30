import type { Context, Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import type { Pool } from 'pg';
import {
  CommunityWireOwnerReplacementClaimRequestSchema,
  CommunityWireOwnerReplacementClaimResponseSchema,
  CommunityWireOwnerReplacementObjectPreflightResponseSchema,
  CommunityWireOwnerReplacementObjectRequestSchema,
  CommunityWireOwnerReplacementObjectResponseSchema,
  CommunityWireOwnerReplacementPreflightRequestSchema,
  CommunityWireOwnerReplacementPreflightResponseSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../../auth.js';
import type { CommunityConfig } from '../../config.js';
import { requireSessionUser, transaction } from '../../data.js';
import { ApiError, json, readJson } from '../../http.js';
import {
  OWNER_REPLACEMENT_COOKIE,
  OWNER_REPLACEMENT_COOKIE_SECONDS,
  ownerReplacementCookieToken,
} from '../../owner-replacement/admission.js';
import { CLAIM_UNAVAILABLE, claimOwnerReplacement } from '../../owner-replacement/claim.js';
import { objectWithToken } from '../../owner-replacement/object-tokens.js';
import {
  OPEN_REPLACEMENT_STATES,
  type OwnerReplacementState,
} from '../../owner-replacement/records.js';
import { hashSecret, signValue } from '../../security.js';

/** The one answer for an object-only link that cannot be used, whatever the reason. */
const DEAD_LINK = 'This link no longer works.';

/**
 * Register the two public halves of an owner replacement, reached from links rather than from
 * a community:
 *
 * - The owner's object-only link from the email. `object-preflight` shows what a live link is
 *   for and `object` keeps ownership, with no sign-in. The link can do nothing else, and a
 *   `GET` never objects, so a mail scanner that opens it changes nothing.
 * - The named account's claim link. `preflight` exchanges the token for a 30-minute cookie that
 *   lets a person sign up and then `claim` from their signed-in session.
 *
 * Every unusable token gets one identical `403`, and every route here counts against the
 * caller's `COMMUNITY_BOOTSTRAP_ATTEMPTS_PER_MINUTE`, so tokens cannot be guessed.
 */
export function registerOwnerReplacementLinkRoutes(
  app: Hono,
  deps: {
    pool: Pool;
    auth: CommunityAuth;
    config: CommunityConfig;
    now: () => Date;
    /** Spend one of the caller's attempts, or refuse with `429`. */
    limitAttempt: (c: Context) => void;
  }
): void {
  const { pool, auth, config, now, limitAttempt } = deps;
  // Set and delete must agree on every attribute, or a browser can keep the original cookie.
  const cookieOptions = () => ({
    httpOnly: true,
    sameSite: 'Lax' as const,
    secure: config.publicUrl.startsWith('https:'),
    path: '/',
  });

  app.post('/owner-replacements/object-preflight', async (c) => {
    limitAttempt(c);
    const body = await readJson(c, CommunityWireOwnerReplacementObjectRequestSchema);
    const live = await pool.query<{ name: string; claimable_after: Date | null }>(
      `SELECT c.name,r.claimable_after FROM owner_replacement_object_tokens t
       JOIN owner_replacements r ON r.community_id=t.community_id AND r.id=t.replacement_id
       JOIN communities c ON c.id=t.community_id
       WHERE t.token_hash=$1 AND t.used_at IS NULL AND r.state=ANY($2::text[])`,
      [hashSecret(body.token), OPEN_REPLACEMENT_STATES]
    );
    const row = live.rows[0];
    if (!row) throw new ApiError(403, 'FORBIDDEN', DEAD_LINK);
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityWireOwnerReplacementObjectPreflightResponseSchema, {
      communityName: row.name,
      claimableAfter: row.claimable_after?.toISOString() ?? null,
    });
  });

  app.post('/owner-replacements/object', async (c) => {
    limitAttempt(c);
    const body = await readJson(c, CommunityWireOwnerReplacementObjectRequestSchema);
    const result = await objectWithToken(pool, body.token, now());
    if (result.outcome === 'unknown') throw new ApiError(403, 'FORBIDDEN', DEAD_LINK);
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityWireOwnerReplacementObjectResponseSchema, {
      outcome: result.outcome === 'ended' ? 'ended' : 'kept',
    });
  });

  app.post('/owner-replacements/preflight', async (c) => {
    limitAttempt(c);
    const body = await readJson(c, CommunityWireOwnerReplacementPreflightRequestSchema);
    const open = await pool.query<{
      community_id: string;
      name: string;
      state: Extract<OwnerReplacementState, 'notifying' | 'waiting' | 'claimable'>;
      claimable_after: Date | null;
      claim_expires_at: Date | null;
      claimant_named: boolean;
    }>(
      `SELECT r.community_id,c.name,r.state,r.claimable_after,r.claim_expires_at,r.claimant_named
       FROM owner_replacements r JOIN communities c ON c.id=r.community_id
       WHERE r.claim_token_hash=$1 AND r.state=ANY($2::text[])
         AND (r.claim_expires_at IS NULL OR r.claim_expires_at>$3)
         AND c.lifecycle IN ('active','archived','held')`,
      [hashSecret(body.token), OPEN_REPLACEMENT_STATES, now()]
    );
    const row = open.rows[0];
    if (!row) throw new ApiError(403, 'FORBIDDEN', CLAIM_UNAVAILABLE);
    setCookie(c, OWNER_REPLACEMENT_COOKIE, signValue(body.token, config.authSecret), {
      ...cookieOptions(),
      maxAge: OWNER_REPLACEMENT_COOKIE_SECONDS,
    });
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityWireOwnerReplacementPreflightResponseSchema, {
      communityId: row.community_id,
      communityName: row.name,
      state: row.state,
      claimableAfter: row.claimable_after?.toISOString() ?? null,
      claimExpiresAt: row.claim_expires_at?.toISOString() ?? null,
      requiresSingleSignOn: row.claimant_named,
    });
  });

  app.post('/owner-replacements/claim', async (c) => {
    limitAttempt(c);
    await readJson(c, CommunityWireOwnerReplacementClaimRequestSchema);
    const user = await requireSessionUser(c, auth);
    const token = ownerReplacementCookieToken(c.req.header('cookie') ?? null, config.authSecret);
    const dropCookie = () => deleteCookie(c, OWNER_REPLACEMENT_COOKIE, cookieOptions());
    if (!token) {
      dropCookie();
      throw new ApiError(403, 'FORBIDDEN', CLAIM_UNAVAILABLE);
    }
    const result = await transaction(pool, (client) =>
      claimOwnerReplacement(client, {
        tokenHash: hashSecret(token),
        claimant: { userId: user.id, name: user.name },
        oidcIssuer: config.oidc?.issuer ?? null,
        now: now(),
      })
    ).catch((cause: unknown) => {
      // A claim that can never work drops its cookie. Every other refusal keeps it, so the
      // person can sign in with the right account, or come back later, and try again.
      if (cause instanceof ApiError && cause.message === CLAIM_UNAVAILABLE) dropCookie();
      throw cause;
    });
    dropCookie();
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityWireOwnerReplacementClaimResponseSchema, result);
  });
}
