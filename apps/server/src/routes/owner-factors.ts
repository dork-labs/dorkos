/**
 * `/api/owner-factors`: the owner's second ways to prove a sign-in from
 * another device, a passkey or an authenticator app (DOR-3647).
 *
 * - `GET /`: the ones set up. Never a secret or a key.
 * - `POST /passkeys/options`: `{ label }`. After "Confirm it's you", a
 *   challenge to make a passkey on the origin the browser is on.
 * - `POST /passkeys/finish`: `{ response }`. Stores it, writes an Activity line
 *   and raises a notice.
 * - `POST /authenticator/start`: `{ label }`. After "Confirm it's you", a new
 *   secret and the address to scan. It counts only once confirmed.
 * - `POST /authenticator/confirm`: `{ id, code }`. One good code confirms it.
 * - `DELETE /:id`: after "Confirm it's you", removes one.
 *
 * Every route is the owner in person: at this computer, or signed in on an
 * encrypted connection ({@link refuseFrontDoorChange}). Never Wi-Fi, an agent,
 * an API key or an approval token. Reads included.
 *
 * @module routes/owner-factors
 */
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { Hono, type Context } from 'hono';

import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { refuseFrontDoorChange } from '../lib/caller-authority.js';
import { isOwnOriginJsonWrite, NOT_FROM_OWN_PAGE } from '../lib/http/own-origin-write.js';
import { errorBody } from '../lib/route-utils.js';
import { getUserById, readOwnerAccount } from '../services/core/auth/index.js';
import { recordSignInTrustChange } from '../services/core/auth/auth-audit.js';
import {
  addPendingTotp,
  confirmTotp,
  findOwnerFactor,
  listOwnerFactors,
  openSecret,
  removeOwnerFactor,
} from '../services/core/auth/factors/owner-factors.js';
import {
  finishAddingPasskey,
  startAddingPasskey,
} from '../services/core/auth/factors/owner-passkeys.js';
import { newTotpSecret, totpUri, verifyTotp } from '../services/core/auth/factors/totp.js';
import { notify } from '../services/notifications/notification-service.js';
import { runFrontDoorWrite } from './front-door-step-up.js';

/** What these routes are called in a refusal. */
const SUBJECT = 'sign-in checks';

/** Longest label kept. */
const MAX_LABEL = 60;

/** The owner asking, with their sign-in, or the refusal. */
function ownerOf(
  c: Context<ApiEnv>,
  facts: RequestFacts = honoRequestFacts(c)
): { userId: string; sessionId: string } | Response {
  const refusal = refuseFrontDoorChange(facts, SUBJECT);
  if (refusal) return c.json(errorBody(refusal.error, refusal.code), 403);
  const owner = readOwnerAccount();
  const sessionId = facts.user?.sessionId;
  if (!owner || facts.user?.userId !== owner.id || !sessionId) {
    return c.json(errorBody('Sign in to change sign-in checks.', 'SIGN_IN_FIRST'), 403);
  }
  return { userId: owner.id, sessionId };
}

/** A label from a body, trimmed and capped, or the fallback. */
function labelOf(body: { label?: unknown } | null, fallback: string): string {
  const raw = typeof body?.label === 'string' ? body.label.trim() : '';
  return (raw || fallback).slice(0, MAX_LABEL);
}

