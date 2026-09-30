/**
 * Which Claude accounts may work in which projects: the three routes Settings
 * and the flow extension's settings use (spec `flow-multiproject` §8.6).
 *
 * - `GET /api/runtimes/claude-code/account-eligibility?project=<folder>` —
 *   every account as the folder's project sees it. Any caller may read it.
 * - `PUT /api/runtimes/claude-code/project-accounts` — set or remove one
 *   project's allow list.
 * - `PUT /api/runtimes/claude-code/accounts/:id/only-projects` — keep one
 *   account (Main is `default`) to a list of projects, or free it.
 *
 * **Only a person writes.** Both `PUT`s sit behind the person bar
 * (`refuseIfNotAPerson`), and no extension `ctx` member writes these rules, so
 * an extension's server half and any agent cannot widen where an account may
 * be used (invariant 9). The bar's residuals are the ones every person-bar
 * route has: with Require login off, a local caller that omits its
 * `X-DorkOS-Agent` header passes, and an approved extension's own browser code
 * shares the app's page and so passes in either posture. Each write records an
 * Activity entry naming who changed what.
 *
 * Every write goes through `account-eligibility-writes.ts`, which rewrites the
 * whole `runtimes.claudeCode` block: project roots contain dots, and a dotted
 * config key path would split them.
 *
 * @module routes/runtimes-account-eligibility
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import {
  AccountEligibilityQuerySchema,
  OnlyProjectsRequestSchema,
  ProjectAccountsRequestSchema,
  type AccountEligibilityResponse,
  type AccountEligibilityRow,
  type ProjectRef,
} from '@dorkos/shared/project-schemas';
import { BoundaryError, validateBoundary } from '../lib/boundary.js';
import { logger } from '../lib/logger.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { configManager } from '../services/core/config-manager.js';
import { logConfigWrite } from '../services/core/operator/config-write.js';
import { getAccountUsageStore } from '../services/core/usage/current-usage-store.js';
import {
  accountDisplayName,
  joinNames,
  NOT_USED_IN_ANY_PROJECT,
  onlyProjectsOf,
  readEligibilityRules,
  judgeEligibility,
} from '../services/core/usage/account-eligibility.js';
import {
  writeOnlyProjects,
  writeProjectAccounts,
} from '../services/core/usage/account-eligibility-writes.js';
import {
  describeClaudeCodeAccounts,
  resolveLaunchAccountRoot,
} from '../services/runtimes/claude-code/claude-config-dir.js';
import { checkClaudeLaunchAccount } from '../services/runtimes/claude-code/launch-account-check.js';
import { projectRegistry } from '../services/projects/project-registry.js';
import { refuseIfNotAPerson, type PersonBarCopy } from './extensions-person-bar.js';

/** What the person bar says when anything but a person tries to change a rule. */
const ACCOUNT_RULES_BAR: PersonBarCopy = {
  error: 'Only a person can change where an account may be used.',
  code: 'operator_only_config',
  subject: 'where each Claude account may be used',
  crossSite: (origin) =>
    `DorkOS changed nothing. This request came from ${origin}, which is not DorkOS. ` +
    `Which projects an account may work in is something a person sets in their own copy ` +
    `of the app, not something another site can change for them.`,
  agent:
    'DorkOS changed nothing. Which projects a Claude account may work in is a decision ' +
    'only a person makes. Ask them to change it in Settings → Runtimes.',
};

/**
 * The project a folder a person named belongs to: `'outside'` when the folder
 * (or its repository) is outside the directory boundary, null when it is in
 * no repository.
 */
async function projectOfNamedFolder(folder: string): Promise<ProjectRef | null | 'outside'> {
  try {
    return await projectRegistry.resolveWithin(await validateBoundary(folder));
  } catch (err) {
    if (err instanceof BoundaryError) return 'outside';
    throw err;
  }
}

