/**
 * The bar every WRITE on the extensions router runs: is a person asking?
 *
 * Four routes reach it, and they all move a leaf of `extensions` — a section
 * whose every leaf is `operator-only` in `config-write-policy.ts`:
 *
 * | Route                                | Writes                                |
 * | ------------------------------------ | ------------------------------------- |
 * | `POST /api/extensions/:id/enable`    | `extensions.enabled` / `.disabled`    |
 * | `POST /api/extensions/:id/disable`   | `extensions.enabled` / `.disabled`    |
 * | `POST /api/extensions/:id/approve`   | `extensions.approvedToRun`            |
 * | `POST /api/extensions/:id/revoke`    | `extensions.approvedToRun`            |
 *
 * The `ExtensionManager` writes those leaves straight through `configManager`,
 * as a **purpose-built writer** is licensed to (`config-write.ts` argues the
 * split, and `contributing/configuration.md` tabulates it). The bargain that
 * makes that safe is that the writer's own door carries the gate. This module
 * is that gate, once, so a friendlier route on the same router cannot become
 * the cheap way in — the DOR-467 failure shape, where enforcement sat on one
 * surface and another walked around it.
 *
 * It was two implementations until DOR-1507, and the second one was missing:
 * approve and revoke ran all three bars while enable and disable ran none, so
 * an agent could turn an extension on through a plain HTTP call that
 * `PATCH /api/config` would have refused it. The DOR-1738 tunnel route is the
 * same shape one router over, gated the same way.
 *
 * ## The three bars, in the order they run
 *
 * 1. **The trusted-`Origin` bar.** These routes are reachable by a plain
 *    cross-site `fetch`, so a browser that sends an `Origin` must send one
 *    DorkOS trusts. Without it, any page a person visits could POST through
 *    their browser — no cookie required in the default posture — and CORS does
 *    not help, since it withholds the RESPONSE while the write has already
 *    happened.
 *
 *    The allowlist is the SERVER's (`resolveTrustedOrigins`, the repo's single
 *    origin policy), and membership is exact. It deliberately does not compare
 *    the `Origin` against anything derived from the request: an earlier version
 *    allowed an origin equal to `${req.protocol}://${req.headers.host}`,
 *    borrowed from the CORS delegate in `app.ts` to cover port remaps, and that
 *    is precisely what DNS rebinding defeats — the browser sends
 *    `Host: evil.example` AND `Origin: http://evil.example`, they match, and the
 *    bar never runs. An expected value taken from the request cannot judge the
 *    request. `middleware/mcp-origin.ts` has always done it this way and names
 *    this attack outright.
 *
 *    Requests with no `Origin` (curl, the CLI, the desktop shell) pass, the same
 *    allowance `validateMcpOrigin` makes for the same reason: only browsers send
 *    the header, so only browsers can be judged by it. All four routes are
 *    POST-only, and browsers have sent `Origin` on every POST — `fetch`,
 *    `XMLHttpRequest`, and plain form submission — for years, so a browser
 *    cannot reach that branch.
 *
 *    The cost, stated: a deployment that serves the app on an origin other than
 *    DorkOS's own port (a container published on a different host port) is
 *    refused here even though CORS lets it through. Every documented Docker
 *    invocation publishes `4242:4242`, and the tunnel origin is in the trusted
 *    set, so the shipped paths are covered. `DORKOS_CORS_ORIGIN` is NOT
 *    consulted on purpose: "which sites may read my responses" is a different
 *    question from "which page may change which code this server runs", and
 *    quietly answering the second with the first is how a convenience setting
 *    becomes an authorization one.
 *
 * 2. **The cookie bar.** With login on, prove you are a person in the app.
 *    Allows everyone while login is off, because then nobody has a cookie.
 *
 * 3. **The agent bar.** Anything presenting agent identity or an approval token
 *    is refused in every posture.
 *
 * Bars 2 and 3 are deliberately the SAME two, in the same order, that
 * `PATCH /api/config` runs for an `operator-only` path — because that is exactly
 * what these routes write. Keeping them identical is the point: one setting, one
 * bar, wherever it is written.
 *
 * ## The residual, named rather than papered over
 *
 * In the login-off posture the agent bar is the only one left, so the honest
 * guarantee is "an agent that names itself cannot change which extensions run",
 * not "only a proven person can". A caller that omits its `X-DorkOS-Agent`
 * header is trusted here, exactly as it is on `PATCH /api/config` (DOR-505's
 * documented residual). Turning on Require login closes it.
 *
 * ## Why the narrowing direction is barred too
 *
 * `/disable` and `/revoke` only ever turn code OFF, and the tunnel route leaves
 * its `/stop` ungated on exactly that reasoning. Extensions do not follow it.
 * `operator-only` is a rule about PATHS and never about values —
 * `config-write-policy.ts` says so and a drift guard pins it — so an agent may
 * not switch a person's extensions off on their behalf either. Silently
 * disabling the extension somebody's workflow depends on is not a favour.
 *
 * @module routes/extensions-person-bar
 */
import type { Request, Response } from 'express';
import { trustedCaller } from '../services/core/capabilities/index.js';
import { readCallerAuthority, requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import { resolveTrustedOrigins } from '../lib/trusted-origins.js';

/**
 * What one surface calls itself when it refuses, so the reader is told what
 * DorkOS did not do and what to do instead — never a bare code.
 *
 * Passed in rather than derived, because the two surfaces answer with different
 * vocabularies on purpose: approving is a security decision and answers with
 * `extension_not_approved_to_run`, while turning one on is an operator-only
 * config write and answers with `operator_only_config`, the same code
 * `PATCH /api/config` gives for the same paths.
 */
export interface PersonBarCopy {
  /** The headline, the same for every refusal from this surface. */
  error: string;
  /** Machine-readable code for the origin and agent bars. */
  code: string;
  /**
   * What the cookie bar names as the thing being changed, as a noun phrase that
   * completes "only a person signed in to DorkOS can change …".
   */
  subject: string;
  /**
   * The body for a request that arrived from another site, given that site's
   * origin. Say what the page tried to do, in the person's words.
   */
  crossSite: (origin: string) => string;
  /** The body for a caller that named itself an agent. */
  agent: string;
}

/**
 * Run the three bars, answering the request when any of them refuses.
 *
 * @param req - The request, read for `Origin` and for the agent-identity and
 *   approval-token headers.
 * @param res - The response, read for a resolved session user and written on
 *   refusal.
 * @param copy - What this surface says when it refuses.
 * @returns `true` when the request was already answered, so the caller must
 *   return immediately without performing its effect.
 */
export function refuseIfNotAPerson(req: Request, res: Response, copy: PersonBarCopy): boolean {
  const origin = req.headers.origin;
  if (origin && !resolveTrustedOrigins().includes(origin)) {
    res.status(403).json({ error: copy.error, code: copy.code, message: copy.crossSite(origin) });
    return true;
  }

  const cookieRefusal = requireOperatorCookieUnderLogin(res, copy.subject);
  if (cookieRefusal) {
    res
      .status(cookieRefusal.status)
      .json({ error: copy.error, code: cookieRefusal.code, message: cookieRefusal.error });
    return true;
  }

  if (!trustedCaller(readCallerAuthority(req, res))) {
    res.status(403).json({ error: copy.error, code: copy.code, message: copy.agent });
    return true;
  }

  return false;
}
