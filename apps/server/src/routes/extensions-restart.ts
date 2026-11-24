/**
 * `POST /api/extensions/:id/restart` — the Restart on the notice DorkOS posts
 * when an extension that runs separately stopped too often and was left off
 * (DOR-4785, `extension-stopped-notice.ts`).
 *
 * It does exactly what reloading that one extension does
 * (`ExtensionManager.reloadExtension`, the `reload_extensions --id` tool): it
 * rebuilds it, gives it a fresh crash budget (`resetRestarts`) and starts it
 * again. This button is behind the person bar: resetting the stop budget is
 * an explicit person action. An extension turned off is never turned back on.
 * A copy a person has not approved, or whose files changed since, is refused too: the
 * reload's pin check already keeps its code from running, and this answers 409
 * rather than a success nothing stands behind.
 *
 * @module routes/extensions-restart
 */
import type { Hono } from 'hono';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import type { ApiEnv } from '../http/api-chain.js';
import { logger } from '../lib/logger.js';
import { problem } from '@dorkos/http-kit';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

/** What the Restart button says when the person bar refuses it. */
const RESTART_BAR: PersonBarCopy = {
  code: 'person_only',
  subject: 'app restarts',
  crossSite: () => 'DorkOS restarted nothing. Open the app to restart it.',
  agent: 'DorkOS restarted nothing. Ask a person to restart it in the app.',
};

/** The manager methods the restart route uses. */
export type ExtensionRestartManager = Pick<
  ExtensionManager,
  'get' | 'reloadExtension' | 'listPublic' | 'getServerHandler'
>;

/** What a person is told when the copy on disk is not the one they approved. */
const NEEDS_APPROVAL = 'It changed or waits for your approval. Review it in Settings.';

/**
 * Whether a person approved the copy on disk to run, as the cards report it.
 *
 * @param manager - The extension manager.
 * @param id - The extension id.
 */
function approvedToRun(manager: ExtensionRestartManager, id: string): boolean {
  return manager.listPublic().find((ext) => ext.id === id)?.approvedToRun === true;
}

/**
 * Register the restart route on the extensions router.
 *
 * @param router - The `/api/extensions` router.
 * @param manager - The extension manager, whose single-extension reload this is.
 * @param safeId - The id pattern every extensions route checks.
 * @param broadcastReloaded - Tells every open window the extension changed.
 */
export function registerExtensionRestartRoute(
  router: Hono<ApiEnv>,
  manager: ExtensionRestartManager,
  safeId: RegExp,
  broadcastReloaded: (ids: string[]) => void
): void {
  router.post('/:id/restart', async (c) => {
    const id = c.req.param('id');
    if (!safeId.test(id))
      return problem(c, 'invalid_request', { detail: 'Couldn’t find that app.' });
    const refused = refusedNotAPerson(c, RESTART_BAR);
    if (refused) return refused;
    const record = manager.get(id);
    if (!record) return problem(c, 'not_found', { detail: `No app named ${id} is installed.` });
    // Never runs bytes a person has not approved (Security, DOR-4785): asked
    // before the reload, and again after it, since the reload's own pin check
    // is what notices files that changed since the yes.
    if (!approvedToRun(manager, id)) {
      return problem(c, 'needs_approval', { detail: NEEDS_APPROVAL });
    }
    try {
      const result = await manager.reloadExtension(id);
      if (result.status !== 'compiled') {
        logger.warn(`[Extensions] Restart of ${id} did not build`, result.error);
        return problem(c, 'conflict', {
          detail: 'It no longer builds. Open Settings to see why.',
          extensions: { reason: result.status },
        });
      }
      if (!approvedToRun(manager, id)) {
        broadcastReloaded([id]);
        return problem(c, 'needs_approval', { detail: NEEDS_APPROVAL });
      }
      broadcastReloaded([id]);
      // A successful client build does not prove the server half started.
      if ((record.hasServerEntry || record.hasDataProxy) && !manager.getServerHandler(id)) {
        return problem(c, 'upstream_unavailable', {
          detail: 'Couldn’t start the app. Open Settings to check.',
          extensions: { reason: 'server_start_failed' },
        });
      }
      return c.json(result);
    } catch (err) {
      // Turned off since: the reload refuses it rather than turning it back on.
      logger.warn(`[Extensions] Restart of ${id} refused`, err);
      return problem(c, 'conflict', {
        detail: 'Couldn’t restart it. Check it’s turned on in Settings.',
        extensions: { reason: 'restart_refused' },
      });
    }
  });
}
