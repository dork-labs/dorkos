/**
 * Once the owner has set up a second factor, a password alone no longer signs
 * them in from another device (DOR-3647).
 *
 * A password sign-in (`POST /api/auth/sign-in/email`) from any route but this
 * computer must then carry `totpCode`, a current code from the owner's
 * authenticator app, or it is refused before Better Auth sees it. A passkey
 * signs in without a password (`http/sign-in/owner-passkey-sign-in.ts`).
 *
 * - **This computer never asks.** That is the way back in when a factor is
 *   lost: sign in at the computer DorkOS runs on and remove it. "This computer"
 *   is the request classifier's verdict, from the listener a request arrived
 *   on, never a loopback address, `Host` or forwarding header: the tunnel and
 *   managed access reach the server from loopback too.
 * - **The attempt limits still apply.** This is mounted after both sign-in
 *   limiters, so every attempt counts, with or without a code.
 * - **The password comes first.** The code is looked at only once the
 *   password is right, so it can never be tried on its own.
 * - **A code works once.** Its time step is recorded before the sign-in goes
 *   on, so the same code cannot sign in twice.
 * - **Only what works there is asked.** A passkey made for this computer works
 *   only here, so on its own it asks nothing of another device's sign-in.
 * - **Only the owner.** Another account's sign-in goes on as before.
 *
 * @module middleware/second-factor-gate
 */
import type { MiddlewareHandler } from 'hono';

import { honoRequestFacts, type RequestFactsEnv } from '../http/request-facts.js';
import { classifyRequest } from '../lib/request-classifier.js';
import { currentServerRole } from '../lib/server-role.js';
import { account, and, eq } from '@dorkos/db';
import { getTunnelOrigins } from '../lib/trusted-origins.js';
import { getUserById, readAuthDb, readOwnerAccount } from '../services/core/auth/index.js';
import { verifyOwnerPassword } from '../services/core/auth/passwords/password-hash.js';
import {
  confirmedFactors,
  openSecret,
  useTotpStep,
} from '../services/core/auth/factors/owner-factors.js';
import { verifyTotp } from '../services/core/auth/factors/totp.js';
import { ingressOf } from '../services/core/remote/ingress-mark.js';
import { readCappedBody } from './auth-rate-limit.js';

/** Refusal code when a sign-in from another device needs the second factor. */
export const SECOND_FACTOR_REQUIRED = 'SECOND_FACTOR_REQUIRED';

/** Refusal code when the second factor given did not check out. */
export const SECOND_FACTOR_REFUSED = 'SECOND_FACTOR_REFUSED';

/**
 * A path the way a lenient router might read it: lower case, single slashes,
 * no trailing one, so no spelling of the sign-in path slips past.
 */
function normalizedPath(path: string): string {
  return path
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '');
}

/** The fields of a password sign-in this gate reads. */
interface SignInBody {
  email?: string;
  password?: string;
  totpCode?: string;
}

/** The sign-in's body, read from a copy, or `null` when it has none it can read. */
async function signInBodyOf(request: Request): Promise<SignInBody | null> {
  try {
    const text = await readCappedBody(request);
    if (!text) return null;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const pick = (key: string) => (typeof parsed[key] === 'string' ? parsed[key] : undefined);
    return { email: pick('email'), password: pick('password'), totpCode: pick('totpCode') };
  } catch {
    return null;
  }
}

/** Whether `password` is the owner's own, checked as Better Auth checks it. */
async function ownerPasswordMatches(userId: string, password: string): Promise<boolean> {
  const db = readAuthDb();
  if (!db) return false;
  const row = db
    .select({ hash: account.password })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
    .get();
  if (!row?.hash) return false;
  try {
    return await verifyOwnerPassword({ hash: row.hash, password });
  } catch {
    return false;
  }
}

/**
 * The owner's factors that can prove a sign-in on another device's route: any
 * authenticator app, and a passkey made for the live tunnel or managed
 * address. A passkey made for this computer only works here, so it is never
 * asked for elsewhere.
 */
function usableRemotely(userId: string): { totp: boolean; passkey: boolean } {
  const hosts = new Set(getTunnelOrigins().map((origin) => new URL(origin).hostname));
  return {
    totp: confirmedFactors(userId, 'totp').length > 0,
    passkey: confirmedFactors(userId, 'passkey').some(
      (row) => row.rpId !== null && hosts.has(row.rpId)
    ),
  };
}

/**
 * Check a typed code against the owner's authenticators and spend its step.
 *
 * @param userId - The owner.
 * @param typed - The code.
 * @returns Whether it signed in.
 */
async function spendTotp(userId: string, typed: string): Promise<boolean> {
  for (const factor of confirmedFactors(userId, 'totp')) {
    const secret = factor.sealedSecret ? await openSecret(factor.sealedSecret) : null;
    if (!secret) continue;
    const step = verifyTotp(secret, typed, factor.lastStep);
    if (step !== null && useTotpStep(factor.id, step)) return true;
  }
  return false;
}

/**
 * Build the gate. Mount it after the sign-in limiters and before Better Auth.
 *
 * @returns Hono middleware.
 */
export function buildSecondFactorGate(): MiddlewareHandler<RequestFactsEnv> {
  return async (c, next) => {
    if (c.req.method !== 'POST' || normalizedPath(c.req.path) !== '/api/auth/sign-in/email') {
      return next();
    }
    // Wi-Fi takes no password at all; the auth mount refuses it there.
    if (ingressOf(c.env.incoming) === 'wifi') return next();
    const requestClass = classifyRequest(honoRequestFacts(c), currentServerRole());
    if (requestClass.kind === 'this-computer') return next();
    const owner = readOwnerAccount();
    if (!owner) return next();
    const usable = usableRemotely(owner.id);
    if (!usable.totp && !usable.passkey) return next();
    const body = await signInBodyOf(c.req.raw);
    const ownerEmail = getUserById(owner.id)?.email.toLowerCase();
    // Only the owner's own sign-in is asked; anyone else's goes on as before.
    if (!body?.email || body.email.trim().toLowerCase() !== ownerEmail) return next();
    // The password first: a wrong one gets Better Auth's own answer, so the
    // code is never checked, nor its step spent, without it.
    if (!body.password || !(await ownerPasswordMatches(owner.id, body.password))) return next();
    if (body.totpCode === undefined) {
      return c.json(
        {
          code: SECOND_FACTOR_REQUIRED,
          message: 'Enter the code from your authenticator app, or use a passkey.',
          methods: [
            ...(usable.totp ? ['authenticator'] : []),
            ...(usable.passkey ? ['passkey'] : []),
          ],
        },
        401
      );
    }
    if (!(await spendTotp(owner.id, body.totpCode))) {
      return c.json(
        { code: SECOND_FACTOR_REFUSED, message: 'That code didn’t match. Try the newest one.' },
        401
      );
    }
    return next();
  };
}
