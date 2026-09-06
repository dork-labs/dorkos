/**
 * The two routes a PERSON uses to allow, or stop, one extension running its code
 * inside the DorkOS server process (DOR-516).
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
import type { Router } from 'express';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { logger } from '../lib/logger.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { broadcastExtensionReloaded } from './extensions.js';
import { refuseIfNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';
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
      if (refuseIfNotAPerson(req, res, APPROVAL_BAR)) return undefined;

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
          // Always the person — the bar above refuses any caller naming itself an
          // agent — and read from the caller anyway, so every Activity entry on
          // this router derives who acted rather than asserting it (DOR-1801).
          ...readActivityActor(req, res),
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
      if (refuseIfNotAPerson(req, res, APPROVAL_BAR)) return undefined;

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
          // Always the person — the bar above refuses any caller naming itself an
          // agent — and read from the caller anyway, so every Activity entry on
          // this router derives who acted rather than asserting it (DOR-1801).
          ...readActivityActor(req, res),
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
