/**
 * The two routes behind "Allow all" (DOR-3583): the sets a person can be asked
 * about, and the answer. The work is in
 * {@link module:services/extensions/groups/extension-approval-set}.
 *
 * Approving a set carries the same person bar as approving one extension, and
 * there is no MCP tool for it: an agent is exactly the caller that must not be
 * able to allow its own code. The command palette only opens the card.
 *
 * @module routes/extensions-approval-set
 */
import { holdExtensionPowerChange } from './extension-decision-step-up.js';
import { isAtThisComputer } from '../services/core/auth/gate-policy.js';
import { refuseApprovalYesFromWifi } from '../services/core/approvals/model/approval-answer-policy.js';
import type { RequestFacts } from '../http/request-facts.js';
import type { Hono } from 'hono';
import { ApproveExtensionSetRequestSchema } from '@dorkos/shared/extension-approval-schemas';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import {
  approveExtensionSet,
  checkExtensionSetApproval,
  listApprovalSets,
} from '../services/extensions/groups/extension-approval-set.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { logger } from '../lib/logger.js';
import { broadcastExtensionReloaded } from './extensions.js';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

/**
 * Mount the approval-set routes onto the extensions router.
 *
 * @param router - The extensions router.
 * @param extensionManager - The extension manager.
 * @param bar - What the person bar says, the same words as approving one.
 * @param activity - The Activity feed each approval is recorded in, when present.
 */
export function registerExtensionApprovalSetRoutes(
  router: Hono<ApiEnv>,
  extensionManager: ExtensionManager,
  bar: PersonBarCopy,
  activity?: Pick<ActivityService, 'emit'>
): void {
  // GET /api/extensions/approval-sets -- Each plugin whose installed
  // extensions wait to be allowed, with the hash "Allow all" echoes. A read:
  // it names ids, versions and display text the extensions list already shows.
  router.get('/approval-sets', async (c) => {
    try {
      return c.json({ sets: await listApprovalSets(extensionManager) });
    } catch (err) {
      logger.error('[Extensions] Failed to list extension sets waiting for approval', err);
      return c.json({ error: 'Failed to list extension sets waiting for approval' }, 500);
    }
  });

  // POST /api/extensions/approve-set -- "Allow all {N}": one approval per
  // waiting member, each bound to its own digest, after every check passed.
  router.post('/approve-set', async (c) => {
    try {
      const refused = refusedNotAPerson(c, bar);
      if (refused) return refused;

      const body = ApproveExtensionSetRequestSchema.safeParse(readJsonBody(c));
      if (!body.success) {
        return c.json({ error: 'Send the plugin and the extensions you were shown' }, 400);
      }

      const checked = await checkExtensionSetApproval(extensionManager, body.data);
      if (!checked.ok) return c.json({ error: checked.error, code: checked.code }, 409);

      // Wi-Fi may only deny, so it hears where to answer before any batch rule.
      const wifi = refuseApprovalYesFromWifi(honoRequestFacts(c));
      if (wifi) return c.json(wifi, 403);
      if (body.data.members.length > 1 && !isAtThisComputer(honoRequestFacts(c)))
        return c.json(
          {
            error: 'Confirm each request separately.',
            code: 'APPROVALS_REQUIRE_SEPARATE_CONFIRMATION',
          },
          403
        );
      const run = async (facts: RequestFacts): Promise<Response> => {
        // Each member's Activity entry is written the moment it is allowed, so
        // nothing that runs is ever missing from the record (Security, Nov 8, M2).
        const outcome = await approveExtensionSet(extensionManager, body.data, async (result) => {
          await activity?.emit({
            ...readActivityActor(facts),
            category: 'config',
            eventType: 'config.extension_updated',
            resourceType: 'extension',
            resourceId: result.id,
            resourceLabel: result.name,
            summary: `Allowed ${result.name} to run code inside DorkOS, with ${body.data.plugin}`,
          });
        });
        if (!outcome.ok) return c.json({ error: outcome.error, code: outcome.code }, 409);

        const allowed = outcome.results.filter((result) => result.ok);
        if (allowed.length > 0) broadcastExtensionReloaded(allowed.map((result) => result.id));
        return c.json({ results: outcome.results, allAllowed: outcome.allAllowed });
      };
      const held = holdExtensionPowerChange(c, {
        id: body.data.plugin,
        effect: 'extension-approve-set',
        copy: bar,
        reason: `Allow mini apps from ${body.data.plugin}.`,
        read: () => ({
          request: body.data,
          members: body.data.members.map(({ id }) => {
            const current = extensionManager.get(id);
            return current
              ? {
                  id,
                  path: current.path,
                  manifest: current.manifest,
                  digest: current.currentDigest ?? null,
                }
              : null;
          }),
        }),
        run,
      });
      return held ?? (await run(honoRequestFacts(c)));
    } catch (err) {
      logger.error('[Extensions] Failed to approve an extension set', err);
      return c.json({ error: 'Failed to approve extension set' }, 500);
    }
  });
}
