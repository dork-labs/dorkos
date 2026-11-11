/**
 * The one place a person lets a mini app read a connected app (DOR-3547): a
 * page DorkOS renders on its own, outside the app, so no mini app code is on
 * it. Every page inside the app runs mini app code in the same window and
 * shares its `fetch`, so a yes given there could be pressed by that code.
 *
 * - `GET /api/connectors/mini-app-access/page?extension=&service=` answers
 *   only a real page load (`Sec-Fetch-Dest: document`, `Sec-Fetch-Mode:
 *   navigate`, which no page script can set), never a `fetch` or a frame,
 *   and only for the owner at the app. It reads what waits from the server,
 *   draws a one-time token and sets that page's cookie.
 * - `GET …/page.js` and `…/page.css`: its only script and styles, static.
 * - `POST …/decision` needs the token, the cookie, the same session,
 *   `Sec-Fetch-Site: same-origin` and DorkOS's own `Origin`, besides the owner
 *   check every account decision passes. The mini app's files must still be
 *   the ones the page showed.
 *
 * Every answer here carries a CSP that loads nothing but these files, COOP
 * `same-origin` (a window a mini app opened loses its handle on it), no
 * caching, no referrer and no sniffing. Service workers can't sit in front of
 * it: only DorkOS's own installs (`middleware/service-worker-guard.ts`).
 *
 * @module routes/mini-app-access-page
 */
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { ExtensionConnectionError } from '@dorkos/extension-api/server';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { resolveTrustedOrigins } from '../lib/trusted-origins.js';
import type { MiniAppAccess } from '../services/connectors/extensions/mini-app-access.js';
import {
  DECISION_TOKEN_TTL_MS,
  MiniAppDecisionTokens,
} from '../services/connectors/extensions/mini-app-decision-tokens.js';
import {
  ownerRefusal,
  requestUser,
  resolveConnectorOperator,
  type ConnectorOwnerBoundaryDeps,
} from './connector-owner-boundary.js';
import {
  MINI_APP_ACCESS_PAGE_SCRIPT,
  MINI_APP_ACCESS_PAGE_STYLES,
  decidePage,
  nothingWaitingPage,
} from './mini-app-access-page-assets.js';

/** Where the page, its files and its decision live, under `/api/connectors`. */
const BASE = '/mini-app-access';

/** The cookie only the page's own response sets, scoped to these routes. */
const COOKIE = 'dorkos_mini_app_access';

/** Loads nothing but this page's own two files, and talks only to this server. */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** What the page routes read. */
export interface MiniAppAccessPageRouterDeps extends ConnectorOwnerBoundaryDeps {
  /** The view, or `undefined` before the connection services are wired. */
  readonly access: () => MiniAppAccess | undefined;
  /** The one-time tokens; one store per server. */
  readonly tokens?: MiniAppDecisionTokens;
}

const DecisionBodySchema = z.object({
  token: z.string().min(1).max(200),
  decision: z.enum(['approve', 'deny']),
  connectionId: z.string().min(1).max(200).optional(),
});

/** Every answer from these routes: no framing, no caching, no referrer, no sniffing. */
function lockDown(c: Context<ApiEnv>): void {
  c.header('Content-Security-Policy', PAGE_CSP);
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
}

/** The session deciding: the account with login on, the one local person otherwise. */
function sessionKeyOf(c: Context<ApiEnv>): string {
  return requestUser(c)?.userId ?? 'local';
}

/** Whether this request is a real top-level page load, not a script's fetch or a frame. */
function isPageLoad(c: Context<ApiEnv>): boolean {
  const headers = c.env.incoming.headers;
  return headers['sec-fetch-dest'] === 'document' && headers['sec-fetch-mode'] === 'navigate';
}

/**
 * Build the decide page's routes, for mounting under `/api/connectors`.
 *
 * @param deps - See {@link MiniAppAccessPageRouterDeps}.
 * @returns The routes.
 */
export function createMiniAppAccessPageRoutes(deps: MiniAppAccessPageRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  const tokens = deps.tokens ?? new MiniAppDecisionTokens();

  router.get(`${BASE}/page`, (c) => {
    lockDown(c);
    if (!isPageLoad(c)) {
      return ownerRefusal(c, 'mini_app_access_page_only', 'Open this page in the browser.');
    }
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const extensionId = c.req.query('extension') ?? '';
    const service = c.req.query('service') ?? '';
    const request = deps.access()?.describe(extensionId, service);
    if (!request) return c.html(nothingWaitingPage());
    const { token, cookie } = tokens.issue({
      extensionId,
      service,
      filesDigest: request.filesDigest,
      sessionKey: sessionKeyOf(c),
    });
    setCookie(c, COOKIE, cookie, {
      path: `/api/connectors${BASE}`,
      httpOnly: true,
      sameSite: 'Strict',
      maxAge: DECISION_TOKEN_TTL_MS / 1000,
    });
    return c.html(decidePage(request, token));
  });

  router.get(`${BASE}/page.js`, (c) => {
    lockDown(c);
    return c.body(MINI_APP_ACCESS_PAGE_SCRIPT, 200, {
      'Content-Type': 'text/javascript; charset=utf-8',
    });
  });

  router.get(`${BASE}/page.css`, (c) => {
    lockDown(c);
    return c.body(MINI_APP_ACCESS_PAGE_STYLES, 200, { 'Content-Type': 'text/css; charset=utf-8' });
  });

  router.post(`${BASE}/decision`, async (c) => {
    lockDown(c);
    const headers = c.env.incoming.headers;
    const origin = headers.origin;
    const trusted = deps.trustedOrigins?.() ?? resolveTrustedOrigins();
    if (headers['sec-fetch-site'] !== 'same-origin' || !origin || !trusted.includes(origin)) {
      return ownerRefusal(c, 'mini_app_access_same_page', 'Decide on the DorkOS page itself.');
    }
    const owner = resolveConnectorOperator(c, deps);
    if (owner instanceof Response) return owner;
    const parsed = DecisionBodySchema.safeParse(await readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'Open the page again.', code: 'MINI_APP_ACCESS_BAD_DECISION' }, 400);
    }
    const ticket = tokens.redeem(parsed.data.token, getCookie(c, COOKIE), sessionKeyOf(c));
    if (!ticket) {
      return c.json(
        {
          error: 'This page ran out or was already used. Open it again.',
          code: 'MINI_APP_ACCESS_STALE',
        },
        403
      );
    }
    if (parsed.data.decision === 'deny') {
      return c.json({ status: 'denied', message: 'Nothing changed. You can close this page.' });
    }
    if (!parsed.data.connectionId) {
      return c.json({ error: 'Pick an account first.', code: 'MINI_APP_ACCESS_NO_ACCOUNT' }, 400);
    }
    const access = deps.access();
    if (!access) {
      return c.json(
        { error: 'DorkOS is still starting. Try again.', code: 'MINI_APP_ACCESS_UNAVAILABLE' },
        503
      );
    }
    try {
      const result = access.approve({
        extensionId: ticket.extensionId,
        service: ticket.service,
        connectionId: parsed.data.connectionId,
        filesDigest: ticket.filesDigest,
        approvedBy: sessionKeyOf(c),
      });
      return c.json({
        status: 'approved',
        granted: result.granted,
        message: 'Done. It can read that account now. You can close this page.',
      });
    } catch (err) {
      if (err instanceof ExtensionConnectionError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      throw err;
    }
  });

  return router;
}
