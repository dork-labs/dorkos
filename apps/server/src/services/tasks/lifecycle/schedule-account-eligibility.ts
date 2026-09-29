/**
 * Whether the Claude account a schedule names may work in the folder its runs
 * start in (spec `flow-multiproject` §8.4, the three schedule rows).
 *
 * - **An agent's proposal is refused** when it names such an account: an
 *   agent never gets to put work on an account the person kept elsewhere.
 * - **A person's own save is kept, and warned about** in the Activity feed: the
 *   rule still holds at run time, so the save is harmless, and saying so now
 *   beats a failed run later.
 * - **A run fails with the plain sentence** before either dispatch path starts
 *   anything, so the direct and relay paths say the same thing.
 *
 * The folder is the one a run actually starts in: the agent's folder through
 * the session-cwd chain, or the server's working directory for a schedule
 * that belongs to no agent (`TaskSchedulerService.resolveRunPlacement`).
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
import { resolveSessionCwd } from '../../workspace/resolve-session-cwd.js';

/**
 * The folder a schedule's runs start in.
 *
 * @param agentProjectPath - The owning agent's folder, or null for a schedule with no agent.
 */
export async function scheduleRunFolder(
  agentProjectPath: string | null | undefined
): Promise<string> {
  if (!agentProjectPath) return process.cwd();
  try {
    return (await resolveSessionCwd({ agentPath: agentProjectPath })).cwd;
  } catch {
    return agentProjectPath;
  }
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
