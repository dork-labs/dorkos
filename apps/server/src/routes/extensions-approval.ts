/**
 * The routes a PERSON uses to allow, or stop, one extension running its code
 * inside the DorkOS server process (DOR-516), plus the two the Activity inbox
 * asks with (DOR-2517): the list of extensions waiting for that decision, and
 * "Not now".
 *
 * Extracted from {@link module:routes/extensions} to keep route files under 500
 * lines, and because these two are a different KIND of route from the rest of
 * that file: everything there manages extensions, while these two record a human
 * security decision.
 *
 * They used to be the only routes on this router carrying a person bar, which is
 * how DOR-1507 got filed: `/enable` and `/disable` write the same `operator-only`
 * section and ran nothing at all. The bar now lives in
 * {@link module:routes/extensions-person-bar} and all four run it, so this file
 * keeps only the words it says when refusing.
 *
 * The record they write is `extensions.approvedToRun` in `~/.dork/config.json`,
 * classified `operator-only`. Why that home and not a project file or an
 * approval, and what the gate buys in each posture: see
 * `services/extensions/extension-load-policy.ts`.
 *
 * There is deliberately no MCP tool twin for these. Every other extension
 * operation has one; approving does not, because the agent surface is exactly the
 * surface that must not be able to approve its own code. "Not now" has none
 * either: it answers the same consent question, and an agent that could answer
 * it could hide the question from the person.
 *
 * @module routes/extensions-approval
 */
import type { Hono } from 'hono';
import {
  ApproveExtensionRequestSchema,
  DismissExtensionApprovalRequestSchema,
  STALE_APPROVAL_CODE,
} from '@dorkos/shared/extension-approval-schemas';
import { isExpectedCopy, type ExtensionManager } from '../services/extensions/extension-manager.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { notificationEntitlement } from '../services/notifications/notification-entitlement.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { logger } from '../lib/logger.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { broadcastExtensionReloaded } from './extensions.js';
import { listPendingExtensionApprovals } from '../services/extensions/extension-approval-queue.js';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';
import {
  EXTENSION_NOT_APPROVED_CODE,
  EXTENSION_NOT_APPROVED_ERROR,
} from '../services/extensions/extension-load-policy.js';

/**
 * What the two approval routes say when a bar refuses them.
 *
 * The three bars themselves live in {@link module:routes/extensions-person-bar},
 * shared with `/enable` and `/disable` on the same router, because all four write
 * a leaf of the same `operator-only` section and a gate that covers two of four
 * is a gate an agent routes around (DOR-1507). What stays here is only the
 * VOCABULARY: approving is a security decision, so it answers with
 * `extension_not_approved_to_run` and says who may make that decision, where
 * turning an extension on answers with the plain operator-only config code.
 */
const APPROVAL_BAR: PersonBarCopy = {
  error: EXTENSION_NOT_APPROVED_ERROR,
  code: EXTENSION_NOT_APPROVED_CODE,
  subject: 'which extensions may run code inside DorkOS',
  crossSite: (origin) =>
    `DorkOS changed nothing. This request came from ${origin}, which is not DorkOS. ` +
    `Allowing an extension to run code inside DorkOS is something a person does in ` +
    `their own copy of the app, not something another site can ask for on their behalf.`,
  agent:
    `DorkOS changed nothing. Approving an extension to run code inside the DorkOS ` +
    `server is a decision only a person makes, and you are the code being approved. ` +
    `Ask the person to open Settings > Extensions in DorkOS and approve it there.`,
};

/**
 * Mount the approve and revoke routes onto the extensions router.
 *
 * @param router - The extensions router to mount onto.
 * @param extensionManager - ExtensionManager instance for lifecycle operations.
 * @param safeExtId - The id pattern the parent router validates against, passed in
 *   so both files cannot drift to different notions of a valid extension id.
 * @param activity - The Activity feed the decision is recorded in, when the
 *   server has one.
 */
