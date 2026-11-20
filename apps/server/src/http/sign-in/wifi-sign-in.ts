/**
 * A device on Wi-Fi asks to sign in, and trades a code from this computer for
 * its sign-in (DOR-4744; `services/core/auth/sessions/wifi-sign-in-requests.ts`).
 *
 * - `POST /api/wifi-sign-in/start`: open a request. Answers its secret id, the
 *   short match code to show, and what the device is called at the computer.
 * - `POST /api/wifi-sign-in/finish`: `{ requestId, code }`. Sets the Wi-Fi
 *   sign-in cookie when the code is the one this computer showed for that request.
 *
 * Mounted before the session gate, as Better Auth's own routes are, because
 * the device has no sign-in yet. Both answer only a request the Wi-Fi listener
 * admitted (its own mark, never an address or a header), sent as JSON by one
 * of this server's own pages. Approving a request happens elsewhere, at this
 * computer (`routes/devices.ts`).
 *
 * @module http/sign-in/wifi-sign-in
 */
import type { Hono } from 'hono';

import { describeUserAgent } from '../../lib/http/user-agent.js';
import { isOwnOriginJsonWrite } from '../../lib/http/own-origin-write.js';
import { classifyRequest } from '../../lib/request-classifier.js';
import { currentServerRole } from '../../lib/server-role.js';
import type { Auth } from '../../services/core/auth/index.js';
import { withRegistrationCaller } from '../../services/core/auth/registration-policy.js';
import {
  redeemWifiSignIn,
  startWifiSignIn,
} from '../../services/core/auth/sessions/wifi-sign-in-requests.js';
import { ingressOf } from '../../services/core/remote/ingress-mark.js';
import type { ApiEnv } from '../api-chain.js';
import { honoRequestFacts } from '../request-facts.js';
import { deviceHeaders } from './device-headers.js';

/** The longest request id or code read. */
const MAX_FIELD = 128;

/**
 * Mount the two routes.
 *
 * @param app - The early app, before the session gate.
 * @param auth - Better Auth, for the server-only sign-in.
 */
export function mountWifiSignIn(app: Hono<ApiEnv>, auth: Auth): void {
  const refused = { error: 'That didn’t work. Ask for a new code on the computer DorkOS runs on.' };

  app.post('/api/wifi-sign-in/start', async (c) => {
    if (ingressOf(c.env.incoming) !== 'wifi') return c.json({ error: 'Not found' }, 404);
    const facts = honoRequestFacts(c);
    if (!isOwnOriginJsonWrite(facts.headers)) return c.json(refused, 403);
    const deviceName = describeUserAgent(facts.headers['user-agent']);
    const started = startWifiSignIn({ deviceName, address: facts.peerAddress ?? 'unknown' });
    c.header('Cache-Control', 'no-store');
    if (!started) {
      return c.json({ error: 'Too many sign-in requests. Try again in a few minutes.' }, 429);
    }
    // What this device is called at the computer, so the person can find it there.
    return c.json({ ...started, deviceName });
  });

  app.post('/api/wifi-sign-in/finish', async (c) => {
    if (ingressOf(c.env.incoming) !== 'wifi') return c.json({ error: 'Not found' }, 404);
    const facts = honoRequestFacts(c);
    c.header('Cache-Control', 'no-store');
    if (!isOwnOriginJsonWrite(facts.headers)) return c.json(refused, 403);
    const body = (await c.req.json().catch(() => null)) as {
      requestId?: unknown;
      code?: unknown;
    } | null;
    const { requestId, code } = body ?? {};
    if (
      typeof requestId !== 'string' ||
      typeof code !== 'string' ||
      requestId.length > MAX_FIELD ||
      code.length > MAX_FIELD
    ) {
      return c.json(refused, 400);
    }
    const redeemed = redeemWifiSignIn(requestId, code);
    if ('refusal' in redeemed) {
      return redeemed.refusal === 'too-many-tries'
        ? c.json({ error: 'Too many tries. Ask for a new code.' }, 429)
        : c.json(refused, 401);
    }
    // Inside the request's class, so the session is stamped `wifi`.
    const requestClass = classifyRequest(facts, currentServerRole());
    const { headers } = await withRegistrationCaller(requestClass, () =>
      auth.api.signInCheckedAccount({
        body: { userId: redeemed.userId },
        // The device's own browser, so Signed-in devices can name it.
        headers: deviceHeaders(facts.headers),
        returnHeaders: true,
      })
    );
    for (const cookie of headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
    return c.json({ ok: true });
  });
}
