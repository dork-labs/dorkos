/**
 * The Settings → Extensions half of "Confirm it's you" (DOR-3234, Must 3):
 * which loaded mini apps keep it off, and the one fix DorkOS does for a
 * person, moving a mini app out of an agent's folder.
 *
 * - `GET /step-up-risks` lists them, as the step-up sheet names them.
 * - `POST /:id/move-out` copies one into DorkOS's own folder, verifies it,
 *   and removes the original (`services/extensions/move-extension-out.ts`).
 *   A person only: an agent could otherwise move code it wrote wherever it
 *   liked. The moved copy is never re-trusted; it waits for a person's yes.
 *
 * A changed mini app needs no new route: Settings already turns one off, and
 * its approval card already shows its changes and asks for a fresh yes.
 *
 * Split from {@link module:routes/extensions} to keep that file under its line
 * ceiling.
 *
 * @module routes/extensions-step-up
 */
import type { Context, Hono } from 'hono';

import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { logger } from '../lib/logger.js';
import { problem } from '@dorkos/http-kit';
import { readActivityActor } from '../services/activity/activity-actor.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import {
  MoveExtensionError,
  moveExtensionOut,
} from '../services/extensions/step-up/move-extension-out.js';
import { currentStepUpExtensionRisks } from '../services/extensions/step-up/step-up-extension-risk.js';
import { broadcastExtensionReloaded } from './extensions.js';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

/** What the move route says when its bar refuses it. */
const MOVE_BAR: PersonBarCopy = {
  code: 'person_only',
  subject: 'where a mini app’s code lives',
  crossSite: (origin) => `Nothing moved. ${origin} isn’t DorkOS. Move mini apps in the app.`,
  agent: 'Nothing moved. Only a person moves a mini app, in Settings.',
};

/** What each refused move says: a fixed sentence per case, never the error's own text. */
const MOVE_REFUSALS: Record<MoveExtensionError['code'], string> = {
  'not-movable': 'This mini app can’t be moved from where it is.',
  'has-link': 'Its folder holds a link, so it can’t be moved safely.',
  exists: 'A mini app with this name is already in DorkOS’s folder.',
  'changed-while-moving': 'It changed while it was being moved. Nothing moved.',
};

/** A `409 conflict` for a mini app that can't be moved, with `reason: not_movable`. */
const notMovable = (c: Context<ApiEnv>, detail: string) =>
  problem(c, 'conflict', { detail, extensions: { reason: 'not_movable' } });

/** What these routes read. */
export interface ExtensionStepUpRouteDeps {
  manager: ExtensionManager;
  dorkHome: string;
  safeId: RegExp;
  activity?: Pick<ActivityService, 'emit'>;
}

/**
 * Mount the step-up risk and move routes onto the extensions router.
 *
 * @param router - The `/api/extensions` router.
 * @param deps - See {@link ExtensionStepUpRouteDeps}.
 */
export function registerExtensionStepUpRoutes(
  router: Hono<ApiEnv>,
  deps: ExtensionStepUpRouteDeps
): void {
  const { manager, dorkHome, safeId, activity } = deps;

  router.get('/step-up-risks', (c) => c.json({ risks: currentStepUpExtensionRisks() }));

  router.post('/:id/move-out', async (c) => {
    const id = c.req.param('id');
    if (!safeId.test(id))
      return problem(c, 'invalid_request', {
        detail: 'Use an extension id in lowercase, like my-extension.',
      });
    const refused = refusedNotAPerson(c, MOVE_BAR);
    if (refused) return refused;
    const risk = currentStepUpExtensionRisks().find((entry) => entry.id === id);
    const record = manager.listRecords().find((entry) => entry.id === id);
    if (!record || risk?.reason !== 'agent-folder') {
      return notMovable(c, 'This mini app isn’t in an agent’s folder.');
    }
    // A plugin's or a dev link's copy lives where its plugin put it.
    if (record.sourcePlugin || record.devLink || record.origin === 'core') {
      return notMovable(c, 'This mini app came with a plugin, so it can’t be moved.');
    }
    try {
      const movedTo = await moveExtensionOut(record.realPath ?? record.path, id, dorkHome);
      await manager.reload();
      await activity?.emit({
        ...readActivityActor(honoRequestFacts(c)),
        category: 'config',
        eventType: 'config.extension_moved',
        resourceType: 'extension',
        resourceId: id,
        resourceLabel: record.manifest.name,
        summary: `Moved ${record.manifest.name} out of ${risk.agentName ?? 'an agent'}’s folder`,
      });
      broadcastExtensionReloaded([id]);
      return c.json({ ok: true, movedTo });
    } catch (error) {
      if (error instanceof MoveExtensionError) {
        return problem(c, 'conflict', {
          detail: MOVE_REFUSALS[error.code],
          extensions: { reason: error.code.replaceAll('-', '_') },
        });
      }
      logger.error('[Extensions] A move out of an agent’s folder failed', {
        id,
        error: (error as Error).name,
      });
      return problem(c, 'internal_error', { detail: 'That didn’t work. Nothing moved.' });
    }
  });
}
