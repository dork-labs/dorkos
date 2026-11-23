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
import type { Hono } from 'hono';
import type { ExtensionStatus } from '@dorkos/extension-api';
import { StartWorkError } from '@dorkos/extension-api/server';
import type { ExtensionManager } from '../services/extensions/extension-manager.js';
import { getStartWorkService, StartWorkInputError } from '../services/extensions/start-work.js';
import { logger } from '../lib/logger.js';
import type { ApiEnv } from '../http/api-chain.js';
import { problem, readJsonBody } from '@dorkos/http-kit';
import type { ProblemCode } from '@dorkos/shared/problem';
import { honoRequestFacts } from '../http/request-facts.js';
import { wifiTurnCeiling } from '../services/core/auth/sessions/wifi-turn-ceiling.js';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

/** What the route says when the bar refuses it. */
const START_WORK_BAR: PersonBarCopy = {
  code: 'person_only',
  subject: 'work started from an extension',
  crossSite: (origin) =>
    `DorkOS started nothing. This request came from ${origin}, which is not DorkOS. ` +
    `Only a person using DorkOS can start this.`,
  agent: 'DorkOS started nothing. Only a person can start this. Ask them to start it in DorkOS.',
};

/** The statuses of an extension that is turned on. */
const TURNED_ON: ReadonlySet<ExtensionStatus> = new Set(['enabled', 'compiled', 'active']);

/**
 * The problem code each refusal goes out as. Its own word rides as the
 * problem's `reason`, which `api.startWork` throws as a `StartWorkError`.
 */
const CODE_FOR: Record<StartWorkError['code'], ProblemCode> = {
  not_a_project: 'not_found',
  account_not_allowed_here: 'conflict',
  start_limit: 'rate_limited',
};

/**
 * The fixed sentence for each refusal. The error's own message is logged,
 * never sent (DOR-4979 security rule).
 */
const DETAIL_FOR: Record<StartWorkError['code'], string> = {
  not_a_project: 'Choose a folder inside one of your projects.',
  account_not_allowed_here: 'That account can’t be used in this project. Pick another.',
  start_limit: 'Too many chats started or working. Try again later.',
};

/**
 * Mount `POST /:id/start-work` on the extensions router.
 *
 * @param router - The extensions router.
 * @param extensionManager - For the extension's name and whether it is on.
 * @param safeExtId - The id pattern the parent router validates against.
 */
export function registerExtensionStartWorkRoute(
  router: Hono<ApiEnv>,
  extensionManager: ExtensionManager,
  safeExtId: RegExp
): void {
  router.post('/:id/start-work', async (c) => {
    const id = c.req.param('id');
    if (!safeExtId.test(id))
      return problem(c, 'invalid_request', { detail: 'Use a valid extension ID.' });
    const refused = refusedNotAPerson(c, START_WORK_BAR);
    if (refused) return refused;
    const record = extensionManager.get(id);
    if (!record) return problem(c, 'not_found', { detail: `No extension named ${id}.` });
    if (!TURNED_ON.has(record.status)) {
      return problem(c, 'conflict', {
        detail: `Turn on ${record.manifest.name} in Settings → Extensions first.`,
      });
    }
    const service = getStartWorkService();
    if (!service) {
      return problem(c, 'temporarily_unavailable', {
        detail: 'DorkOS can’t start chats yet. Try again in a moment.',
      });
    }
    try {
      // From Wi-Fi, the chat's first turn runs at the runtime's default at most (DOR-3037).
      const ceiling = wifiTurnCeiling(honoRequestFacts(c));
      return c.json(await service.start(id, readJsonBody(c, { emptyAs: {} }), 'api', ceiling));
    } catch (err) {
      if (err instanceof StartWorkError) {
        logger.info('[Extensions] A start-work request was refused', {
          code: err.code,
          why: err.message,
        });
        return problem(c, CODE_FOR[err.code], {
          detail: DETAIL_FOR[err.code],
          extensions: { reason: err.code },
        });
      }
      if (err instanceof StartWorkInputError) {
        logger.info('[Extensions] A start-work request broke a rule', { why: err.message });
        return problem(c, 'invalid_request', {
          detail: 'Keep the prompt, title and reason within their length limits.',
        });
      }
      // Anything else is the server's own fault: logged, never shown as it is.
      logger.error('[Extensions] Failed to start work in a new chat', err);
      return problem(c, 'internal_error', { detail: 'The chat couldn’t be started. Try again.' });
    }
  });
}