/** The Claude accounts to list: registry order, Main last when it has no row. */
function listedAccounts(): {
  id: string;
  label: string | null;
  color: string;
  implicit: boolean;
}[] {
  const store = getAccountUsageStore();
  if (store) {
    return store
      .listAccounts('claude-code')
      .filter((account) => account.routable)
      .map(({ id, label, color, implicit }) => ({ id, label, color, implicit }));
  }
  // No usage store yet (early boot, a test): the registry rows and Main.
  const described = describeClaudeCodeAccounts();
  const rows = described.accounts
    .filter((row): row is typeof row & { id: string } => typeof row.id === 'string')
    .map((row) => ({ id: row.id, label: row.label, color: row.color, implicit: false }));
  return [
    ...rows,
    {
      id: IMPLICIT_ACCOUNT_ID,
      label: accountDisplayName(configManager, IMPLICIT_ACCOUNT_ID),
      color: described.defaultAccountResolvedColor ?? '#6b7280',
      implicit: true,
    },
  ];
}

/**
 * Every Claude account as a project's rules see it.
 *
 * @param project - The project, or null for a folder in no project.
 */
export function eligibilityFor(project: ProjectRef | null): AccountEligibilityResponse {
  const rules = readEligibilityRules(configManager.get('runtimes')?.claudeCode);
  const root = project?.root ?? null;
  const allow = root === null ? null : (rules.projectAllow.get(root) ?? null);
  const accounts: AccountEligibilityRow[] = listedAccounts().map((account) => {
    const verdict = judgeEligibility(rules, account.id, root);
    const allowedByProject = allow === null || allow.includes(account.id);
    const allowedByAccount = !(verdict.eligible === false && verdict.reason === 'only-projects');
    return {
      ...account,
      onlyProjects: onlyProjectsOf(configManager, account.id),
      allowedByAccount,
      allowedByProject,
      eligible: verdict.eligible,
    };
  });
  return { project, allow: allow === null ? null : [...allow], accounts };
}

/**
 * What a new chat in `folder` would run on with no account picked: the launch
 * ladder's own answer, with the folder's agent's account, the default and the
 * account rules all applied, or the sentence it would be refused with.
 *
 * @param folder - The folder the chat runs in, or undefined for none.
 * @param project - Its project, already resolved (null for none).
 */
async function launchFor(
  folder: string | undefined,
  project: ProjectRef | null
): Promise<AccountEligibilityResponse['launch']> {
  const launch = folder
    ? await checkClaudeLaunchAccount({ cwd: folder, project })
    : resolveLaunchAccountRoot({ project });
  return launch.ok
    ? { ok: true, accountId: launch.accountId, root: launch.root }
    : { ok: false, message: launch.error.message };
}

/** The Claude account ids a rule may name: every routable row, and Main. */
function knownAccountIds(): Set<string> {
  return new Set([...listedAccounts().map((a) => a.id), IMPLICIT_ACCOUNT_ID]);
}

function activityOf(req: Request): ActivityService | undefined {
  return req.app.locals.activityService as ActivityService | undefined;
}

/**
 * Mount the three routes onto the runtimes router.
 *
 * @param router - The `/api/runtimes` router.
 */
