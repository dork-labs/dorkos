/**
 * The two routes a PERSON uses to allow, or stop, one extension running its code
 * inside the DorkOS server process (DOR-516).
 *
 * Extracted from {@link module:routes/extensions} to keep route files under 500
 * lines, and because these two are a different KIND of route from the rest of
 * that file: everything there manages extensions, while these two record a human
 * security decision and therefore carry a bar none of the others do.
 *
 * The record they write is `extensions.approvedToRun` in `~/.dork/config.json`,
 * classified `operator-only`. Why that home and not a project file, why not a
 * standing permission, and what the gate buys in each posture: see
 * `services/extensions/extension-load-policy.ts`.
 *
 * There is deliberately no MCP tool twin for these. Every other extension
 * operation has one; approving does not, because the agent surface is exactly the
 * surface that must not be able to approve its own code.
 *
 * @module routes/extensions-approval
 */
import type { Router, Request, Response } from 'express';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { logger } from '../lib/logger.js';
import { broadcastExtensionReloaded } from './extensions.js';
import { trustedCaller } from '../services/core/capabilities/index.js';
import { readCallerAuthority, requireOperatorCookieUnderLogin } from '../lib/caller-authority.js';
import { resolveTrustedOrigins } from '../lib/trusted-origins.js';
import {
  EXTENSION_NOT_APPROVED_CODE,
  EXTENSION_NOT_APPROVED_ERROR,
} from '../services/extensions/extension-load-policy.js';

/**
 * Refuse a caller that is not a person, for the two write routes that record or
 * withdraw a load approval.
 *
 * Deliberately the SAME two bars, in the same order, as an `operator-only` setting
 * on `PATCH /api/config` — because that is exactly what this writes
 * (`extensions.approvedToRun`). Keeping them identical is the point: the record of
 * a human decision has one bar wherever it is written, and adding a friendlier
 * route must not quietly become the cheap way in. That is the DOR-467 failure
 * shape, where a gate sat on a tool and the route walked around it.
 *
 * 1. **The cookie bar** — with login on, prove you are a person in the cockpit.
 *    Allows everyone while login is off, because then nobody has a cookie.
 * 2. **The agent bar** — anything presenting agent identity or an approval token is
 *    refused in every posture. In the login-off posture this is the only bar left,
 *    so the honest guarantee is "an agent that names itself cannot approve its own
 *    extension", not "only a proven person can". A caller that omits its
 *    `X-DorkOS-Agent` header is trusted here, exactly as it is on `PATCH
 *    /api/config` (DOR-505's documented residual). Turning on Require login closes
 *    it.
 *
 * Plus one bar the config route does not need, because these two routes are
 * reachable by a plain cross-site `fetch`: a browser that sends an `Origin` must
 * send one DorkOS trusts. Without it, any web page a person visits could POST this
 * approval through their browser — no cookie required in the default posture, and
 * CORS does not help, since it withholds the RESPONSE while the write has already
 * happened.
 *
 * The allowlist is the SERVER's (`resolveTrustedOrigins`, the repo's single origin
 * policy), and membership is exact. It deliberately does not compare the `Origin`
 * against anything derived from the request: an earlier version allowed an origin
 * equal to `${req.protocol}://${req.headers.host}`, borrowed from the CORS delegate
 * in `app.ts` to cover port remaps, and that is precisely what DNS rebinding
 * defeats — the browser sends `Host: evil.example` AND `Origin: http://evil.example`,
 * they match, and the bar never runs. An expected value taken from the request
 * cannot judge the request. `middleware/mcp-origin.ts` has always done it this way
 * and names this attack outright.
 *
 * The cost, stated: a deployment that serves the cockpit on an origin other than
 * DorkOS's own port (a container published on a different host port) is refused
 * here even though CORS lets it through. Every documented Docker invocation
 * publishes `4242:4242`, and the tunnel origin is in the trusted set, so the
 * shipped paths are covered. `DORKOS_CORS_ORIGIN` is NOT consulted on purpose:
 * "which sites may read my responses" is a different question from "which page may
 * record a person's security decision", and quietly answering the second with the
 * first is how a convenience setting becomes an authorization one.
 *
 * Requests with no `Origin` (curl, the CLI, the desktop shell) pass, the same
 * allowance `validateMcpOrigin` makes for the same reason: only browsers send the
 * header, so only browsers can be judged by it. Both routes are POST-only, and
 * browsers have sent `Origin` on every POST — `fetch`, `XMLHttpRequest`, and plain
 * form submission — for years, so a browser cannot reach that branch.
 *
 * @param req - The request, read for the `Origin` header and the agent-identity and
 *   approval-token headers.
 * @param res - The response, read for a resolved session user and written on refusal.
 * @returns `true` when the request was already answered with a refusal, so the
 *   caller must return immediately.
 */
