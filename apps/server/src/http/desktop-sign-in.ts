/**
 * `POST /api/desktop/sign-in`: the desktop window trades a one-time code for
 * the owner's session cookie (F3, DOR-2966; `services/core/auth/desktop-sign-in.ts`).
 *
 * Mounted before the session gate, as Better Auth's own routes are, because
 * the window has no session yet. It answers only when the desktop app runs
 * this server, and only a request from this computer that no other site's page
 * sent.
 *
 * @module http/desktop-sign-in
 */
import type { Hono } from 'hono';

import { env } from '../env.js';
import { classifyRequest } from '../lib/request-classifier.js';
import { currentServerRole } from '../lib/server-role.js';
import type { Auth } from '../services/core/auth/index.js';
import { takeDesktopSignInCode } from '../services/core/auth/desktop-sign-in.js';
import { withRegistrationCaller } from '../services/core/auth/registration-policy.js';
import type { ApiEnv } from './api-chain.js';
import { honoRequestFacts } from './request-facts.js';

/** What `Sec-Fetch-Site` may say: the window's own page, or no page at all. */
const OWN_PAGE_OR_NONE = new Set(['same-origin', 'none']);

/**
 * Mount the route.
 *
 * @param app - The early app, before the session gate.
 * @param auth - Better Auth, for the server-only sign-in.
 */
export function mountDesktopSignIn(app: Hono<ApiEnv>, auth: Auth): void {
  app.post('/api/desktop/sign-in', async (c) => {
    if (env.DORKOS_MANAGED_BY !== 'desktop') return c.json({ error: 'Not found' }, 404);
    const facts = honoRequestFacts(c);
    const site = facts.headers['sec-fetch-site'];
    const requestClass = classifyRequest(facts, currentServerRole());
    if (
      requestClass.kind !== 'this-computer' ||
      (site !== undefined && !OWN_PAGE_OR_NONE.has(String(site)))
    ) {
      return c.json({ error: 'Only this computer’s DorkOS window can do this.' }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
    const userId = typeof body?.code === 'string' ? takeDesktopSignInCode(body.code) : null;
    if (!userId) return c.json({ error: 'This sign-in has expired. Restart DorkOS.' }, 401);
    // Inside the request's class, so the session is stamped `local` like any
    // other sign-in made at this computer (`session-route.ts`, DOR-2969).
    const { headers } = await withRegistrationCaller(requestClass, () =>
      auth.api.signInDesktopOwner({ body: { userId }, returnHeaders: true })
    );
    for (const cookie of headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
    return c.json({ ok: true });
  });
}
