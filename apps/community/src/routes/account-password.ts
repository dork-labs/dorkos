import type { Context, Hono } from 'hono';
import type { Pool } from 'pg';
import {
  CommunityWireAccountPasswordRequestSchema,
  CommunityWireAccountSignInMethodsSchema,
} from '@dorkos/shared/community-wire';
import type { CommunityAuth } from '../auth.js';
import { transaction } from '../data.js';
import { ApiError, json, readJson } from '../http.js';
import { OIDC_PROVIDER_ID } from '../oidc.js';
import { REAUTH_WINDOW_MS } from './erasures.js';

/** Whether the account has a password it can sign in with. */
export async function accountHasPassword(pool: Pool, userId: string): Promise<boolean> {
  const credential = await pool.query(
    `SELECT 1 FROM account WHERE "userId"=$1 AND "providerId"='credential' AND password IS NOT NULL`,
    [userId]
  );
  return Boolean(credential.rowCount);
}

/** The signed-in person's own browser session; a grant, agent or host key never reaches here. */
async function requireBrowserSession(c: Context, auth: CommunityAuth) {
  if (c.req.header('authorization'))
    throw new ApiError(403, 'FORBIDDEN', 'This needs your own signed-in browser session.');
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  return session;
}

/**
 * Register the signed-in account's sign-in methods and its first-password route on the host API.
 *
 * An account created through the host's OpenID Connect issuer has no password, so an issuer
 * outage would lock it out and every password-confirmed action refuses it. Adding a password
 * fixes both. It needs a sign-in from the last five minutes, the same bar erasure sets for an
 * account without a password, so a stolen, older session cannot quietly add one.
 */
export function registerAccountPasswordRoutes(
  app: Hono,
  { pool, auth }: { pool: Pool; auth: CommunityAuth }
): void {
  app.get('/account/sign-in-methods', async (c) => {
    const session = await requireBrowserSession(c, auth);
    const accounts = await pool.query<{ providerId: string; password: string | null }>(
      'SELECT "providerId",password FROM account WHERE "userId"=$1',
      [session.user.id]
    );
    c.header('Cache-Control', 'no-store');
    return json(c, CommunityWireAccountSignInMethodsSchema, {
      password: accounts.rows.some((row) => row.providerId === 'credential' && row.password),
      oidc: accounts.rows.some((row) => row.providerId === OIDC_PROVIDER_ID),
    });
  });

  app.post('/account/password', async (c) => {
    const session = await requireBrowserSession(c, auth);
    const body = await readJson(c, CommunityWireAccountPasswordRequestSchema);
    if (await accountHasPassword(pool, session.user.id))
      throw new ApiError(409, 'STATE_CONFLICT', 'This account already has a password.');
    if (Date.now() - new Date(session.session.createdAt).getTime() >= REAUTH_WINDOW_MS)
      throw new ApiError(403, 'REAUTH_REQUIRED', 'Sign in again, then try once more.');
    try {
      await auth.api.setPassword({
        headers: c.req.raw.headers,
        body: { newPassword: body.newPassword },
      });
    } catch {
      // Better Auth refuses a second password; a concurrent request may have set one first.
      throw new ApiError(409, 'STATE_CONFLICT', 'This account already has a password.');
    }
    // Recorded in every community this account belongs to, as password recovery is.
    await transaction(pool, (client) =>
      client.query(
        `INSERT INTO audit_events(community_id,actor_member_id,action,subject_id)
         SELECT community_id,id,'account.password_set',id FROM members
         WHERE user_id=$1 ORDER BY community_id,id`,
        [session.user.id]
      )
    );
    return c.body(null, 204);
  });
}