function refuseIfNotAPerson(req: Request, res: Response): boolean {
  const origin = req.headers.origin;
  if (origin && !resolveTrustedOrigins().includes(origin)) {
    res.status(403).json({
      error: EXTENSION_NOT_APPROVED_ERROR,
      code: EXTENSION_NOT_APPROVED_CODE,
      message:
        `DorkOS changed nothing. This request came from ${origin}, which is not DorkOS. ` +
        `Allowing an extension to run code inside DorkOS is something a person does in ` +
        `their own copy of the app, not something another site can ask for on their behalf.`,
    });
    return true;
  }

  const cookieRefusal = requireOperatorCookieUnderLogin(
    res,
    'which extensions may run code inside DorkOS'
  );
  if (cookieRefusal) {
    res.status(cookieRefusal.status).json({
      error: EXTENSION_NOT_APPROVED_ERROR,
      code: cookieRefusal.code,
      message: cookieRefusal.error,
    });
    return true;
  }

  if (!trustedCaller(readCallerAuthority(req, res))) {
    res.status(403).json({
      error: EXTENSION_NOT_APPROVED_ERROR,
      code: EXTENSION_NOT_APPROVED_CODE,
      message:
        `DorkOS changed nothing. Approving an extension to run code inside the DorkOS ` +
        `server is a decision only a person makes, and you are the code being approved. ` +
        `Ask the person to open Settings > Extensions in DorkOS and approve it there.`,
    });
    return true;
  }

  return false;
}

/**
 * Mount the approve and revoke routes onto the extensions router.
 *
 * @param router - The extensions router to mount onto.
 * @param extensionManager - ExtensionManager instance for lifecycle operations.
 * @param safeExtId - The id pattern the parent router validates against, passed in
 *   so both files cannot drift to different notions of a valid extension id.
 */
export function registerExtensionApprovalRoutes(
  router: Router,
  extensionManager: ExtensionManager,
  safeExtId: RegExp
): void {
  // POST /api/extensions/:id/approve -- Record that a person approved this
  // extension to run code inside the DorkOS server process, and start it.
  router.post('/:id/approve', async (req, res) => {
    try {
      const { id } = req.params;
      if (!safeExtId.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
      if (refuseIfNotAPerson(req, res)) return undefined;

      const record = extensionManager.get(id);
      if (!record) return res.status(404).json({ error: `Extension '${id}' not found` });
      // Core extensions ship inside DorkOS and are exempt by origin, so there is no
      // approval to record for one. Say so rather than writing a list entry that
      // changes nothing.
      if (record.origin === 'core') {
        return res.status(409).json({
          error: `Extension '${id}' ships with DorkOS and does not need approving`,
        });
      }

      const extension = await extensionManager.approveToRun(id);
      if (!extension) return res.status(404).json({ error: `Extension '${id}' not found` });

      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        await activityService.emit({
          actorType: 'user',
          actorLabel: 'You',
          category: 'config',
          eventType: 'config.extension_updated',
          resourceType: 'extension',
          resourceId: id,
          resourceLabel: extension.manifest.name,
          summary: `Allowed ${extension.manifest.name} to run code inside DorkOS`,
        });
      }

      // The server half is live now, so tell every connected client to pick up the
      // extension's contributions instead of waiting for a page reload.
      broadcastExtensionReloaded([id]);

      return res.json({ extension });
    } catch (err) {
      logger.error(`[Extensions] Failed to approve ${req.params.id}`, err);
      return res.status(500).json({ error: 'Failed to approve extension' });
    }
  });

  // POST /api/extensions/:id/revoke -- Withdraw that approval and stop the
  // extension's server-side code immediately.
  router.post('/:id/revoke', async (req, res) => {
    try {
      const { id } = req.params;
      if (!safeExtId.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
      if (refuseIfNotAPerson(req, res)) return undefined;

      const record = extensionManager.get(id);
      if (!record) return res.status(404).json({ error: `Extension '${id}' not found` });
      if (record.origin === 'core') {
        return res.status(409).json({
          error: `Extension '${id}' ships with DorkOS and cannot be stopped this way`,
        });
      }

      const extension = await extensionManager.revokeRunApproval(id);
      if (!extension) return res.status(404).json({ error: `Extension '${id}' not found` });

      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        await activityService.emit({
          actorType: 'user',
          actorLabel: 'You',
          category: 'config',
          eventType: 'config.extension_updated',
          resourceType: 'extension',
          resourceId: id,
          resourceLabel: extension.manifest.name,
          summary: `Stopped ${extension.manifest.name} from running code inside DorkOS`,
        });
      }

      broadcastExtensionReloaded([id]);

      return res.json({ extension });
    } catch (err) {
      logger.error(`[Extensions] Failed to revoke approval for ${req.params.id}`, err);
      return res.status(500).json({ error: 'Failed to revoke extension approval' });
    }
  });
}
