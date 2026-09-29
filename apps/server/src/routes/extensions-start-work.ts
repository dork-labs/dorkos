/**
 * `POST /api/extensions/:id/start-work`: what `api.startWork` calls when a
 * person clicks an extension's outcome button (spec `flow-multiproject` §7.7,
 * §11.3).
 *
 * **Behind the person bar, scoped to `:id`.** The client host fills `:id` with
 * the calling extension's own id. Residual (invariant 9): the bar keeps agents
 * out, but it cannot tell a person's click from the extension's own page code,
 * so the chat is recorded as started by the extension (`startedBy.kind =
 * 'extension'`), with or without a click.
 *
 * Refusals answer `{ error, code }`: `404 not_a_project`, `409
 * account_not_allowed_here`, `429 start_limit`; a malformed body is `400`.
 * Nothing is started on any of them.
 *
 * @module routes/extensions-start-work
 */
import type { Router } from 'express';
import type { ExtensionStatus } from '@dorkos/extension-api';
import { StartWorkError } from '@dorkos/extension-api/server';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import { getStartWorkService, StartWorkInputError } from '../services/extensions/start-work.js';
import { logger } from '../lib/logger.js';
import { refuseIfNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

/** What the route says when the bar refuses it. */
const START_WORK_BAR: PersonBarCopy = {
  error: 'Only a person can start this.',
  code: 'start_work_person_required',
  subject: 'work started from an extension',
  crossSite: (origin) =>
    `DorkOS started nothing. This request came from ${origin}, which is not DorkOS. ` +
    `Only a person using DorkOS can start this.`,
  agent: 'DorkOS started nothing. Only a person can start this. Ask them to start it in DorkOS.',
};

/** The statuses of an extension that is turned on. */
const TURNED_ON: ReadonlySet<ExtensionStatus> = new Set(['enabled', 'compiled', 'active']);

/** The HTTP status for each refusal. */
const STATUS_FOR: Record<StartWorkError['code'], number> = {
  not_a_project: 404,
  account_not_allowed_here: 409,
  start_limit: 429,
};

/**
 * Mount `POST /:id/start-work` on the extensions router.
 *
 * @param router - The extensions router.
 * @param extensionManager - For the extension's name and whether it is on.
 * @param safeExtId - The id pattern the parent router validates against.
 */
export function registerExtensionStartWorkRoute(
  router: Router,
  extensionManager: ExtensionManager,
  safeExtId: RegExp
): void {
  router.post('/:id/start-work', async (req, res) => {
    const { id } = req.params;
    if (!safeExtId.test(id)) return res.status(400).json({ error: 'Invalid extension ID' });
    if (refuseIfNotAPerson(req, res, START_WORK_BAR)) return undefined;
    const record = extensionManager.get(id);
    if (!record) return res.status(404).json({ error: `Extension '${id}' not found` });
    if (!TURNED_ON.has(record.status)) {
      return res
        .status(409)
        .json({ error: `Turn on ${record.manifest.name} in Settings → Extensions first.` });
    }
    const service = getStartWorkService();
    if (!service) {
      return res
        .status(503)
        .json({ error: 'DorkOS cannot start chats yet. Try again in a moment.' });
    }
    try {
      return res.json(await service.start(id, req.body ?? {}, 'api'));
    } catch (err) {
      if (err instanceof StartWorkError) {
        return res.status(STATUS_FOR[err.code]).json({ error: err.message, code: err.code });
      }
      if (err instanceof StartWorkInputError) {
        return res.status(400).json({ error: err.message });
      }
      // Anything else is the server's own fault: logged, never shown as it is.
      logger.error('[Extensions] Failed to start work in a new chat', err);
      return res.status(500).json({ error: 'The chat could not be started. Try again.' });
    }
  });
}
