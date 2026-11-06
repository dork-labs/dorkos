/**
 * What the app reads about DorkOS's check on agents' shell commands, and the person's choice to go
 * on without it until restart (DOR-3300).
 *
 * **No agent route, and no file.** The choice lives in `guard-service.ts`'s memory. It takes the
 * three person bars (`extensions-person-bar.ts`) and a caller at this computer, so a phone gets the
 * notice and not the switch. It is refused unless the check is down and a restart was already tried.
 *
 * **The residual, as named on those bars.** With no owner set up there is no session to prove a
 * person, so a program on this computer that leaves out the agent headers passes. Agents' Claude
 * Code shell has stopped at Full by then, which is the only level this changes, but another runtime's
 * shell hasn't. Signing up an owner closes it, and the real boundary is DOR-3053.
 *
 * @module routes/system-shell-check
 */
import type { Hono } from 'hono';
import type { ShellCheckStatus } from '@dorkos/shared/notification-schemas';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { classifyRequest } from '../lib/request-classifier.js';
import { errorBody } from '../lib/route-utils.js';
import { currentServerRole } from '../lib/server-role.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import {
  continueWithoutCheck,
  shellCheckStatus,
} from '../services/runtimes/claude-code/shell-guard/guard-service.js';
import { refusedNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

const COPY: PersonBarCopy = {
  error: 'Only you can turn this check off.',
  code: 'person_required',
  subject: 'this check',
  crossSite: (origin) => `A page from ${origin} tried to turn this check off. Nothing changed.`,
  agent: 'An agent can’t turn this check off. Ask a person to do it in the DorkOS app.',
};

/**
 * Mount the routes.
 *
 * @param router - The `/api/system` router.
 */
export function mountShellCheckRoutes(router: Hono<ApiEnv>): void {
  router.get('/shell-check', (c) => c.json(shellCheckStatus() satisfies ShellCheckStatus));

  router.post('/shell-check/continue', (c) => {
    const refused = refusedNotAPerson(c, COPY);
    if (refused) return refused;
    if (classifyRequest(honoRequestFacts(c), currentServerRole()).kind !== 'this-computer') {
      return c.json(errorBody('Do this at the computer running DorkOS.', 'local_only'), 403);
    }
    if (!continueWithoutCheck()) {
      return c.json(
        errorBody('The check isn’t down, or a restart hasn’t been tried.', 'conflict'),
        409
      );
    }
    recordAudit({
      action: 'shell-check.continue-without',
      operation: 'modify',
      outcome: 'ok',
      target: { type: 'shell-check', id: 'shell-check' },
      summary:
        'Chose to run shell commands at Full without the protected-files check, until restart',
      source: { surface: 'app' },
    });
    return c.json(shellCheckStatus() satisfies ShellCheckStatus);
  });
}
