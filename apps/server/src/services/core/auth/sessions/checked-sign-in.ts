/**
 * The Better Auth endpoint that signs an account in after DorkOS checked who it
 * is some other way than a password (DOR-4744, DOR-3647): a Wi-Fi device's
 * one-time code from this computer (`http/sign-in/wifi-sign-in.ts`), or the owner's
 * passkey from another device (`http/sign-in/owner-passkey-sign-in.ts`).
 *
 * Server code only: the endpoint has no path, so it is never on the HTTP
 * router, and only those two routes call it, after their own checks. The
 * session-create hook stamps the route the request came in on and holds the
 * session to that route's limits, as for any sign-in.
 *
 * @module services/core/auth/sessions/checked-sign-in
 */
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';

/** The plugin carrying `signInCheckedAccount`. */
export function checkedSignInPlugin() {
  return {
    id: 'dorkos-checked-sign-in',
    endpoints: {
      signInCheckedAccount: createAuthEndpoint.serverOnly(
        { method: 'POST', body: z.object({ userId: z.string().min(1) }) },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (!user) throw ctx.error('NOT_FOUND', { message: 'No such account.' });
          // Stamped at the mint: a Wi-Fi sign-in with no first-use time was not
          // made here and is refused (`wifiSessionIdle`).
          const session = await ctx.context.internalAdapter.createSession(user.id, false, {
            lastActiveAt: new Date(),
          });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ sessionId: session.id });
        }
      ),
    },
  } satisfies BetterAuthPlugin;
}
