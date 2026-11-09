/**
 * The routes a PERSON uses to remove an installed extension, and to forget the
 * approval of one that is gone (DOR-3541, DOR-3372). The work itself is in
 * {@link module:services/extensions/removal/extension-removal}.
 *
 * Both carry the same person bar as approving: removing takes code off this
 * computer and forgetting withdraws a security decision, and an agent that
 * could do either could clear the record of what it was allowed. There is no
 * MCP tool for them.
 *
 * @module routes/extensions-removal
 */
import type { Hono } from 'hono';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import {
  forgetStaleApproval,
  listStaleApprovals,
  removeExtension,
  type RemoveRefusal,
} from '../services/extensions/removal/extension-removal.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { notificationEntitlement } from '../services/notifications/notification-entitlement.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { logger } from '../lib/logger.js';
import { broadcastExtensionReloaded } from './extensions.js';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';
import { EXTENSION_NOT_APPROVED_CODE } from '../services/extensions/extension-load-policy.js';

/** What the bar says when it refuses a remove or a forget. */
const REMOVAL_BAR: PersonBarCopy = {
  error: 'Only a person can remove an extension or forget its approval',
  code: EXTENSION_NOT_APPROVED_CODE,
  subject: 'which extensions are on this computer and what they were allowed',
  crossSite: (origin) =>
    `DorkOS changed nothing. This request came from ${origin}, which is not DorkOS. ` +
    `Removing an extension is something a person does in their own copy of the app.`,
  agent:
    `DorkOS changed nothing. Removing an extension, or forgetting what it was allowed, ` +
    `is a decision only a person makes. Ask the person to do it in Settings > Extensions.`,
};

/** Why a remove was refused, in words a person reads. */
const REFUSAL_COPY: Record<Exclude<RemoveRefusal, 'not_found'>, string> = {
  core: 'It comes with DorkOS, so it can’t be removed. Turn it off instead.',
  plugin: 'It came with a plugin. Uninstall the plugin in Marketplace to remove it.',
  dev_link: 'It runs from a folder you linked. Unlink it in Marketplace.',
  unexpected_folder:
    'Its folder isn’t where DorkOS puts extensions, so DorkOS won’t delete it. Remove it by hand.',
};

/**
 * Mount the remove, forget and stale-approval routes onto the extensions router.
 *
 * @param router - The extensions router.
 * @param extensionManager - The extension manager.
 * @param safeExtId - The id pattern the parent router validates against.
 * @param activity - The Activity feed each removal is recorded in, when present.
 */
export function registerExtensionRemovalRoutes(
  router: Hono<ApiEnv>,
  extensionManager: ExtensionManager,
  safeExtId: RegExp,
  activity?: Pick<ActivityService, 'emit'>
): void {
  // GET /api/extensions/stale-approvals -- Approvals whose extension is no
  // longer installed anywhere (DOR-3372). Paths only for the person.
  router.get('/stale-approvals', (c) => {
    try {
      const forPerson =
        notificationEntitlement(readCallerPrincipal(honoRequestFacts(c))) !== 'none';
      const stale = listStaleApprovals(extensionManager);
      return c.json({
        approvals: forPerson ? stale : stale.map(({ id, plugin }) => ({ id, path: null, plugin })),
      });
    } catch (err) {
      logger.error('[Extensions] Failed to list approvals left behind', err);
      return c.json({ error: 'Failed to list approvals left behind' }, 500);
    }
  });

  // POST /api/extensions/:id/remove -- Delete an installed extension's folder
  // and every approval and choice recorded for it (DOR-3541).
  router.post('/:id/remove', async (c) => {
    const id = c.req.param('id');
    try {
      if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
      const refused = refusedNotAPerson(c, REMOVAL_BAR);
      if (refused) return refused;

      const result = await removeExtension(extensionManager, id);
      if (!result.ok) {
        if (result.reason === 'not_found') {
          return c.json({ error: `Extension '${id}' not found` }, 404);
        }
        return c.json({ error: REFUSAL_COPY[result.reason], code: result.reason }, 409);
      }

      await activity?.emit({
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.extension_updated',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: result.name,
        summary: `Removed ${result.name} and everything it was allowed`,
      });
      broadcastExtensionReloaded([id]);
      return c.json({ removed: id });
    } catch (err) {
      logger.error(`[Extensions] Failed to remove ${id}`, err);
      return c.json({ error: 'Failed to remove extension' }, 500);
    }
  });

  // POST /api/extensions/:id/forget -- Forget the approval of an extension that
  // is no longer installed anywhere (DOR-3372). An installed one is stopped or
  // removed instead, so its row says what happens.
  router.post('/:id/forget', async (c) => {
    const id = c.req.param('id');
    try {
      if (!safeExtId.test(id)) return c.json({ error: 'Invalid extension ID' }, 400);
      const refused = refusedNotAPerson(c, REMOVAL_BAR);
      if (refused) return refused;

      const result = await forgetStaleApproval(extensionManager, id);
      if (!result.ok) {
        return result.reason === 'installed'
          ? c.json(
              {
                error: 'It’s still installed. Stop it running or remove it instead.',
                code: 'installed',
              },
              409
            )
          : c.json({ error: `No approval left for '${id}'` }, 404);
      }

      await activity?.emit({
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.extension_updated',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: id,
        summary: `Forgot what ${id} was allowed: its folder is gone`,
      });
      broadcastExtensionReloaded([id]);
      return c.body(null, 204);
    } catch (err) {
      logger.error(`[Extensions] Failed to forget the approval for ${id}`, err);
      return c.json({ error: 'Failed to forget extension approval' }, 500);
    }
  });
}