/** Build the routes mounted at `/api/owner-factors`. */
export function createOwnerFactorRoutes(): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const facts = honoRequestFacts(c);
    if (c.req.method !== 'GET' && !isOwnOriginJsonWrite(facts.headers)) {
      // A DELETE carries no body; only its origin is checked.
      const deleteFromOwnPage =
        c.req.method === 'DELETE' &&
        isOwnOriginJsonWrite({ ...facts.headers, 'content-type': 'application/json' });
      if (!deleteFromOwnPage) {
        return c.json(errorBody('Change this in the DorkOS app.', NOT_FROM_OWN_PAGE), 403);
      }
    }
    await next();
  });

  router.get('/', (c) => {
    const owner = ownerOf(c);
    if (owner instanceof Response) return owner;
    return c.json({ factors: listOwnerFactors(owner.userId) });
  });

  router.post('/passkeys/options', async (c) => {
    const owner = ownerOf(c);
    if (owner instanceof Response) return owner;
    const body = (readJsonBody(c) ?? null) as { label?: unknown } | null;
    const label = labelOf(body, 'Passkey');
    const origin = String(c.req.header('origin'));
    return runFrontDoorWrite(c, {
      kind: 'owner-factor.change',
      target: 'passkey',
      input: { add: 'passkey', label, origin },
      reason: 'Add a passkey to your DorkOS account.',
      subject: SUBJECT,
      run: async (confirming) => {
        const who = ownerOf(c, confirming);
        if (who instanceof Response) return who;
        const options = await startAddingPasskey({
          userId: who.userId,
          userName: getUserById(who.userId)?.email ?? 'owner',
          sessionId: who.sessionId,
          origin,
          label,
        });
        if (typeof options === 'string') {
          return c.json(
            errorBody('Add a passkey on this computer, or over https.', 'PASSKEY_ORIGIN'),
            403
          );
        }
        return c.json({ options });
      },
    });
  });

  router.post('/passkeys/finish', async (c) => {
    const owner = ownerOf(c);
    if (owner instanceof Response) return owner;
    const body = (readJsonBody(c) ?? null) as { response?: unknown } | null;
    if (!body?.response || typeof body.response !== 'object') {
      return c.json(errorBody('Send the new passkey.', 'INVALID_BODY'), 400);
    }
    const added = await finishAddingPasskey({
      userId: owner.userId,
      sessionId: owner.sessionId,
      response: body.response as RegistrationResponseJSON,
    });
    if (typeof added === 'string') {
      return c.json(errorBody('That passkey wasn’t added. Try again.', 'PASSKEY_REFUSED'), 400);
    }
    recordSignInTrustChange(owner.userId, 'passkey-added');
    void notify('signin.check_added', {
      factorId: added.factorId,
      kind: 'passkey',
      host: added.host,
    });
    return c.json({ id: added.factorId, host: added.host });
  });

  router.post('/authenticator/start', async (c) => {
    const owner = ownerOf(c);
    if (owner instanceof Response) return owner;
    const body = (readJsonBody(c) ?? null) as { label?: unknown } | null;
    const label = labelOf(body, 'Authenticator app');
    return runFrontDoorWrite(c, {
      kind: 'owner-factor.change',
      target: 'authenticator',
      input: { add: 'authenticator', label },
      reason: 'Add an authenticator app to your DorkOS account.',
      subject: SUBJECT,
      run: async (confirming) => {
        const who = ownerOf(c, confirming);
        if (who instanceof Response) return who;
        const secret = newTotpSecret();
        const id = await addPendingTotp(who.userId, label, secret);
        const account = getUserById(who.userId)?.email ?? 'owner';
        return c.json({ id, secret, uri: totpUri(secret, account) });
      },
    });
  });

  router.post('/authenticator/confirm', async (c) => {
    const owner = ownerOf(c);
    if (owner instanceof Response) return owner;
    const body = (readJsonBody(c) ?? null) as { id?: unknown; code?: unknown } | null;
    const factor =
      typeof body?.id === 'string' ? findOwnerFactor(owner.userId, body.id) : undefined;
    if (!factor || factor.kind !== 'totp' || factor.confirmedAt !== null || !factor.sealedSecret) {
      return c.json(errorBody('Start again to add an authenticator app.', 'NOT_FOUND'), 404);
    }
    const secret = await openSecret(factor.sealedSecret);
    const step =
      secret && typeof body?.code === 'string' ? verifyTotp(secret, body.code, null) : null;
    if (step === null) {
      return c.json(errorBody('That code didn’t match. Try the next one.', 'CODE_REFUSED'), 400);
    }
    confirmTotp(factor.id, step);
    recordSignInTrustChange(owner.userId, 'authenticator-added');
    void notify('signin.check_added', { factorId: factor.id, kind: 'authenticator' });
    return c.json({ id: factor.id });
  });

  router.delete('/:id', (c) => {
    const owner = ownerOf(c);
    if (owner instanceof Response) return owner;
    const id = c.req.param('id');
    if (!findOwnerFactor(owner.userId, id)) {
      return c.json(errorBody('That sign-in check is already gone.', 'NOT_FOUND'), 404);
    }
    return runFrontDoorWrite(c, {
      kind: 'owner-factor.change',
      target: id,
      input: { remove: id },
      reason: 'Remove this sign-in check.',
      subject: SUBJECT,
      run: async (confirming) => {
        const who = ownerOf(c, confirming);
        if (who instanceof Response) return who;
        if (!removeOwnerFactor(who.userId, id)) {
          return c.json(errorBody('That sign-in check is already gone.', 'NOT_FOUND'), 404);
        }
        recordSignInTrustChange(who.userId, 'factor-removed');
        return c.body(null, 204);
      },
    });
  });

  return router;
}
