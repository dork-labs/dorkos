/**
 * The CORS rule the chain applies: which browser origins may read this
 * server's responses, and what a refused origin is answered with.
 *
 * The chain applies it through `hono/cors` (`http/api-chain.ts`), which
 * decides nothing of its own.
 *
 * @module http/cors-policy
 */
import { logger } from '../lib/logger.js';
import { type BrowserOriginPolicy, isTrustedBrowserOrigin } from '../lib/trusted-origins.js';
import { resolveBrowserOriginFacts } from '../middleware/browser-origin.js';
import type { RequestFacts } from './request-facts.js';

/**
 * What the CORS layer asks of the one origin policy
 * (`isTrustedBrowserOrigin` in `lib/trusted-origins.ts`).
 *
 * `allowNoOrigin` keeps server-to-server and `curl` traffic working: a request
 * with no `Origin` is not a browser, and CORS exists to answer browsers.
 *
 * `pairSameOriginWithHost` is the one place a DorkOS surface turns the pairing
 * off. Duplicating it here would refuse the shipped container reached at a NAME
 * — `DORKOS_ALLOW_INSECURE_BIND` makes `hostGuard` stand down without putting
 * that name on any allowlist — turning a working deployment into a blank window.
 *
 * On `/api` that costs nothing: `middleware/host-guard.ts` runs right after
 * CORS in the chain and refuses exactly the rebound `Host` the pairing would have.
 * This handler is app-wide, though, so it also answers mounts `hostGuard` never
 * sees — `/a2a`, the static SPA assets — and there the pairing is simply absent
 * rather than relocated. That is not an exploit, and the reason is worth stating
 * rather than glossing: CORS is not a gate. A DNS-rebound page is SAME-ORIGIN to
 * the browser, so it sends no preflight and reads the response whatever this
 * layer answers; refusing it here would withhold a header nobody was waiting on.
 * What actually stops rebinding on those mounts is the mount's own guard — the
 * A2A exposure guard and its auth, and the fact that static assets are the same
 * bytes any visitor may fetch. The surfaces where this layer IS the only origin
 * check — the MCP family, the WebSocket upgrade — pair.
 */
const CORS_ORIGIN_POLICY: BrowserOriginPolicy = {
  allowNoOrigin: true,
  pairSameOriginWithHost: false,
};

/**
 * Whether CORS lets this request's `Origin` read the response.
 *
 * Every decision is delegated to `isTrustedBrowserOrigin`, the single origin
 * policy this repo has (DOR-1711) — the same predicate `middleware/mcp-origin.ts`
 * and the WebSocket upgrade router read. What used to live here as its own
 * branch list now lives there as branches 0-4, and `DORKOS_CORS_ORIGIN` is one
 * of them rather than an early return that replaced the whole policy.
 *
 * That last part is the behaviour change worth naming: setting the variable no
 * longer switches CORS to a bare static allowlist. It adds to the policy, so
 * `localhost` and a live tunnel stay trusted alongside the operator's list. The
 * socket path has always worked that way and says why — "locking the operator
 * out of `localhost` for setting a production allowlist would be an outage, not
 * a boundary" — and while the two disagreed, an operator who set the variable
 * got an app that rendered at `localhost` and could not fetch, which is the
 * silent-outage shape this whole change is about.
 *
 * A `*` is **not** an allowlist and is ignored. The argument that once justified
 * honouring it here — a wildcard `Access-Control-Allow-Origin` is invalid for
 * credentialed requests, so browsers reject it — only covers the credentialed
 * case, and the shipped default posture is `auth.enabled: false`, where the API
 * asks for no credential at all. In that posture a wildcard turns any page the
 * operator visits into a full API client for their DorkOS: it reads sessions,
 * files and diffs cross-origin and POSTs turns back. The operator gets one
 * warning line naming the variable and what to set instead, and the request
 * falls through to the rest of the policy, so an install that reached for `*` to
 * fix a proxy keeps working for every origin that is genuinely its own.
 *
 * @param facts - The request's facts (`http/request-facts.ts`).
 * @returns `true` when the origin may read the response.
 */
export function corsAllowsOrigin(facts: RequestFacts): boolean {
  // An absent `Origin` is what the policy's no-Origin branch reads. Everything
  // else — the loopback origins, a live tunnel, `DORKOS_CORS_ORIGIN`,
  // same-origin — is the policy's to answer.
  return isTrustedBrowserOrigin(
    resolveBrowserOriginFacts(facts, { hostCheckInert: false }),
    CORS_ORIGIN_POLICY
  );
}

/**
 * A browser origin this server does not answer. It is the caller's to fix, not
 * a server fault, so the chain's error handler answers `403` with its code and
 * logs a warning rather than an error (`middleware/error-handler.ts`).
 *
 * It used to be a bare `Error`, the `cors` package's own behaviour, which every
 * route answered as `500 INTERNAL_ERROR` with an ERROR log line — a page on a
 * foreign origin posting with a person's cookie looked like a server crash.
 */
export class OriginRefusedError extends Error {
  readonly code = 'ORIGIN_NOT_ALLOWED';
  readonly status = 403;

  constructor(readonly origin: string | undefined) {
    super(
      `This instance does not answer to pages from "${origin}". If that is how you reach DorkOS, list it in DORKOS_CORS_ORIGIN, or open DorkOS at its own address.`
    );
    this.name = 'OriginRefusedError';
  }
}

/**
 * The error a refused origin raises; it reaches the chain's error handler.
 *
 * @param origin - The refused `Origin` header.
 */
export function corsRefusal(origin: string | undefined): OriginRefusedError {
  return new OriginRefusedError(origin);
}

/**
 * Warn once per chain, at build time, when `DORKOS_CORS_ORIGIN` is a wildcard:
 * it is ignored, and the operator should learn why and what to set instead.
 */
export function warnOnWildcardCorsOrigin(): void {
  // Trimmed, so a value that is whitespace around a wildcard (or whitespace
  // around nothing) is read as what the operator meant rather than becoming a
  // one-entry allowlist of `" * "` that matches no origin at all and warns
  // about nothing. `parseConfiguredOrigins` — which is what the policy itself
  // reads — trims the same way, so the warning and the decision cannot drift.
  // eslint-disable-next-line no-restricted-syntax -- DORKOS_CORS_ORIGIN is not in env.ts (optional CORS override, not worth validating)
  const envOrigin = process.env.DORKOS_CORS_ORIGIN?.trim();

  // A wildcard is no list at all — say so once at boot, then let the policy
  // decide every request.
  if (envOrigin === '*') {
    logger.warn(
      '[CORS] DORKOS_CORS_ORIGIN="*" is ignored: a wildcard would let any web page ' +
        'you visit read and write this DorkOS. Set it to the exact origins that need ' +
        'access instead (comma-separated, e.g. https://dorkos.example.com) and restart.'
    );
  }
}
