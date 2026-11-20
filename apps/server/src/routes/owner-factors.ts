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
 * Every route is the owner in person, never Wi-Fi, an agent, an API key or an
 * approval token ({@link refuseFrontDoorChange}), reads included. Every change
 * is at this computer only, by the request classifier's verdict: a sign-in
 * check is added or removed only where the owner sits, never from another
 * device with a password alone.
 *
 * @module routes/owner-factors
 */
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import { Hono, type Context } from 'hono';

import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { NEEDS_PERSON_AT_THIS_COMPUTER, refuseFrontDoorChange } from '../lib/caller-authority.js';
import { classifyRequest } from '../lib/request-classifier.js';
import { currentServerRole } from '../lib/server-role.js';
import { isOwnOriginJsonWrite, NOT_FROM_OWN_PAGE } from '../lib/http/own-origin-write.js';
import { errorBody } from '../lib/route-utils.js';
import { passkeyChecked } from '../http/sign-in/passkey-check.js';
import { getAuth, getUserById, readOwnerAccount } from '../services/core/auth/index.js';
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
  everHadRemoteFactor,
  finishAddingPasskey,
  startAddingPasskey,
  thisComputerPasskeyOrigins,
} from '../services/core/auth/factors/owner-passkeys.js';
import { signOutSessionsAway } from '../services/core/auth/sessions/signed-in-devices.js';
import { newTotpSecret, totpUri, verifyTotp } from '../services/core/auth/factors/totp.js';
import { notify } from '../services/notifications/notification-service.js';
import { runFrontDoorWrite } from './front-door-step-up.js';

/** What these routes are called in a refusal. */
const SUBJECT = 'sign-in checks';

/** Longest label kept. */
const MAX_LABEL = 60;

/**
 * The owner asking, with their sign-in, or the refusal. A change also needs
 * the classifier's this-computer verdict.
 */
function ownerOf(
  c: Context<ApiEnv>,
  change: boolean,
  facts: RequestFacts = honoRequestFacts(c)
): { userId: string; sessionId: string } | Response {
  const refusal = refuseFrontDoorChange(facts, SUBJECT);
  if (refusal) return c.json(errorBody(refusal.error, refusal.code), 403);
  if (change && classifyRequest(facts, currentServerRole()).kind !== 'this-computer') {
    return c.json(
      errorBody(
        'Change sign-in checks on the computer DorkOS runs on.',
        NEEDS_PERSON_AT_THIS_COMPUTER
      ),
      403
    );
  }
  const owner = readOwnerAccount();
  const sessionId = facts.user?.sessionId;
  if (!owner || facts.user?.userId !== owner.id || !sessionId) {
    return c.json(errorBody('Sign in to change sign-in checks.', 'SIGN_IN_FIRST'), 403);
  }
  return { userId: owner.id, sessionId };
}

/**
 * After the owner's first check that works from other devices is confirmed,
 * sign out every sign-in they made from another device before it, which a
 * password alone made. The sign-in confirming it, and this computer's, stay.
 *
 * @param owner - The owner and the confirming sign-in.
 * @param first - Whether no such check had existed before this one.
 */
