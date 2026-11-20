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
 * - **A code works once.** Its time step is recorded before the sign-in goes
 *   on, so the same code cannot sign in twice.
 *
 * @module middleware/second-factor-gate
 */
import type { MiddlewareHandler } from 'hono';

import { honoRequestFacts, type RequestFactsEnv } from '../http/request-facts.js';
import { classifyRequest } from '../lib/request-classifier.js';
import { currentServerRole } from '../lib/server-role.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
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

/** The code a body carries, or `undefined`. */
async function totpCodeOf(request: Request): Promise<string | undefined> {
  try {
    const text = await readCappedBody(request);
    if (!text) return undefined;
    const code = (JSON.parse(text) as { totpCode?: unknown }).totpCode;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
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
    if (c.req.method !== 'POST' || c.req.path.toLowerCase() !== '/api/auth/sign-in/email') {
      return next();
    }
    // Wi-Fi takes no password at all; the auth mount refuses it there.
    if (ingressOf(c.env.incoming) === 'wifi') return next();
    const requestClass = classifyRequest(honoRequestFacts(c), currentServerRole());
    if (requestClass.kind === 'this-computer') return next();
    const owner = readOwnerAccount();
    if (!owner || confirmedFactors(owner.id).length === 0) return next();
    const typed = await totpCodeOf(c.req.raw);
    if (typed === undefined) {
      return c.json(
        {
          code: SECOND_FACTOR_REQUIRED,
          message: 'Enter the code from your authenticator app, or use a passkey.',
          methods: [
            ...(confirmedFactors(owner.id, 'totp').length > 0 ? ['authenticator'] : []),
            ...(confirmedFactors(owner.id, 'passkey').length > 0 ? ['passkey'] : []),
          ],
        },
        401
      );
    }
    if (!(await spendTotp(owner.id, typed))) {
      return c.json(
        { code: SECOND_FACTOR_REFUSED, message: 'That code didn’t work. Try the next one.' },
        401
      );
    }
    return next();
  };
}
