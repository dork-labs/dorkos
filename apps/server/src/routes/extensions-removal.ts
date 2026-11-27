/**
 * The list of approvals whose extension is no longer installed anywhere
 * (DOR-3372). Removing an installed extension and forgetting the approval of
 * one that is gone are person-only capabilities the mount serves behind the
 * person bar (`extensions.remove`, `extensions.forget_approval`,
 * `services/extensions/http-capabilities/`, DOR-4978). The work itself is in
 * {@link module:services/extensions/removal/extension-removal}.
 *
 * @module routes/extensions-removal
 */
import type { Hono } from 'hono';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import { listStaleApprovals } from '../services/extensions/removal/extension-removal.js';
import { readCallerPrincipal } from '../lib/caller-principal.js';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { notificationEntitlement } from '../services/notifications/notification-entitlement.js';
import { logger } from '../lib/logger.js';
import { problem } from '@dorkos/http-kit';
import { answerPage } from '../lib/paging/hand-route-page.js';
import {
  readerList,
  staleApprovalKey,
} from '../services/extensions/listing/extension-list-pages.js';

/**
 * Mount the stale-approval list onto the extensions router.
 *
 * @param router - The extensions router.
 * @param extensionManager - The extension manager.
 */
export function registerExtensionRemovalRoutes(
  router: Hono<ApiEnv>,
  extensionManager: ExtensionManager
): void {
  // GET /api/extensions/stale-approvals -- Approvals whose extension is no
  // longer installed anywhere (DOR-3372), a page at a time by id (DOR-4982).
  // Paths only for the person; the cursor is bound to the kind of reader.
  router.get('/stale-approvals', async (c) => {
    try {
      const forPerson =
        notificationEntitlement(readCallerPrincipal(honoRequestFacts(c))) !== 'none';
      return await answerPage(c, {
        list: readerList('stale-approvals', forPerson),
        noun: 'approvals',
        read: () => listStaleApprovals(extensionManager),
        keyOf: staleApprovalKey,
        show: (row) => (forPerson ? row : { id: row.id, path: null, plugin: row.plugin }),
      });
    } catch (err) {
      logger.error('[Extensions] Failed to list approvals left behind', err);
      return problem(c, 'internal_error', {
        detail: 'Couldn’t list leftover approvals. Try again.',
      });
    }
  });
}
