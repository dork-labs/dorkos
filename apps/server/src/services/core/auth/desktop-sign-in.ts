/**
 * The desktop window signs in by itself (F3, DOR-2966).
 *
 * The desktop app runs this server as its own child process, so the person at
 * the window is the owner at this computer. They should never type a password
 * there, and the window still needs a person cookie for what only a person at
 * this computer may do. So:
 *
 * 1. **Mint.** The desktop shell asks over its process channel, never over
 *    HTTP and never through an environment variable. The server mints a code
 *    only when the desktop app runs it and an owner exists: random, single
 *    use, good for {@link DESKTOP_SIGN_IN_TTL_MS}, held in memory only. Nothing
 *    reachable over HTTP or a DorkOS tool mints one.
 * 2. **Redeem.** The shell posts the code to `POST /api/desktop/sign-in`
 *    through the window's own session. Only a request from this computer
 *    (F0's classifier: loopback peer and `Host`, no forwarding headers, no
 *    other site's page) that no other site's page sent (`Sec-Fetch-Site`) may
 *    redeem it.
 * 3. **Sign in.** A Better Auth endpoint only server code can call creates
 *    the owner's session and sets an ordinary session cookie with no expiry,
 *    so the browser keeps it in memory only and it never reaches disk. The
 *    shell mints a new code on every launch.
 *
 * @module services/core/auth/desktop-sign-in
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { BetterAuthPlugin } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';

import { env } from '../../../env.js';

/** How long a minted code may wait to be redeemed. */
export const DESKTOP_SIGN_IN_TTL_MS = 60_000;

/** The one code waiting to be redeemed, by its hash; a new mint replaces it. */
let pending: { hash: Buffer; userId: string; expiresAt: number } | null = null;

/** SHA-256 of a code, so the code itself is never held. */
function hashCode(code: string): Buffer {
  return createHash('sha256').update(code, 'utf8').digest();
}

/**
 * Mint a code for the desktop window, or `null` when this server is not the
 * desktop app's, or when nobody has an account here yet. Replaces any code
 * still waiting.
 *
 * @param ownerId - The owner account's id, or `null` when there is none.
 * @param now - The current time, for tests.
 */
export function mintDesktopSignInCode(ownerId: string | null, now = Date.now()): string | null {
  if (env.DORKOS_MANAGED_BY !== 'desktop' || !ownerId) return null;
  const code = randomBytes(32).toString('base64url');
  pending = { hash: hashCode(code), userId: ownerId, expiresAt: now + DESKTOP_SIGN_IN_TTL_MS };
  return code;
}

/**
 * Take a code: the account it signs in, or `null` when it is wrong, used or
 * expired. A code is good once, and a wrong one spends the waiting code too,
 * so a guess costs the shell a fresh mint rather than leaving a target.
 *
 * @param code - The code the shell posted.
 * @param now - The current time, for tests.
 */
export function takeDesktopSignInCode(code: string, now = Date.now()): string | null {
  const waiting = pending;
  pending = null;
  if (!waiting || now >= waiting.expiresAt) return null;
  return timingSafeEqual(hashCode(code), waiting.hash) ? waiting.userId : null;
}

/**
 * Where the desktop entry finds the mint, inside the same process. A global
 * rather than an import because the desktop bundles the server separately,
 * and an import from outside it would load a second copy with its own code.
 */
export const DESKTOP_SIGN_IN_MINT = Symbol.for('dorkos.desktop.mintSignInCode');

/**
 * Give the desktop entry its mint, when the desktop app runs this server.
 *
 * @param readOwnerId - Reads the owner account's id at mint time.
 */
export function exposeDesktopSignInMint(readOwnerId: () => string | null): void {
  if (env.DORKOS_MANAGED_BY !== 'desktop') return;
  (globalThis as Record<symbol, unknown>)[DESKTOP_SIGN_IN_MINT] = () =>
    mintDesktopSignInCode(readOwnerId());
}

/**
 * The Better Auth endpoint that signs an account in by id. Server code only:
 * it has no path, so it is never on the HTTP router, and the route that takes
 * a code is the only way in.
 */
export function desktopSignInPlugin() {
  return {
    id: 'dorkos-desktop-sign-in',
    endpoints: {
      signInDesktopOwner: createAuthEndpoint.serverOnly(
        { method: 'POST', body: z.object({ userId: z.string().min(1) }) },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (!user) throw ctx.error('NOT_FOUND', { message: 'No such account.' });
          // `dontRememberMe`: a session cookie with no expiry, kept in memory.
          const session = await ctx.context.internalAdapter.createSession(user.id, true);
          await setSessionCookie(ctx, { session, user }, true);
          return ctx.json({ ok: true });
        }
      ),
    },
  } satisfies BetterAuthPlugin;
}

/**
 * Forget any code waiting. Tests only.
 *
 * @internal
 */
export function resetDesktopSignInForTests(): void {
  pending = null;
}
