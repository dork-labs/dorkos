/**
 * `PUT /api/runtimes/claude-code/accounts/:id/agents-may-pick`: let agents start
 * chats on one registered Claude account by naming it, or refuse them
 * (DOR-5033). Core's own account rule reads the flag while no mini app such as
 * Flow decides which accounts agents may use (`checkAccountLaunch` in
 * `account-ranking.ts`); an account is closed to agents' own picks until a
 * person opens it here.
 *
 * **Only a person writes.** The route sits behind the person bar
 * (`assessPerson`), with the residuals every person-bar route has (see
 * `runtimes-account-eligibility.ts`). Opening an account to agents widens what
 * they may spend, so it waits for the owner to confirm it's them (DOR-4355);
 * closing it stays immediate. Each change records an Activity entry naming who
 * made it. Main (`default`) has no registry row, so it answers `404`: an agent
 * never picks the main sign-in.
 *
 * @module routes/runtimes-account-agents-may-pick
 */
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { readClaudeAccountSettings } from '@dorkos/shared/config-schema';
import { AgentsMayPickSchema } from '@dorkos/shared/project-schemas';
import { readJsonBody } from '@dorkos/http-kit';
import { logger } from '../lib/logger.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { configManager } from '../services/core/config-manager.js';
import { logConfigWrite } from '../services/core/operator/config-write.js';
import { accountDisplayName } from '../services/core/usage/account-eligibility.js';
import { writeAgentsMayPick } from '../services/core/usage/account-eligibility-writes.js';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { assessPerson } from './extensions-person-bar.js';
import {
  AGENTS_MAY_PICK_BAR,
  AGENTS_MAY_PICK_FAILED,
  accountRulesChanged,
  holdAccountWidening,
} from './account-eligibility-hold.js';

/** The account's stored flag: `true` or `false` for a registry row, `'gone'` for none. */
function storedFlag(accountId: string): boolean | 'gone' {
  const runtimes = configManager.get('runtimes') as { claudeCode?: unknown } | undefined;
  const row = readClaudeAccountSettings(runtimes?.claudeCode).accounts.find(
    (a) => a.id === accountId
  );
  return row === undefined ? 'gone' : row.agentsMayPick === true;
}

/**
 * Mount the agents-may-pick route on the runtimes router.
 *
 * @param router - The `/api/runtimes` route group.
 * @param activity - Where each change is recorded, when the server has one.
 */
export function mountAgentsMayPickRoute(
  router: Hono<ApiEnv>,
  activity: ActivityService | undefined
): void {
  router.put('/claude-code/accounts/:id/agents-may-pick', async (c) => {
    const caller = honoRequestFacts(c);
    const refusal = assessPerson(caller, AGENTS_MAY_PICK_BAR);
    if (refusal) return c.json(refusal.body, refusal.status as ContentfulStatusCode);
    const parsed = AgentsMayPickSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) {
      return c.json(
        { error: 'Send `agentsMayPick` as true or false.', details: z.treeifyError(parsed.error) },
        400
      );
    }
    const accountId = c.req.param('id');
    const unknownAccount = {
      error: `There is no Claude account named "${accountId}".`,
      code: 'unknown_account',
    };
    if (storedFlag(accountId) === 'gone') return c.json(unknownAccount, 404);
    const { agentsMayPick } = parsed.data;
    const run = async (who: RequestFacts, free = false) => {
      // Read again: a confirmation can come after the flag moved.
      const prior = storedFlag(accountId);
      if (prior === 'gone') return c.json(unknownAccount, 404);
      // Opening was free only while it was already open (Security S5 on DOR-4355 M3).
      if (free && agentsMayPick && !prior) return accountRulesChanged(c);
      const stored = configManager.get('runtimes');
      if (!writeAgentsMayPick(configManager, accountId, agentsMayPick)) {
        return c.json(unknownAccount, 404);
      }
      logConfigWrite(
        'the agents-may-pick route',
        'runtimes',
        stored,
        configManager.get('runtimes')
      );
      if (prior !== agentsMayPick) {
        const name = accountDisplayName(configManager, accountId);
        await activity?.emit({
          ...readActivityActor(who),
          category: 'config',
          eventType: 'config.accounts_updated',
          resourceType: 'account',
          resourceId: accountId,
          resourceLabel: name,
          summary: agentsMayPick
            ? `Agents may now pick ${name} by name`
            : `Agents may no longer pick ${name} by name`,
          linkPath: '/?settings=runtimes',
          metadata: { account: accountId, agentsMayPick },
        });
      }
      return c.json({ agentsMayPick });
    };
    try {
      if (!agentsMayPick || storedFlag(accountId) === true) return await run(caller, true);
      return await holdAccountWidening(c, {
        target: `claude-account:${accountId}`,
        input: { account: accountId, agentsMayPick },
        reason: `Let agents pick ${accountDisplayName(configManager, accountId)} by name.`,
        failure: AGENTS_MAY_PICK_FAILED,
        run,
      });
    } catch (err) {
      logger.error('[Runtimes] could not save an account agents-may-pick flag', {
        err: String(err),
      });
      return c.json({ error: AGENTS_MAY_PICK_FAILED }, 500);
    }
  });
}