async function endSignInsFromBefore(
  owner: { userId: string; sessionId: string },
  first: boolean
): Promise<void> {
  if (!first) return;
  const auth = getAuth();
  // Nothing to end them with: refuse rather than go on with them signed in.
  if (!auth) throw new Error('Sign-in is not set up.');
  await signOutSessionsAway(auth, owner.userId, owner.sessionId);
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
    const owner = ownerOf(c, false);
    if (owner instanceof Response) return owner;
    return c.json({ factors: listOwnerFactors(owner.userId) });
  });

  router.post('/passkeys/options', async (c) => {
    const owner = ownerOf(c, true);
    if (owner instanceof Response) return owner;
    const body = (readJsonBody(c) ?? null) as { label?: unknown; passkey?: unknown } | null;
    const label = labelOf(body, 'Passkey');
    const origin = String(c.req.header('origin'));
    // Only the first passkey is added on a password alone: once there is one,
    // adding another takes a check with it.
    const checked = await passkeyChecked(c, owner, 'owner-factor-add-passkey', body?.passkey, {
      ifAny: true,
    });
    if (checked !== true) return checked;
    return runFrontDoorWrite(c, {
      kind: 'owner-factor.change',
      target: 'passkey',
      input: { add: 'passkey', label, origin },
      reason: 'Add a passkey to your DorkOS account.',
      subject: SUBJECT,
      run: async (confirming) => {
        const who = ownerOf(c, true, confirming);
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
            errorBody('Add a passkey in the DorkOS app on this computer.', 'PASSKEY_ORIGIN'),
            403
          );
        }
        return c.json({ options });
      },
    });
  });

  router.post('/passkeys/finish', async (c) => {
    const owner = ownerOf(c, true);
    if (owner instanceof Response) return owner;
    const body = (readJsonBody(c) ?? null) as { response?: unknown } | null;
    if (!body?.response || typeof body.response !== 'object') {
      return c.json(errorBody('Send the new passkey.', 'INVALID_BODY'), 400);
    }
    const first = !everHadRemoteFactor(owner.userId);
    const added = await finishAddingPasskey({
      userId: owner.userId,
      sessionId: owner.sessionId,
      response: body.response as RegistrationResponseJSON,
    });
    if (typeof added === 'string') {
      return c.json(errorBody('That passkey wasn’t added. Try again.', 'PASSKEY_REFUSED'), 400);
    }
    const here = thisComputerPasskeyOrigins().some(
      (origin) => new URL(origin).hostname === added.host
    );
    recordSignInTrustChange(owner.userId, here ? 'passkey-added-here' : 'passkey-added');
    if (!here) await endSignInsFromBefore(owner, first);
    void notify('signin.check_added', {
      factorId: added.factorId,
      kind: 'passkey',
      host: added.host,
    });
    return c.json({ id: added.factorId, host: added.host });
  });

  router.post('/authenticator/start', async (c) => {
    const owner = ownerOf(c, true);
    if (owner instanceof Response) return owner;
    const body = (readJsonBody(c) ?? null) as { label?: unknown; passkey?: unknown } | null;
    const label = labelOf(body, 'Authenticator app');
    // With a passkey on this computer, it is checked too: a password alone,
    // even one a browser filled in, never adds a sign-in check here.
    const checked = await passkeyChecked(
      c,
      owner,
      'owner-factor-add-authenticator',
      body?.passkey,
      {
        ifAny: true,
      }
    );
    if (checked !== true) return checked;
    return runFrontDoorWrite(c, {
      kind: 'owner-factor.change',
      target: 'authenticator',
      input: { add: 'authenticator', label },
      reason: 'Add an authenticator app to your DorkOS account.',
      subject: SUBJECT,
      run: async (confirming) => {
        const who = ownerOf(c, true, confirming);
        if (who instanceof Response) return who;
        const secret = newTotpSecret();
        const id = await addPendingTotp(who.userId, label, secret);
        const account = getUserById(who.userId)?.email ?? 'owner';
        return c.json({ id, secret, uri: totpUri(secret, account) });
      },
    });
  });

  router.post('/authenticator/confirm', async (c) => {
    const owner = ownerOf(c, true);
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
      return c.json(errorBody('That code didn’t match. Try the newest one.', 'CODE_REFUSED'), 400);
    }
    const first = !everHadRemoteFactor(owner.userId);
    // The earlier sign-ins end first: if that fails, the check is not confirmed.
    await endSignInsFromBefore(owner, first);
    confirmTotp(factor.id, step);
    recordSignInTrustChange(owner.userId, 'authenticator-added');
    // And again, for any made in the moment between.
    await endSignInsFromBefore(owner, first);
    void notify('signin.check_added', { factorId: factor.id, kind: 'authenticator' });
    return c.json({ id: factor.id });
  });

  router.delete('/:id', async (c) => {
    const owner = ownerOf(c, true);
    if (owner instanceof Response) return owner;
    const id = c.req.param('id');
    const factor = findOwnerFactor(owner.userId, id);
    if (!factor) {
      return c.json(errorBody('That sign-in check is already gone.', 'NOT_FOUND'), 404);
    }
    const body = (readJsonBody(c) ?? null) as { passkey?: unknown } | null;
    const checked = await passkeyChecked(c, owner, `owner-factor-remove:${id}`, body?.passkey, {
      ifAny: true,
    });
    if (checked !== true) return checked;
    return runFrontDoorWrite(c, {
      kind: 'owner-factor.change',
      target: id,
      input: { remove: id },
      reason: 'Remove this sign-in check.',
      subject: SUBJECT,
      run: async (confirming) => {
        const who = ownerOf(c, true, confirming);
        if (who instanceof Response) return who;
        if (!removeOwnerFactor(who.userId, id)) {
          return c.json(errorBody('That sign-in check is already gone.', 'NOT_FOUND'), 404);
        }
        recordSignInTrustChange(who.userId, 'factor-removed');
        // A pending authenticator was never a sign-in check: nothing to tell.
        if (factor.confirmedAt !== null) {
          void notify('signin.check_removed', {
            factorId: id,
            kind: factor.kind === 'passkey' ? 'passkey' : 'authenticator',
          });
        }
        return c.body(null, 204);
      },
    });
  });

  return router;
}
