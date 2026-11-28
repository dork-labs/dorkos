/**
 * The person's choice to go on without DorkOS's check on agents' shell commands until restart
 * (DOR-3300). What the app reads about the check is `system.shell_check`, a capability the mount
 * serves (`services/core/runtime-doors/computer-read-capabilities.ts`, DOR-4978).
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
import { problem } from '@dorkos/http-kit';
import { currentServerRole } from '../lib/server-role.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import {
  continueWithoutCheck,
  shellCheckStatus,
} from '../services/runtimes/claude-code/shell-guard/guard-service.js';
import { refusedNotAPerson } from './extensions-person-bar.js';
import type { PersonBarCopy } from '../lib/http/person-bar.js';

const COPY: PersonBarCopy = {
  code: 'person_only',
  subject: 'this check',
  agent: 'An agent can’t turn this check off. Ask a person to do it in the DorkOS app.',
};

/**
 * Mount the routes.
 *
 * @param router - The `/api/system` router.
 */
export function mountShellCheckRoutes(router: Hono<ApiEnv>): void {
  router.post('/shell-check/continue', (c) => {
    const refused = refusedNotAPerson(c, COPY);
    if (refused) return refused;
    if (classifyRequest(honoRequestFacts(c), currentServerRole()).kind !== 'this-computer') {
      return problem(c, 'operator_only', { detail: 'Do this at the computer running DorkOS.' });
    }
    if (!continueWithoutCheck()) {
      return problem(c, 'conflict', {
        detail: 'The check isn’t down, or a restart hasn’t been tried.',
      });
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
