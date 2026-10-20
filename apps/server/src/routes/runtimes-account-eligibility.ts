/**
 * Which Claude accounts may work in which projects: the three routes Settings
 * and the flow extension's settings use (spec `flow-multiproject` §8.6).
 *
 * - `GET /api/runtimes/claude-code/account-eligibility?project=<folder>` —
 *   every account as the folder's project sees it. Any caller may read it,
 *   so it records nothing: a folder the registry does not know is named the
 *   way the registry would name it, and no `known_projects` row is written.
 * - `PUT /api/runtimes/claude-code/project-accounts` — set or remove one
 *   project's allow list.
 * - `PUT /api/runtimes/claude-code/accounts/:id/only-projects` — keep one
 *   account (Main is `default`) to a list of projects, or free it.
 * - `PUT /api/runtimes/claude-code/accounts/:id/no-auto-move` — keep room
 *   agents off one registered account when DorkOS moves them on its own, or
 *   let them back (Re-seat P0). Recorded as a permission-history line with an
 *   Undo, the way the upgrade that sets it is (`kept-from-auto-moves.ts`).
 * - `POST /api/runtimes/claude-code/project-accounts/without-credits` — keep
 *   DorkOS credits out of the project a session's folder is in: the "Don't use
 *   credits in this project" answer on a refused credits turn (ADR
 *   261001-000811). A project rule, so Settings shows it and can undo it.
 *
 * **Only a person writes.** Every write sits behind the person bar
 * (`assessPerson`), and no extension `ctx` member writes these rules, so
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
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { IMPLICIT_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { KEPT_FROM_AUTO_MOVES } from '@dorkos/shared/permissions';
import {
  AccountEligibilityQuerySchema,
  NoAutoMoveSchema,
  OnlyProjectsRequestSchema,
  ProjectAccountsRequestSchema,
  ProjectWithoutCreditsRequestSchema,
  type AccountEligibilityResponse,
  type AccountEligibilityRow,
  type ProjectRef,
} from '@dorkos/shared/project-schemas';
import { BoundaryError, validateBoundary } from '../lib/boundary.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import { logger } from '../lib/logger.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import { configManager } from '../services/core/config-manager.js';
import { logConfigWrite } from '../services/core/operator/config-write.js';
import { resolveDecisionAuthority } from '../services/core/approvals/index.js';
import { recordPermissionChange } from '../services/core/permissions/index.js';
import { configAutoMoveFlagPort } from '../services/core/permissions/kept-from-auto-moves.js';
import { getAccountUsageStore } from '../services/core/usage/current-usage-store.js';
import {
  accountDisplayName,
  joinNames,
  NOT_USED_IN_ANY_PROJECT,
  onlyProjectsOf,
  projectRefFor,
  readEligibilityRules,
  judgeEligibility,
} from '../services/core/usage/account-eligibility.js';
import {
  writeNoAutoMove,
  writeOnlyProjects,
  writeProjectAccounts,
} from '../services/core/usage/account-eligibility-writes.js';
import {
  describeClaudeCodeAccounts,
  resolveLaunchAccountRoot,
} from '../services/runtimes/claude-code/claude-config-dir.js';
import { checkClaudeLaunchAccount } from '../services/runtimes/claude-code/launch-account-check.js';
import { projectRegistry } from '../services/projects/project-registry.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { assessPerson, type PersonBarCopy } from './extensions-person-bar.js';
import { writerForPosture } from './permissions.js';

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

/** The refusal for a folder outside the directory boundary. */
const OUTSIDE_BOUNDARY = {
  error: 'That folder is outside the folders DorkOS may open.',
  code: 'OUTSIDE_BOUNDARY',
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

/**
 * The project of a folder an ungated reader named, recording nothing: the
 * registry's name when it knows the root, else the name it would give. For
 * `GET` routes any caller may reach, where recording would let an agent hold
 * names (DOR-2547).
 */
async function peekProjectOfNamedFolder(folder: string): Promise<ProjectRef | null | 'outside'> {
  try {
    const root = await projectRegistry.rootWithin(await validateBoundary(folder));
    return root === null || root === 'outside' ? root : projectRefFor(root);
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

/**
 * The person bar's 403 (or the cookie bar's) for anything but a person, or
 * `undefined` when a person is asking.
 */
function refuseIfNotAPerson(c: Context<ApiEnv>, caller: RequestFacts): Response | undefined {
  const refusal = assessPerson(caller, ACCOUNT_RULES_BAR);
  return refusal ? c.json(refusal.body, refusal.status as ContentfulStatusCode) : undefined;
}

/**
 * The folder a session works in: the live binding's own, else the folder its
 * agent was recorded in. Null for a session the server does not know.
 */
async function folderOfSession(sessionId: string): Promise<string | null> {
  const runtime = await runtimeRegistry.resolveForSession(sessionId);
  const live = runtime.getSessionCwd?.(runtime.getInternalSessionId(sessionId) ?? sessionId);
  return live ?? (await runtimeRegistry.getSessionAgentPath(sessionId));
}

/**
 * Mount the account-rule routes onto the runtimes routes.
 *
 * @param router - The `/api/runtimes` routes.
 * @param activity - Where each change is recorded; absent in a test that does not watch it.
 */
export function mountAccountEligibilityRoutes(
  router: Hono<ApiEnv>,
  activity: ActivityService | undefined
): void {
  router.get('/claude-code/account-eligibility', async (c) => {
    const parsed = AccountEligibilityQuerySchema.safeParse(readQuery(c));
    if (!parsed.success) {
      return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      const project = parsed.data.project
        ? await peekProjectOfNamedFolder(parsed.data.project)
        : null;
      if (project === 'outside') return c.json(OUTSIDE_BOUNDARY, 403);
      return c.json({
        ...eligibilityFor(project),
        launch: await launchFor(parsed.data.project, project),
      });
    } catch (err) {
      logger.error('[Runtimes] could not read account eligibility', { err: String(err) });
      return c.json({ error: 'Could not read which accounts may work here.' }, 500);
    }
  });

  router.put('/claude-code/project-accounts', async (c) => {
    const caller = honoRequestFacts(c);
    const refused = refuseIfNotAPerson(c, caller);
    if (refused) return refused;
    const parsed = ProjectAccountsRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) {
      return c.json(
        {
          error: 'Send the project folder as `project` and the account ids as `allow` (or null).',
          details: z.treeifyError(parsed.error),
        },
        400
      );
    }
    try {
      const project = await projectOfNamedFolder(parsed.data.project);
      if (project === 'outside') return c.json(OUTSIDE_BOUNDARY, 403);
      if (project === null) {
        return c.json(
          {
            error: `${parsed.data.project} isn't in a project (a git repository), so it has no account list.`,
            code: 'not_a_project',
          },
          404
        );
      }
      const { allow } = parsed.data;
      if (allow !== null) {
        const known = knownAccountIds();
        const unknown = allow.filter((id) => !known.has(id));
        if (unknown.length > 0) {
          return c.json(
            {
              error: `There is no Claude account named ${joinNames(unknown.map((id) => `"${id}"`))}.`,
              code: 'unknown_account',
            },
            400
          );
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
      await activity?.emit({
        ...readActivityActor(caller),
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
      return c.json(eligibilityFor(project));
    } catch (err) {
      logger.error('[Runtimes] could not save a project account list', { err: String(err) });
      return c.json({ error: 'Could not save which accounts this project may use.' }, 500);
    }
  });

  router.post('/claude-code/project-accounts/without-credits', async (c) => {
    const caller = honoRequestFacts(c);
    const refused = refuseIfNotAPerson(c, caller);
    if (refused) return refused;
    const parsed = ProjectWithoutCreditsRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) {
      return c.json(
        { error: 'Send the session as `sessionId`.', details: z.treeifyError(parsed.error) },
        400
      );
    }
    try {
      const folder = await folderOfSession(parsed.data.sessionId);
      if (folder === null) {
        return c.json(
          { error: 'DorkOS couldn’t find that chat’s folder.', code: 'unknown_session' },
          404
        );
      }
      const project = await projectOfNamedFolder(folder);
      if (project === 'outside') return c.json(OUTSIDE_BOUNDARY, 403);
      if (project === null) {
        return c.json(
          {
            error:
              'This folder isn’t in a project (a git repository), so there is no project to ' +
              'keep credits out of. Use your own sign-in for this chat instead.',
            code: 'not_a_project',
          },
          409
        );
      }
      // The project's own list, or every account it may use today: credits is
      // never a listed account, so either list leaves it out, and nothing that
      // worked here before stops working.
      const rules = readEligibilityRules(configManager.get('runtimes')?.claudeCode);
      const allow = [
        ...(rules.projectAllow.get(project.root) ?? listedAccounts().map((a) => a.id)),
      ];
      const before = configManager.get('runtimes');
      writeProjectAccounts(configManager, project.root, allow);
      logConfigWrite(
        'the project-without-credits route',
        'runtimes',
        before,
        configManager.get('runtimes')
      );
      await activity?.emit({
        ...readActivityActor(caller),
        category: 'config',
        eventType: 'config.accounts_updated',
        resourceType: 'project',
        resourceId: project.root,
        resourceLabel: project.name,
        summary: `${project.name} no longer uses DorkOS credits`,
        linkPath: '/?settings=runtimes',
        metadata: { project: project.root, allow },
      });
      return c.json({ ...eligibilityFor(project), launch: await launchFor(folder, project) });
    } catch (err) {
      logger.error('[Runtimes] could not keep credits out of a project', { err: String(err) });
      return c.json({ error: 'Could not save which accounts this project may use.' }, 500);
    }
  });

  router.put('/claude-code/accounts/:id/only-projects', async (c) => {
    const caller = honoRequestFacts(c);
    const refused = refuseIfNotAPerson(c, caller);
    if (refused) return refused;
    const parsed = OnlyProjectsRequestSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) {
      return c.json(
        {
          error: 'Send the project folders as `projects` (or null for any project).',
          details: z.treeifyError(parsed.error),
        },
        400
      );
    }
    const accountId = c.req.param('id');
    const unknownAccount = {
      error: `There is no Claude account named "${accountId}".`,
      code: 'unknown_account',
    };
    if (!knownAccountIds().has(accountId)) return c.json(unknownAccount, 404);
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
            return c.json(
              {
                error: `${folder} isn't a project DorkOS can use (a git repository inside the folders it may open).`,
                code: 'not_a_project',
              },
              400
            );
          }
          roots.push(project.root);
        }
      }
      const before = configManager.get('runtimes');
      if (!writeOnlyProjects(configManager, accountId, roots)) return c.json(unknownAccount, 404);
      logConfigWrite('the only-projects route', 'runtimes', before, configManager.get('runtimes'));
      const onlyProjects = onlyProjectsOf(configManager, accountId);
      const name = accountDisplayName(configManager, accountId);
      await activity?.emit({
        ...readActivityActor(caller),
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
      return c.json({ onlyProjects });
    } catch (err) {
      logger.error('[Runtimes] could not save an account project list', { err: String(err) });
      return c.json({ error: 'Could not save which projects this account may use.' }, 500);
    }
  });

  router.put('/claude-code/accounts/:id/no-auto-move', async (c) => {
    const caller = honoRequestFacts(c);
    const refused = refuseIfNotAPerson(c, caller);
    if (refused) return refused;
    const parsed = NoAutoMoveSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!parsed.success) {
      return c.json(
        { error: 'Send `noAutoMove` as true or false.', details: z.treeifyError(parsed.error) },
        400
      );
    }
    const accountId = c.req.param('id');
    const unknownAccount = {
      error: `There is no Claude account named "${accountId}".`,
      code: 'unknown_account',
    };
    // Only a registered row carries the flag: Main with no row of its own is
    // not one, so it answers like an account that does not exist.
    const before = configAutoMoveFlagPort(configManager).flagOf(accountId);
    if (before === 'gone') return c.json(unknownAccount, 404);
    try {
      const { noAutoMove } = parsed.data;
      const stored = configManager.get('runtimes');
      if (!writeNoAutoMove(configManager, accountId, noAutoMove)) {
        return c.json(unknownAccount, 404);
      }
      logConfigWrite('the no-auto-move route', 'runtimes', stored, configManager.get('runtimes'));
      const after = noAutoMove ? KEPT_FROM_AUTO_MOVES : null;
      if (after !== before) {
        // The person bar passed, so this is a person: the history names them
        // the way every permission write does, and its Undo flips the flag back.
        const authority = resolveDecisionAuthority(readCallerAuthority(caller));
        await recordPermissionChange(activity, {
          changes: [
            {
              target: { kind: 'default' },
              key: {
                kind: 'account',
                accountId,
                accountName: accountDisplayName(configManager, accountId),
              },
              before,
              after,
            },
          ],
          surface: 'settings',
          writer: writerForPosture(
            authority.allowed ? authority.posture : 'local-trust',
            caller.user
          ),
        });
      }
      return c.json({ noAutoMove });
    } catch (err) {
      logger.error('[Runtimes] could not save an account automatic-move flag', {
        err: String(err),
      });
      return c.json({ error: 'Could not save whether agents move to this account.' }, 500);
    }
  });
}
