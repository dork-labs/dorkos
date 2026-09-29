/**
 * Whether the Claude account a schedule names may work in the folder its runs
 * start in (spec `flow-multiproject` §8.4, the three schedule rows).
 *
 * - **A save that names such an account is refused**, whoever saves it: a
 *   person's own pick is held to the rule too (spec D7), and an agent never
 *   gets to put work on an account the person kept elsewhere.
 * - **A run fails with the plain sentence** before either dispatch path starts
 *   anything, so the direct and relay paths say the same thing.
 *
 * At save time the folder is the owning agent's (or the server's working
 * directory); at run time it is the run's own placement
 * (`TaskSchedulerService.resolveRunPlacement`).
 *
 * @module services/tasks/lifecycle/schedule-account-eligibility
 */
import { configManager } from '../../core/config-manager.js';
import {
  accountEligibility,
  projectOfFolder,
  refusalFor,
  type AccountNotAllowedError,
} from '../../core/usage/account-eligibility.js';

/**
 * The folder a schedule's runs start in, as far as its project goes: the
 * owning agent's folder, or the server's working directory for a schedule
 * that belongs to no agent. Deliberately not the session-cwd chain: that runs
 * once, where a turn begins (the scheduler passes the run's own placement),
 * and an agent's desk is a worktree of the same repository, so the project is
 * the same.
 *
 * @param agentProjectPath - The owning agent's folder, or null for a schedule with no agent.
 */
export function scheduleRunFolder(agentProjectPath: string | null | undefined): string {
  return agentProjectPath || process.cwd();
}

/**
 * The refusal for a schedule's account in the folder its runs start in, or
 * null when it may work there (or the schedule names no Claude account).
 *
 * @param opts - What the schedule names.
 * @param opts.account - The account id, if any.
 * @param opts.runtime - The runtime it names, if any; only Claude Code has account rules.
 * @param opts.folder - The folder its runs start in ({@link scheduleRunFolder}).
 */
export async function scheduleAccountRefusal(opts: {
  account: string | null | undefined;
  runtime?: string | null | undefined;
  folder: string;
}): Promise<AccountNotAllowedError | null> {
  if (!opts.account) return null;
  if (opts.runtime && opts.runtime !== 'claude-code') return null;
  const project = await projectOfFolder(opts.folder);
  const verdict = accountEligibility(configManager, 'claude-code', opts.account, project);
  return verdict.eligible ? null : refusalFor(configManager, opts.account, project, verdict);
}
