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
 *    only when the desktop app runs it, an owner exists, and the owner has not
 *    asked for a password on this computer too (then the window asks, as
 *    before): random, single use, good for {@link DESKTOP_SIGN_IN_TTL_MS},
 *    held in memory only as a hash. Nothing reachable over HTTP or a DorkOS
 *    tool mints one.
 * 2. **Redeem.** The shell posts the code to `POST /api/desktop/sign-in`
 *    through the window's own session. Only a request from this computer
 *    (F0's classifier: loopback peer and `Host`, no forwarding headers, no
 *    other site's page) that no other site's page sent (`Sec-Fetch-Site`) may
 *    redeem it.
 * 3. **Sign in.** A Better Auth endpoint only server code can call creates
 *    the owner's session, with the ordinary lifetime, and sets its cookie with
 *    no expiry, so the browser keeps it in memory only and it never reaches
 *    disk. Each new desktop sign-in ends the one before it. The shell signs
 *    in at every launch, and again twice a day while it runs.
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

/** How many wrong codes the waiting code survives. */
export const DESKTOP_SIGN_IN_MAX_MISSES = 5;

/** The one code waiting to be redeemed, by its hash; a new mint replaces it. */
let pending: { hash: Buffer; userId: string; expiresAt: number; misses: number } | null = null;

/** The session the last desktop sign-in made, ended by the next one. */
let lastDesktopSession: string | null = null;

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
  pending = {
    hash: hashCode(code),
    userId: ownerId,
    expiresAt: now + DESKTOP_SIGN_IN_TTL_MS,
    misses: 0,
  };
  return code;
}

/**
 * Take a code: the account it signs in, or `null` when it is wrong, used or
 * expired. A code is good once. A wrong one leaves it waiting, so another
 * program on this computer cannot spoil the window's sign-in with a guess,
 * up to {@link DESKTOP_SIGN_IN_MAX_MISSES} guesses, after which it is gone.
 *
 * @param code - The code the shell posted.
 * @param now - The current time, for tests.
 */
export function takeDesktopSignInCode(code: string, now = Date.now()): string | null {
  const waiting = pending;
  if (!waiting) return null;
  if (now >= waiting.expiresAt) {
    pending = null;
    return null;
  }
  if (timingSafeEqual(hashCode(code), waiting.hash)) {
    pending = null;
    return waiting.userId;
  }
  waiting.misses += 1;
  if (waiting.misses >= DESKTOP_SIGN_IN_MAX_MISSES) pending = null;
  return null;
}

/**
 * Where the desktop entry finds the mint, inside the same process. A global
 * rather than an import because the desktop bundles the server separately,
 * and an import from outside it would load a second copy with its own code.
 */
export const DESKTOP_SIGN_IN_MINT = Symbol.for('dorkos.desktop.mintSignInCode');

/** What the mint reads at mint time. */
export interface DesktopSignInSources {
  /** The owner account's id, or `null` when nobody has an account yet. */
  ownerId: () => string | null;
  /** Whether the owner asked for a password on this computer too. */
  asksOnThisComputer: () => boolean;
}

/**
 * Give the desktop entry its mint, when the desktop app runs this server. It
 * mints nothing while the owner asks for a password on this computer too: the
 * window asks then, as every browser on this computer does.
 *
 * @param sources - See {@link DesktopSignInSources}.
 */
export function exposeDesktopSignInMint(sources: DesktopSignInSources): void {
  if (env.DORKOS_MANAGED_BY !== 'desktop') return;
  (globalThis as Record<symbol, unknown>)[DESKTOP_SIGN_IN_MINT] = () =>
    sources.asksOnThisComputer() ? null : mintDesktopSignInCode(sources.ownerId());
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
          // The ordinary lifetime on the server, and a cookie with no expiry
          // (`dontRememberMe`) in the window, kept in memory only.
          const session = await ctx.context.internalAdapter.createSession(user.id, false);
          await setSessionCookie(ctx, { session, user }, true);
          // One desktop session at a time: the window's last one ends now.
          const previous = lastDesktopSession;
          lastDesktopSession = session.token;
          if (previous) await ctx.context.internalAdapter.deleteSession(previous);
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
  lastDesktopSession = null;
}
