/**
 * The owner proves it is them at this computer, once (DOR-3330).
 *
 * At this computer DorkOS asks for no password by default, and an open request
 * proves only the place: any program here can call it with no headers. So
 * once an owner exists, what only the person may do (deciding an approval,
 * widening an agent's power, letting code into the server, speaking as them)
 * needs their browser session. Rather than ask at every action, the app asks
 * the owner's password once ({@link checkOwnerPassword}, the step-up the
 * session relay already uses) and this mints a session for that browser:
 *
 * - **Bound to this computer.** It is made inside the request's class, so the
 *   session-create hook stamps it `local` (`sessions/session-route.ts`), and
 *   it works on no other route.
 * - **Long-lived.** The ordinary lifetime, renewed by use, with a remembered
 *   cookie, so the browser keeps it across restarts. This computer's own
 *   sign-ins have no outer limit.
 * - **Server code only.** The endpoint has no path, so it is never on the HTTP
 *   router; `routes/person-session.ts`, after the password matched, is the one
 *   way in.
 *
 * The limit, said plainly: a program running as the same OS user can read the
 * auth secret and database on disk (DOR-505, DOR-3053), so this raises the bar
 * from "omit two headers" to "forge a signed cookie or edit files".
 *
 * @module services/core/auth/person-step-up
 */
import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';

/**
 * The Better Auth endpoint that signs the owner in after the password
 * step-up. Server code only: it has no path.
 */
export function personStepUpPlugin() {
  return {
    id: 'dorkos-person-step-up',
    endpoints: {
      signInOwnerAfterStepUp: createAuthEndpoint.serverOnly(
        { method: 'POST', body: z.object({ userId: z.string().min(1) }) },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (!user) throw ctx.error('NOT_FOUND', { message: 'No such account.' });
          const session = await ctx.context.internalAdapter.createSession(user.id, false);
          await setSessionCookie(ctx, { session, user }, false);
          return ctx.json({ ok: true });
        }
      ),
    },
  } satisfies BetterAuthPlugin;
}
