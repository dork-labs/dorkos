/**
 * The owner signs in with a passkey, no password (DOR-3647;
 * `services/core/auth/factors/owner-passkeys.ts` holds the checks).
 *
 * - `POST /api/owner-sign-in/passkey/options`: a challenge for the passkeys
 *   made for this origin's host.
 * - `POST /api/owner-sign-in/passkey/finish`: `{ response }`. Sets the sign-in
 *   cookie when the passkey checks out.
 *
 * Mounted before the session gate, as Better Auth's own routes are, because
 * nobody is signed in yet. Never over Wi-Fi: a browser offers passkeys only on
 * a secure page. Only as JSON from one of this server's own pages, and the
 * sign-in attempt limit (`middleware/auth-rate-limit.ts`) counts every finish.
 *
 * @module http/sign-in/owner-passkey-sign-in
 */
import type { Context, Hono } from 'hono';
import { problem } from '@dorkos/http-kit';
import type { ProblemCode } from '@dorkos/shared/problem';
import { apiNotFound } from '../unclaimed.js';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';

import { isOwnOriginJsonWrite } from '../../lib/http/own-origin-write.js';
import { classifyRequest } from '../../lib/request-classifier.js';
import { currentServerRole } from '../../lib/server-role.js';
import { readOwnerAccount, type Auth } from '../../services/core/auth/index.js';
import {
  finishPasskeyCheck,
  startPasskeyCheck,
} from '../../services/core/auth/factors/owner-passkeys.js';
import { withRegistrationCaller } from '../../services/core/auth/registration-policy.js';
import { ingressOf } from '../../services/core/remote/ingress-mark.js';
import type { ApiEnv } from '../api-chain.js';
import { honoRequestFacts } from '../request-facts.js';
import { deviceHeaders } from './device-headers.js';

/** The path the finish answers on. */
export const OWNER_PASSKEY_FINISH_PATH = '/api/owner-sign-in/passkey/finish';

/**
 * Mount the two routes, after `mountBetterAuth` so its attempt limit runs first.
 *
 * @param app - The early app, before the session gate.
 * @param auth - Better Auth, for the server-only sign-in.
 */
export function mountOwnerPasskeySignIn(app: Hono<ApiEnv>, auth: Auth): void {
  // One sentence whatever the reason, so it says nothing about which addresses have a passkey.
  const refused = (c: Context, code: ProblemCode): Response =>
    problem(c, code, { detail: 'That passkey didn’t sign you in. Try again.' });

  app.post('/api/owner-sign-in/passkey/options', async (c) => {
    if (ingressOf(c.env.incoming) === 'wifi') return apiNotFound(c);
    const facts = honoRequestFacts(c);
    c.header('Cache-Control', 'no-store');
    if (!isOwnOriginJsonWrite(facts.headers)) return refused(c, 'origin_not_allowed');
    const owner = readOwnerAccount();
    if (!owner) return refused(c, 'not_found');
    const options = await startPasskeyCheck(
      { kind: 'sign-in', userId: owner.id },
      String(facts.headers.origin)
    );
    // One answer whatever the reason, so it says nothing about which addresses have a passkey.
    if (typeof options === 'string') return refused(c, 'forbidden');
    return c.json({ options });
  });

  app.post(OWNER_PASSKEY_FINISH_PATH, async (c) => {
    if (ingressOf(c.env.incoming) === 'wifi') return apiNotFound(c);
    const facts = honoRequestFacts(c);
    c.header('Cache-Control', 'no-store');
    if (!isOwnOriginJsonWrite(facts.headers)) return refused(c, 'origin_not_allowed');
    const owner = readOwnerAccount();
    const body = (await c.req.json().catch(() => null)) as { response?: unknown } | null;
    if (!owner || !body?.response || typeof body.response !== 'object') {
      return refused(c, 'invalid_request');
    }
    const checked = await finishPasskeyCheck(
      { kind: 'sign-in', userId: owner.id },
      body.response as AuthenticationResponseJSON
    );
    if (typeof checked === 'string') return refused(c, 'passkey_refused');
    const requestClass = classifyRequest(facts, currentServerRole());
    const { headers } = await withRegistrationCaller(requestClass, () =>
      auth.api.signInCheckedAccount({
        body: { userId: checked.userId },
        // The device's own browser, so Signed-in devices can name it.
        headers: deviceHeaders(facts.headers),
        returnHeaders: true,
      })
    );
    for (const cookie of headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
    return c.json({ ok: true });
  });
}