export function registerExtensionApprovalRoutes(
  router: Hono<ApiEnv>,
  extensionManager: ExtensionManager,
  safeExtId: RegExp,
  activity?: Pick<ActivityService, 'emit'>
): void {
  // GET /api/extensions/pending-approvals -- Every installed extension waiting
  // for a person to let it run, oldest first (DOR-2517). A read, so it carries
  // no person bar: the list names ids and display text the extensions list
  // already exposes, and the Activity inbox draws one row per item. A caller
  // the notification pipeline would not show the person's inbox to (an agent)
  // gets it without absolute paths or the home folder, the same rule the
  // inbox itself answers by.
  router.get('/pending-approvals', async (c) => {
    try {
      const forPerson =
        notificationEntitlement(readCallerPrincipal(honoRequestFacts(c))) !== 'none';
      return c.json({
        approvals: await listPendingExtensionApprovals(extensionManager, { forPerson }),
      });
    } catch (err) {
      logger.error('[Extensions] Failed to list extensions waiting for approval', err);
      return c.json({ error: 'Failed to list extensions waiting for approval' }, 500);
    }
  });

  // POST /api/extensions/:id/approve -- Record that a person approved this
  // extension to run code inside the DorkOS server process, and start it.
  router.post('/:id/approve', async (c) => {
    const id = c.req.param('id');
    try {
      if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
      const refused = refusedNotAPerson(c, APPROVAL_BAR);
      if (refused) return refused;

      const record = extensionManager.get(id);
      if (!record) return c.json({ error: `Extension '${id}' not found` }, 404);
      // Core extensions ship inside DorkOS and are exempt by origin, so there is no
      // approval to record for one. Say so rather than writing a list entry that
      // changes nothing.
      if (record.origin === 'core') {
        return c.json(
          { error: `Extension '${id}' ships with DorkOS and does not need approving` },
          409
        );
      }

      // The copy the person was shown, when the click came from a row that
      // named one (the Activity inbox, DOR-2517). The approval binds whatever
      // copy is on disk NOW, so a row that went out of date — another plugin
      // took the id, a project folder reused it, the version moved — must
      // not approve the newcomer on the strength of a decision about the old.
      const body = readJsonBody(c);
      const hasBody = body !== undefined && Object.keys(body as object).length > 0;
      if (hasBody) {
        const expected = ApproveExtensionRequestSchema.safeParse(body);
        if (!expected.success) {
          return c.json(
            { error: 'Send the path and version of the extension you were shown' },
            400
          );
        }
        if (!isExpectedCopy(record, expected.data)) {
          return c.json(
            {
              error: 'This extension changed since you saw it. Nothing was turned on.',
              code: STALE_APPROVAL_CODE,
            },
            409
          );
        }
      }

      const extension = await extensionManager.approveToRun(id);
      if (!extension) return c.json({ error: `Extension '${id}' not found` }, 404);

      await activity?.emit({
        // Always the person — the bar above refuses any caller naming itself an
        // agent — and read from the caller anyway, so every Activity entry on
        // this router derives who acted rather than asserting it (DOR-1801).
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.extension_updated',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: extension.manifest.name,
        summary: `Allowed ${extension.manifest.name} to run code inside DorkOS`,
      });

      // The server half is live now, so tell every connected client to pick up the
      // extension's contributions instead of waiting for a page reload.
      broadcastExtensionReloaded([id]);

      // The one-time "Next time, trust everything from <source>?" (spec
      // `flow-multiproject` §9.3, V9): only when this copy provably came from a
      // source the person does not trust yet. Returned to the app that
      // answered and never stored, so it shows once, on that device.
      const trustSource = extensionManager.trustOfferFor(id);
      return c.json({
        extension,
        ...(trustSource ? { trustOffer: { source: trustSource } } : {}),
      });
    } catch (err) {
      logger.error(`[Extensions] Failed to approve ${id}`, err);
      return c.json({ error: 'Failed to approve extension' }, 500);
    }
  });

  // POST /api/extensions/:id/dismiss-approval -- "Not now" (DOR-2517). Records
  // that the person declined THIS copy at THIS version, so the inbox stops
  // asking until either changes. Never destructive: nothing is uninstalled,
  // turned off or revoked. Same person bar as approving, because it answers the
  // same question.
  router.post('/:id/dismiss-approval', async (c) => {
    const id = c.req.param('id');
    try {
      if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
      const refused = refusedNotAPerson(c, APPROVAL_BAR);
      if (refused) return refused;

      const body = DismissExtensionApprovalRequestSchema.safeParse(
        readJsonBody(c, { emptyAs: {} })
      );
      if (!body.success) {
        return c.json({ error: 'Send the path and version of the extension you were shown' }, 400);
      }

      const result = extensionManager.dismissApproval(id, body.data);
      if (!result.ok) {
        if (result.reason === 'not_found') {
          return c.json({ error: `Extension '${id}' not found` }, 404);
        }
        if (result.reason === 'core') {
          return c.json(
            { error: `Extension '${id}' ships with DorkOS and never asks to be turned on` },
            409
          );
        }
        return c.json(
          {
            error: 'This extension changed since you saw it. Nothing was changed.',
            code: STALE_APPROVAL_CODE,
          },
          409
        );
      }

      return c.body(null, 204);
    } catch (err) {
      logger.error(`[Extensions] Failed to dismiss the approval for ${id}`, err);
      return c.json({ error: 'Failed to dismiss extension approval' }, 500);
    }
  });

  // POST /api/extensions/:id/revoke -- Withdraw that approval and stop the
  // extension's server-side code immediately.
  router.post('/:id/revoke', async (c) => {
    const id = c.req.param('id');
    try {
      if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
      const refused = refusedNotAPerson(c, APPROVAL_BAR);
      if (refused) return refused;

      const record = extensionManager.get(id);
      if (!record) return c.json({ error: `Extension '${id}' not found` }, 404);
      if (record.origin === 'core') {
        return c.json(
          { error: `Extension '${id}' ships with DorkOS and cannot be stopped this way` },
          409
        );
      }

      const extension = await extensionManager.revokeRunApproval(id);
      if (!extension) return c.json({ error: `Extension '${id}' not found` }, 404);

      await activity?.emit({
        // Always the person — the bar above refuses any caller naming itself an
        // agent — and read from the caller anyway, so every Activity entry on
        // this router derives who acted rather than asserting it (DOR-1801).
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.extension_updated',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: extension.manifest.name,
        summary: `Stopped ${extension.manifest.name} from running code inside DorkOS`,
      });

      broadcastExtensionReloaded([id]);

      return c.json({ extension });
    } catch (err) {
      logger.error(`[Extensions] Failed to revoke approval for ${id}`, err);
      return c.json({ error: 'Failed to revoke extension approval' }, 500);
    }
  });
}