export function mountAccountEligibilityRoutes(router: Router): void {
  router.get('/claude-code/account-eligibility', async (req: Request, res: Response) => {
    const parsed = AccountEligibilityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid query', details: z.treeifyError(parsed.error) });
    }
    try {
      const project = parsed.data.project ? await projectOfNamedFolder(parsed.data.project) : null;
      if (project === 'outside') {
        return res.status(403).json({
          error: 'That folder is outside the folders DorkOS may open.',
          code: 'OUTSIDE_BOUNDARY',
        });
      }
      return res.json({
        ...eligibilityFor(project),
        launch: await launchFor(parsed.data.project, project),
      });
    } catch (err) {
      logger.error('[Runtimes] could not read account eligibility', { err: String(err) });
      return res.status(500).json({ error: 'Could not read which accounts may work here.' });
    }
  });

  router.put('/claude-code/project-accounts', async (req: Request, res: Response) => {
    if (refuseIfNotAPerson(req, res, ACCOUNT_RULES_BAR)) return;
    const parsed = ProjectAccountsRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Send the project folder as `project` and the account ids as `allow` (or null).',
        details: z.treeifyError(parsed.error),
      });
    }
    try {
      const project = await projectOfNamedFolder(parsed.data.project);
      if (project === 'outside') {
        return res.status(403).json({
          error: 'That folder is outside the folders DorkOS may open.',
          code: 'OUTSIDE_BOUNDARY',
        });
      }
      if (project === null) {
        return res.status(404).json({
          error: `${parsed.data.project} isn't in a project (a git repository), so it has no account list.`,
          code: 'not_a_project',
        });
      }
      const { allow } = parsed.data;
      if (allow !== null) {
        const known = knownAccountIds();
        const unknown = allow.filter((id) => !known.has(id));
        if (unknown.length > 0) {
          return res.status(400).json({
            error: `There is no Claude account named ${joinNames(unknown.map((id) => `"${id}"`))}.`,
            code: 'unknown_account',
          });
        }
      }
      const before = configManager.get('runtimes');
      writeProjectAccounts(configManager, project.root, allow);
      logConfigWrite(
        'the project-accounts route',
        'runtimes',
        before,
        configManager.get('runtimes')
      );
      const names = allow?.map((id) => accountDisplayName(configManager, id)) ?? [];
      await activityOf(req)?.emit({
        ...readActivityActor(req, res),
        category: 'config',
        eventType: 'config.accounts_updated',
        resourceType: 'project',
        resourceId: project.root,
        resourceLabel: project.name,
        summary:
          allow === null
            ? `${project.name} may use every account again`
            : names.length === 0
              ? `${project.name} may use no account`
              : `${project.name} may use only ${joinNames(names)}`,
        linkPath: '/?settings=runtimes',
        metadata: { project: project.root, allow },
      });
      return res.json(eligibilityFor(project));
    } catch (err) {
      logger.error('[Runtimes] could not save a project account list', { err: String(err) });
      return res.status(500).json({ error: 'Could not save which accounts this project may use.' });
    }
  });

  router.put('/claude-code/accounts/:id/only-projects', async (req: Request, res: Response) => {
    if (refuseIfNotAPerson(req, res, ACCOUNT_RULES_BAR)) return;
    const parsed = OnlyProjectsRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Send the project folders as `projects` (or null for any project).',
        details: z.treeifyError(parsed.error),
      });
    }
    const accountId = String(req.params.id);
    if (!knownAccountIds().has(accountId)) {
      return res.status(404).json({
        error: `There is no Claude account named "${accountId}".`,
        code: 'unknown_account',
      });
    }
    try {
      let roots: string[] | null = null;
      if (parsed.data.projects !== null) {
        roots = [];
        // A project the rule already names is kept as it is, even when its
        // folder is gone right now (a drive may be unplugged): saving the
        // dialog must never drop it, or refuse the whole save over it.
        const kept = new Set((onlyProjectsOf(configManager, accountId) ?? []).map((p) => p.root));
        for (const folder of parsed.data.projects) {
          if (kept.has(folder)) {
            roots.push(folder);
            continue;
          }
          const project = await projectOfNamedFolder(folder);
          if (project === 'outside' || project === null) {
            return res.status(400).json({
              error: `${folder} isn't a project DorkOS can use (a git repository inside the folders it may open).`,
              code: 'not_a_project',
            });
          }
          roots.push(project.root);
        }
      }
      const before = configManager.get('runtimes');
      if (!writeOnlyProjects(configManager, accountId, roots)) {
        return res.status(404).json({
          error: `There is no Claude account named "${accountId}".`,
          code: 'unknown_account',
        });
      }
      logConfigWrite('the only-projects route', 'runtimes', before, configManager.get('runtimes'));
      const onlyProjects = onlyProjectsOf(configManager, accountId);
      const name = accountDisplayName(configManager, accountId);
      await activityOf(req)?.emit({
        ...readActivityActor(req, res),
        category: 'config',
        eventType: 'config.accounts_updated',
        resourceType: 'account',
        resourceId: accountId,
        resourceLabel: name,
        summary:
          onlyProjects === null
            ? `${name} may work in any project again`
            : onlyProjects.length === 0
              ? `${name} is now ${NOT_USED_IN_ANY_PROJECT.toLowerCase()}`
              : `${name} is now only for ${joinNames(onlyProjects.map((p) => p.name))}`,
        linkPath: '/?settings=runtimes',
        metadata: { account: accountId, onlyProjects: roots },
      });
      return res.json({ onlyProjects });
    } catch (err) {
      logger.error('[Runtimes] could not save an account project list', { err: String(err) });
      return res.status(500).json({ error: 'Could not save which projects this account may use.' });
    }
  });
}
