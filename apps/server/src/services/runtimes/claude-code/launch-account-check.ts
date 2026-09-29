/**
 * The launch ladder's answer for a Claude Code session that has not started
 * yet, asked BEFORE anything is started, so a launch whose account may not
 * work in the folder's project is refused up front (spec `flow-multiproject`
 * §8.4) instead of starting and then failing its first turn.
 *
 * The same inputs the turn's own launch uses (`messaging/launch-resolver.ts`):
 * the person's pick, the account the folder's agent is pinned to, then the
 * defaults. The turn still runs the ladder itself, which stays the authority;
 * this is the early, honest "no".
 *
 * @module services/runtimes/claude-code/launch-account-check
 */
import type { ProjectRef } from '@dorkos/shared/project-schemas';
import { homeOf, readHomeManifest, resolveAgentHome } from '../../core/agent-identity/index.js';
import { projectOfFolder } from '../../core/usage/account-eligibility.js';
import { resolveLaunchAccountRoot, type LaunchAccountResolution } from './claude-config-dir.js';

/**
 * Where a new Claude Code session in `cwd` would run and bill, or why it may not.
 *
 * @param opts - The folder the session runs in, and the person's pick if any.
 * @param opts.cwd - The folder the session runs in.
 * @param opts.hintId - The account the person picked for this session, if any.
 * @param opts.project - The folder's project when the caller already resolved
 *   it (null for none); resolved here when omitted.
 */
export async function checkClaudeLaunchAccount(opts: {
  cwd: string;
  hintId?: string | undefined;
  project?: ProjectRef | null;
}): Promise<LaunchAccountResolution> {
  const home = homeOf(resolveAgentHome(opts.cwd));
  const manifest = home ? await readHomeManifest(home).catch(() => null) : null;
  return resolveLaunchAccountRoot({
    hintId: opts.hintId,
    agentAccountId: manifest?.account,
    project: opts.project !== undefined ? opts.project : await projectOfFolder(opts.cwd),
  });
}
